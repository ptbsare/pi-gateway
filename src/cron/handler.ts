/**
 * cron 执行器注册表
 * 每个微信账号 Runner 注册自己的 cron 执行器（绑定该账号的 pi + client），
 * 调度器触发任务时按注册顺序调用。
 */

import { logger } from "../logger/index.js";
import type { CronJob } from "./scheduler.js";

export type CronExecutor = (job: CronJob) => Promise<void>;

const executors: CronExecutor[] = [];

/** 注册 cron 执行器（每个账号一个） */
export function registerCronExecutor(executor: CronExecutor): void {
  executors.push(executor);
  logger.info(`[cron] 注册执行器，当前共 ${executors.length} 个`);
}

/** 注销执行器 */
export function unregisterCronExecutor(executor: CronExecutor): void {
  const idx = executors.indexOf(executor);
  if (idx >= 0) executors.splice(idx, 1);
}

/** 调度器回调：把所有到期任务交给已注册的执行器处理 */
export async function dispatchCronJob(job: CronJob): Promise<void> {
  if (executors.length === 0) {
    logger.warn(`[cron] 任务 ${job.id} 到期但没有可用执行器，跳过`);
    return;
  }
  // 逐个执行器尝试（正常情况下只有一个账号注册了执行器）
  for (const executor of executors) {
    try {
      await executor(job);
    } catch (err) {
      logger.error(`[cron] 执行器处理任务 ${job.id} 失败: ${String(err)}`);
    }
  }
}
