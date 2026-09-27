/**
 * 简单定时任务调度器
 * - 存储：~/.pi-gateway/cron-jobs.json
 * - 格式兼容 crontab（5 字段：分 时 日 月 周）
 * - 执行结果发回给发起任务的微信用户
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";
import { logger } from "../logger/index.js";

export interface CronJob {
  id: string;
  /** crontab 表达式（5 字段：分 时 日 月 周） */
  schedule: string;
  /** 执行的 prompt */
  prompt: string;
  /** 发起任务的微信用户 ID */
  userId: string;
  /** 上下文 token（用于回复消息） */
  contextToken?: string;
  /** 下次执行时间（毫秒时间戳） */
  nextRunAt?: number;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 最后执行时间 */
  lastRunAt?: number;
  /** 最后执行结果 */
  lastResult?: string;
}

const JOBS_FILE = join(STATE_DIR, "cron-jobs.json");
const TICK_INTERVAL_MS = 30_000; // 每 30 秒检查一次

let jobs: CronJob[] = [];
let tickTimer: NodeJS.Timeout | null = null;

/** 加载定时任务列表 */
export function loadJobs(): CronJob[] {
  if (!existsSync(JOBS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(JOBS_FILE, "utf8")) as CronJob[];
    return data.filter((j) => j.enabled);
  } catch {
    return [];
  }
}

/** 保存定时任务列表 */
function saveJobs(): void {
  try {
    writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), "utf8");
  } catch (err) {
    logger.warn(`[cron] 保存任务列表失败: ${String(err)}`);
  }
}

/** 生成短 ID（6 位随机字符串） */
function generateId(): string {
  return Math.random().toString(36).substring(2, 8);
}

/**
 * 解析 crontab 表达式，返回下次执行时间（毫秒时间戳）
 * 支持格式：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6)
 * 特殊字符：* 表示任意值
 */
export function parseCronSchedule(schedule: string): number | undefined {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;

  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0); // 从当前分钟的整秒开始

  // 简单实现：逐分钟递增直到匹配
  for (let i = 0; i < 525600; i++) { // 最多检查一年
    next.setMinutes(next.getMinutes() + 1);
    const [minute, hour, day, month, weekday] = parts;

    if (
      matchField(next.getMinutes(), minute) &&
      matchField(next.getHours(), hour) &&
      matchField(next.getDate(), day) &&
      matchField(next.getMonth() + 1, month) &&
      matchField(next.getDay(), weekday)
    ) {
      return next.getTime();
    }
  }
  return undefined;
}

/** 匹配单个字段 */
function matchField(value: number, field: string): boolean {
  if (field === "*") return true;
  if (field.includes(",")) {
    return field.split(",").some((f) => matchField(value, f.trim()));
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }
  if (field.includes("/")) {
    const [, step] = field.split("/");
    return value % Number(step) === 0;
  }
  return value === Number(field);
}

/** 添加定时任务 */
export function addJob(
  schedule: string,
  prompt: string,
  userId: string,
  contextToken?: string,
): { id: string; nextRunAt: number } | undefined {
  const nextRunAt = parseCronSchedule(schedule);
  if (nextRunAt === undefined) return undefined;

  const job: CronJob = {
    id: generateId(),
    schedule,
    prompt,
    userId,
    contextToken,
    nextRunAt,
    enabled: true,
    createdAt: Date.now(),
  };

  jobs.push(job);
  saveJobs();
  logger.info(`[cron] 添加任务 ${job.id}: ${schedule} "${prompt.slice(0, 50)}..."`);
  return { id: job.id, nextRunAt };
}

/** 列出所有定时任务 */
export function listJobs(): CronJob[] {
  return [...jobs].sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
}

/** 删除定时任务 */
export function removeJob(id: string): boolean {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  saveJobs();
  logger.info(`[cron] 删除任务 ${id}`);
  return true;
}

/** 启动调度器 */
export function startScheduler(onJobRun: (job: CronJob) => Promise<void>): void {
  // 立即加载一次
  jobs = loadJobs();

  // 启动定时器
  tickTimer = setInterval(() => tick(onJobRun), TICK_INTERVAL_MS);
  logger.info("[cron] 调度器已启动");
}

/** 停止调度器 */
export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    logger.info("[cron] 调度器已停止");
  }
}

/** 定时检查并执行到期的任务 */
async function tick(onJobRun: (job: CronJob) => Promise<void>): Promise<void> {
  const now = Date.now();
  for (const job of jobs) {
    if (!job.enabled || !job.nextRunAt || job.nextRunAt > now) continue;

    logger.info(`[cron] 执行任务 ${job.id}: ${job.schedule}`);
    job.lastRunAt = now;

    try {
      await onJobRun(job);
    } catch (err) {
      logger.error(`[cron] 任务 ${job.id} 执行失败: ${String(err)}`);
      job.lastResult = `执行失败: ${String(err)}`;
    }

    // 计算下次执行时间
    job.nextRunAt = parseCronSchedule(job.schedule);
  }
  saveJobs();
}
