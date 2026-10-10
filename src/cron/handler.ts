/**
 * cron 执行器注册表
 * 每个微信账号 Runner 注册自己的 cron 执行器（绑定该账号的 pi + client）。
 * 调度器触发任务时，只把任务派发给「任务所属账号」的执行器，
 * 避免多账号同时在线时同一任务被所有账号各执行一遍。
 */

import { logger } from "../logger/index.js";
import type { CronJob } from "./scheduler.js";

export type CronExecutor = (job: CronJob) => Promise<void>;

interface RegisteredExecutor {
  accountId: string;
  run: CronExecutor;
}

const executors: RegisteredExecutor[] = [];

/** 注册 cron 执行器（每个账号一个，需带上账号 ID 用于精确派发） */
export function registerCronExecutor(accountId: string, executor: CronExecutor): void {
  executors.push({ accountId, run: executor });
  logger.info(`[cron] 注册执行器 [${accountId}]，当前共 ${executors.length} 个`);
}

/** 注销执行器 */
export function unregisterCronExecutor(executor: CronExecutor): void {
  const idx = executors.findIndex((e) => e.run === executor);
  if (idx >= 0) executors.splice(idx, 1);
}

/** 调度器回调：只把任务交给任务所属账号的执行器 */
export async function dispatchCronJob(job: CronJob): Promise<void> {
  if (executors.length === 0) {
    logger.warn(`[cron] 任务 ${job.id} 到期但没有可用执行器，跳过`);
    return;
  }
  if (!job.accountId) {
    logger.warn(`[cron] 任务 ${job.id} 缺少 accountId，无法确定执行账号，跳过`);
    return;
  }

  const target = executors.find((e) => e.accountId === job.accountId);
  if (!target) {
    logger.warn(`[cron] 任务 ${job.id} 所属账号 [${job.accountId}] 未在线，跳过`);
    return;
  }

  try {
    await target.run(job);
  } catch (err) {
    logger.error(`[cron] 执行器 [${target.accountId}] 处理任务 ${job.id} 失败: ${String(err)}`);
  }
}
