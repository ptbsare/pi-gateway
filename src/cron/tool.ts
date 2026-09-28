/**
 * cron_add 工具：供 pi agent 添加定时任务
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { addJob } from "./scheduler.js";
import { formatCronDescription } from "./format.js";

export function createCronAddTool(
  userId: string,
  contextToken?: string,
  accountId?: string,
) {
  return defineTool({
    name: "cron_add",
    label: "添加定时任务",
    description:
      "添加一个定时执行的任务。任务会在指定时间执行 prompt 内容，结果会发回给当前用户。\n" +
      "schedule 使用 crontab 格式（5 字段：分 时 日 月 周）。\n" +
      "例如：'0 9 * * *' 表示每天 9:00，'*/5 * * * *' 表示每 5 分钟。",
    parameters: Type.Object({
      schedule: Type.String({
        description: "crontab 表达式，5 字段：分 时 日 月 周（0-59, 0-23, 1-31, 1-12, 0-6）",
        examples: ["0 9 * * *", "*/5 * * * *", "0 8,20 * * *", "0 0 * * 1"],
      }),
      prompt: Type.String({
        description: "定时执行的 prompt 内容",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const result = addJob(params.schedule, params.prompt, userId, contextToken, accountId);
      if (!result) {
        return {
          content: [{ type: "text" as const, text: "❌ schedule 格式错误，请检查 crontab 表达式" }],
          details: {},
          isError: true,
        };
      }

      const desc = formatCronDescription(params.schedule, result.nextRunAt);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ 定时任务已添加\n\n` +
                  `任务 ID: ${result.id}\n` +
                  `执行计划: ${params.schedule}\n` +
                  `下次执行: ${desc}\n` +
                  `执行内容: ${params.prompt.slice(0, 100)}${params.prompt.length > 100 ? "..." : ""}`,
          },
        ],
        details: {},
      };
    },
  });
}
