// 斜杠命令处理：/help /status /new /model /skill /mcp /usage /stop /ping，不经过 pi 直接响应。
// 回复按 markdown 列表组织（微信端按 markdown 渲染，单 \n 会被折成空格）。
// 未知斜杠命令返回 null，交由 pi 处理（可能是路径或 pi 命令）。

import type { PiSessionManager } from "./pi/sessions.js";
import { BRIDGE_VERSION, WORKSPACE } from "./config.js";
import { listSkills, listMcpServers, skillDirective, mcpDirective } from "./catalog.js";
import { formatCronDescription } from "./cron/format.js";

export interface SlashContext {
  /** 会话 key（session_id 或 from_user_id） */
  key: string;
}

const LIST_MAX = 100;

const HELP_TEXT = [
  "📋 可用命令",
  "",
  "1. /help — 显示本帮助",
  "2. /status — 服务状态",
  "3. /new — 开始新对话",
  "4. /model — 查看当前模型；/model list 列表；/model <provider/modelId> 切换",
  "5. /skill — skill 列表；/skill <名称> 下一条消息按该 skill 处理",
  "6. /mcp — MCP server 列表；/mcp <名称> 下一条消息调用其工具",
  "7. /reload — 重载模型配置（models.json 改动立即生效）",
  "8. /usage — 当前对话用量",
  "9. /stop — 停止进行中的任务",
  "10. /ping — 存活检查",
  "11. /resume — 列出历史会话并恢复对话",
  "",
  "其他消息直接发给 pi 处理。",
].join("\n");

/** 秒数 → 人类可读时长 */
function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/** Token 数 → 紧凑显示（≥1000 用 k） */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class SlashCommandHandler {
  constructor(
    private pi: PiSessionManager,
    private accountId: string,
  ) {}

  /** 处理斜杠命令；非斜杠命令或未知命令返回 null（交由 pi 处理）；命令抛错时回复友好提示而非静默失败 */
  async handle(text: string, ctx: SlashContext): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const cmd = trimmed.split(/\s+/)[0].toLowerCase();
    try {
      switch (cmd) {
        case "/help":
          return HELP_TEXT;
        case "/status":
          return this.status();
        case "/new":
          return await this.newSession(ctx.key);
        case "/model":
          return this.modelCommand(trimmed);
        case "/skill":
          return this.skillCommand(trimmed, ctx.key);
        case "/mcp":
          return this.mcpCommand(trimmed, ctx.key);
        case "/reload":
          return await this.pi.reload();
        case "/usage":
          return this.usage(ctx.key);
        case "/stop":
          return await this.stop(ctx.key);
        case "/ping":
          return "🏓 pong";
        case "/cron":
          return await this.cronCommand(trimmed, ctx.key);
        case "/resume":
          return await this.resumeCommand(trimmed, ctx.key);
        default:
          return null; // 未知命令交给 pi
      }
    } catch (err) {
      return `⚠️ 命令执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** /model 查看 / 切换 / 列表 */
  private async modelCommand(text: string): Promise<string> {
    const arg = text.trim().slice("/model".length).trim();
    if (!arg) {
      return `当前模型：${this.pi.getModelRef()}`;
    }
    if (arg.toLowerCase() === "list") {
      return await this.pi.listModels();
    }
    return await this.pi.switchModel(arg);
  }

  /** /skill 列表 / 设置下一条消息的 skill 指令 */
  private skillCommand(text: string, key: string): string {
    const arg = text.trim().slice("/skill".length).trim();
    const skills = listSkills();
    if (!arg) {
      const lines = [`📋 可用 skill（${Math.min(skills.length, LIST_MAX)}）`, ""];
      skills.slice(0, LIST_MAX).forEach((s, i) => {
        lines.push(`${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ""}`);
      });
      if (skills.length > LIST_MAX) lines.push(`… 另有 ${skills.length - LIST_MAX} 个`);
      return lines.join("\n");
    }
    const info = skills.find((s) => s.name.toLowerCase() === arg.toLowerCase());
    if (!info) return `未找到 skill：\`${arg}\`（/skill 查看列表）`;
    this.pi.setDirective(key, skillDirective(info));
    return `下一条消息将按 skill「${info.name}」处理。`;
  }

  /** /mcp 列表 / 设置下一条消息的 MCP 调用指令 */
  private mcpCommand(text: string, key: string): string {
    const arg = text.trim().slice("/mcp".length).trim();
    const servers = listMcpServers();
    if (!arg) {
      if (!servers.length) return "未配置 MCP server（~/.pi/agent/mcp.json）。";
      const lines = [`📋 MCP server（${Math.min(servers.length, LIST_MAX)}）`, ""];
      servers.slice(0, LIST_MAX).forEach((s, i) => {
        lines.push(`${i + 1}. ${s.name}${s.command ? ` — \`${s.command}\`` : ""}`);
      });
      if (servers.length > LIST_MAX) lines.push(`… 另有 ${servers.length - LIST_MAX} 个`);
      return lines.join("\n");
    }
    const info = servers.find((s) => s.name.toLowerCase() === arg.toLowerCase());
    if (!info) return `未找到 MCP server：\`${arg}\`（/mcp 查看列表）`;
    this.pi.setDirective(key, mcpDirective(info));
    return `下一条消息将调用 MCP「${info.name}」的工具处理。`;
  }

  private status(): string {
    return [
      "📊 服务状态",
      "",
      `- 版本：${BRIDGE_VERSION}`,
      `- 账号：${this.accountId}`,
      `- 模型：${this.pi.getModelRef()}`,
      `- 工作目录：${WORKSPACE}`,
      `- 运行时长：${formatUptime(process.uptime())}`,
      `- 会话：${this.pi.sessionCount()} 个（${this.pi.busyCount()} 个处理中）`,
    ].join("\n");
  }

  /** /usage 当前对话用量（会话不存在时不创建） */
  private usage(key: string): string {
    const stats = this.pi.getSessionStats(key);
    if (!stats) return "当前对话还没有会话（发条消息就会开始）。";
    const lines = [
      "📊 当前对话用量",
      "",
      `- 消息：用户 ${stats.userMessages} / 助手 ${stats.assistantMessages}`,
      `- 工具调用：${stats.toolCalls} 次`,
      `- Token：输入 ${fmtTokens(stats.tokens.input)} / 输出 ${fmtTokens(stats.tokens.output)} / 缓存读 ${fmtTokens(stats.tokens.cacheRead)}，共 ${fmtTokens(stats.tokens.total)}`,
      `- 成本：$${stats.cost.toFixed(4)}`,
    ];
    const ctx = stats.contextUsage;
    if (ctx?.tokens != null && ctx.percent != null) {
      lines.push(`- 上下文：${ctx.percent.toFixed(1)}%（${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.contextWindow)}）`);
    }
    // provider 未返回 usage 时 tokens 全 0（如部分 OpenAI 兼容代理/自建 vllm 不回传 stream usage），
    // 明确提示是服务端行为而非统计故障
    if (stats.tokens.total === 0 && stats.assistantMessages > 0) {
      lines.push("- 注意：当前模型服务未返回用量数据，Token/成本无法统计（上下文为本地估算）");
    }
    return lines.join("\n");
  }

  /** /stop 中断该对话进行中的任务 */
  private async stop(key: string): Promise<string> {
    const ok = await this.pi.interrupt(key);
    return ok ? "⏹ 已停止当前进行中的任务。" : "当前没有进行中的任务。";
  }

  private async newSession(key: string): Promise<string> {
    await this.pi.resetSession(key);
    return "已开始新对话，上下文已清空。";
  }

  /** /cron 定时任务管理 */
  private async cronCommand(text: string, key: string): Promise<string> {
    const mod = await import("./cron/scheduler.js");
    const args = text.trim().slice("/cron".length).trim();

    if (!args || args === "list") {
      // 列出最近7个对话 + cron 任务
      const jobs = mod.listJobs();
      const lines = ["📋 定时任务（共 " + jobs.length + " 个）", ""];
      if (!jobs.length) {
        lines.push("暂无定时任务。通过 AI 发送 /cron add 或让 Agent 使用 cron_add 工具添加。");
      } else {
        jobs.slice(0, 20).forEach((j) => {
          const desc = formatCronDescription(j.schedule, j.nextRunAt);
          lines.push(`[${j.id}] ${desc}`);
          lines.push(`   ${j.prompt.slice(0, 60)}${j.prompt.length > 60 ? "..." : ""}`);
          lines.push(`   状态: ${j.enabled ? "✅ 启用" : "⏸ 暂停"} | 最后执行: ${j.lastRunAt ? new Date(j.lastRunAt).toLocaleString("zh-CN", {hour12:false}) : "未执行"}`);
          if (j.lastResult) lines.push(`   结果: ${j.lastResult.slice(0, 80)}`);
          lines.push("");
        });
      }
      return lines.join("\n");
    }

    if (args.startsWith("add ")) {
      // /cron add "0 9 * * *" "每天9点提醒我开会"
      const match = args.match(/^"([^"]+)"\s+"([^"]+)"/);
      if (!match) {
        return "用法: /cron add \"schedule\" \"prompt\"\n示例: /cron add \"0 9 * * *\" \"提醒我开会\"";
      }
      const [_, schedule, prompt] = match;
      const result = await mod.addJob(schedule, prompt, "user", undefined);
      if (!result) return "❌ schedule 格式错误，请使用 crontab 5 字段格式（分 时 日 月 周）";
      const desc = formatCronDescription(schedule, result.nextRunAt);
      return `✅ 定时任务已添加\nID: ${result.id}\n计划: ${schedule}\n下次执行: ${desc}`;
    }

    if (args.startsWith("del ") || args.startsWith("remove ")) {
      const id = args.replace(/^(del|remove)\s+/, "").trim();
      const ok = await mod.removeJob(id);
      return ok ? `✅ 已删除任务 ${id}` : `❌ 未找到任务 ${id}`;
    }

    return "用法: /cron [list|add|del]\n示例:\n  /cron list              # 列出所有任务\n  /cron add \"0 9 * * *\" \"每天早上9点提醒\"\n  /cron del <id>          # 删除任务";
  }

  /** /resume 会话恢复命令 */
  private async resumeCommand(text: string, key: string): Promise<string> {
    const PAGE_SIZE = 7;
    const args = text.trim().slice("/resume".length).trim();
    if (!args) return this._renderResumePage(1, key);
    if (args === "next" || args === "n") return this._renderResumePage(2, key);
    if (args === "prev" || args === "p" || args === "back" || args === "b") return this._renderResumePage(0, key);
    const num = Number.parseInt(args, 10);
    if (!isNaN(num)) return this._selectResumeSession(num, key);
    return "用法: /resume [list|1-7|next|prev]";
  }

  private async _renderResumePage(page: number, key: string): Promise<string> {
    const PAGE_SIZE = 7;
    const sessions = await this.pi.listSessions(PAGE_SIZE * page);
    if (!sessions.length) return "暂无历史会话（新对话自动保存，/resume 可恢复）";
    const display = sessions.slice(0, PAGE_SIZE);
    const out: string[] = ["📋 历史对话（共 " + sessions.length + " 条）", ""];
    display.forEach((s, i) => {
      const num = (page - 1) * PAGE_SIZE + i + 1;
      const time = s.modified.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const preview = s.firstMessage.replace(/\n/g, " ").slice(0, 40);
      out.push(`${num}. [${time}] (${s.messageCount} 条) ${preview || "(空会话)"}`);
    });
    if (sessions.length > PAGE_SIZE) out.push("输入 /resume <序号> 恢复，或 /resume next 翻页");
    return out.join("\n");
  }

  private async _selectResumeSession(num: number, key: string): Promise<string> {
    const PAGE_SIZE = 7;
    const sessions = await this.pi.listSessions(PAGE_SIZE * 2);
    const idx = num - 1;
    if (idx < 0 || idx >= sessions.length) return `❌ 序号 ${num} 超出范围（共 ${sessions.length} 条）`;
    const ok = await this.pi.resumeSession(key, sessions[idx].file);
    if (!ok) return `❌ 无法恢复该会话（文件已不存在）`;
    return `✅ 已恢复到 ${sessions[idx].modified.toLocaleString("zh-CN")} 的会话（${sessions[idx].messageCount} 条消息）`;
  }
}
