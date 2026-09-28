/**
 * cron 工具：供 pi agent 管理定时任务（增/查/改/删）
 *
 * 单一工具 + action 参数，避免为每个操作各开一个工具：
 *   - add     添加定时任务（schedule + prompt）
 *   - list    列出全部任务
 *   - status  查看单个任务详情（id）
 *   - update  修改任务的 schedule / prompt / 启用状态（id）
 *   - remove  删除任务（id）
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { addJob, listJobs, getJob, updateJob, removeJob, type CronJob } from "./scheduler.js";
import { formatCronDescription } from "./format.js";

export function createCronTool(
  userId: string,
  contextToken?: string,
  accountId?: string,
) {
  /** 把单个任务格式化为多行文本 */
  const renderJob = (job: CronJob): string => {
    const desc = formatCronDescription(job.schedule, job.nextRunAt);
    return [
      `[${job.id}] ${desc}`,
      `   执行内容: ${job.prompt.slice(0, 100)}${job.prompt.length > 100 ? "..." : ""}`,
      `   状态: ${job.enabled ? "✅ 启用" : "⏸ 暂停"} | 下次执行: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString("zh-CN", { hour12: false }) : "未知"}`,
      `   最后执行: ${job.lastRunAt ? new Date(job.lastRunAt).toLocaleString("zh-CN", { hour12: false }) : "未执行"}`,
      ...(job.lastResult ? [`   结果: ${job.lastResult.slice(0, 80)}${job.lastResult.length > 80 ? "..." : ""}`] : []),
    ].join("\n");
  };

  return defineTool({
    name: "cron",
    label: "定时任务管理",
    description:
      "管理当前用户的定时任务（cron）。通过 action 指定操作类型，结果回发到当前聊天。\n" +
      "- add: 添加任务，需提供 schedule（crontab 5 字段：分 时 日 月 周）和 prompt（到点执行的内容）。\n" +
      "- list: 列出全部任务。\n" +
      "- status: 查看单个任务详情，需提供 id。\n" +
      "- update: 修改任务的 schedule/prompt/enabled，需提供 id，仅传需要改的字段（改 schedule 会重算下次执行时间）。\n" +
      "- remove: 删除任务，需提供 id。\n" +
      "schedule 示例：'0 9 * * *' 每天9:00；'*/5 * * * *' 每5分钟；'0 0 * * 1' 每周一0点。",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("list"),
          Type.Literal("status"),
          Type.Literal("update"),
          Type.Literal("remove"),
        ],
        { description: "操作类型：add / list / status / update / remove" },
      ),
      id: Type.Optional(
        Type.String({ description: "任务 ID（status/update/remove 必填）" }),
      ),
      schedule: Type.Optional(
        Type.String({
          description: "crontab 表达式，5 字段：分 时 日 月 周（0-59, 0-23, 1-31, 1-12, 0-6）。add 必填；update 可选。",
          examples: ["0 9 * * *", "*/5 * * * *", "0 8,20 * * *", "0 0 * * 1"],
        }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "定时执行的 prompt 内容。add 必填；update 可选。" }),
      ),
      enabled: Type.Optional(
        Type.Boolean({ description: "是否启用（update 专用，true 启用 / false 暂停）" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const err = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: {},
        isError: true,
      });

      switch (params.action) {
        case "add": {
          if (!params.schedule) return err("❌ add 需要提供 schedule 参数");
          if (!params.prompt) return err("❌ add 需要提供 prompt 参数");
          const result = addJob(params.schedule, params.prompt, userId, contextToken, accountId);
          if (!result) return err("❌ schedule 格式错误，请检查 crontab 表达式（5 字段：分 时 日 月 周）");
          const desc = formatCronDescription(params.schedule, result.nextRunAt);
          return {
            content: [{
              type: "text" as const,
              text: `✅ 定时任务已添加\n\n任务 ID: ${result.id}\n执行计划: ${params.schedule}\n${desc}\n执行内容: ${params.prompt.slice(0, 100)}${params.prompt.length > 100 ? "..." : ""}`,
            }],
            details: {},
          };
        }

        case "list": {
          const jobs = listJobs();
          if (!jobs.length) {
            return {
              content: [{ type: "text" as const, text: "📋 暂无定时任务" }],
              details: {},
            };
          }
          return {
            content: [{
              type: "text" as const,
              text: `📋 定时任务（共 ${jobs.length} 个）\n\n${jobs.map(renderJob).join("\n\n")}`,
            }],
            details: {},
          };
        }

        case "status": {
          if (!params.id) return err("❌ status 需要提供 id 参数");
          const job = getJob(params.id);
          if (!job) return err(`❌ 未找到任务 ${params.id}`);
          return {
            content: [{ type: "text" as const, text: renderJob(job) }],
            details: {},
          };
        }

        case "update": {
          if (!params.id) return err("❌ update 需要提供 id 参数");
          if (params.schedule === undefined && params.prompt === undefined && params.enabled === undefined) {
            return err("❌ update 至少需要提供 schedule / prompt / enabled 之一");
          }
          const job = updateJob(params.id, {
            schedule: params.schedule,
            prompt: params.prompt,
            enabled: params.enabled,
          });
          if (!job) return err(`❌ 任务 ${params.id} 不存在或 schedule 格式错误`);
          const desc = formatCronDescription(job.schedule, job.nextRunAt);
          return {
            content: [{
              type: "text" as const,
              text: `✅ 定时任务已更新\n\n${renderJob(job)}\n计划: ${job.schedule}\n${desc}`,
            }],
            details: {},
          };
        }

        case "remove": {
          if (!params.id) return err("❌ remove 需要提供 id 参数");
          const ok = removeJob(params.id);
          return ok
            ? { content: [{ type: "text" as const, text: `✅ 已删除任务 ${params.id}` }], details: {} }
            : err(`❌ 未找到任务 ${params.id}`);
        }

        default:
          return err(`❌ 未知 action: ${params.action}`);
      }
    },
  });
}
