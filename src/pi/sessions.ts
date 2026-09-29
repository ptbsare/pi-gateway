import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MODEL_REF, saveSettings, sessionMapFile, WORKSPACE } from "../config.js";
import { checkSendPolicy, loadSendPolicy, type SendPolicy } from "../send-policy.js";
import { detectSendableKind, type SendableKind } from "../ilink/media.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { logger } from "../logger/index.js";
import { createCronTool } from "../cron/tool.js";

/** 当前消息的回复上下文（供自定义工具回发媒体） */
export interface ReplyContext {
  /** 把本地文件（图片/视频/普通文件）发送到当前微信对话 */
  sendFile: (path: string, kind?: SendableKind) => Promise<void>;
  /** 兼容旧接口：发送图片 */
  sendImage: (path: string) => Promise<void>;
}

/** 斜杠命令（如 /goal 插件）执行后的宽限等待时间（毫秒） */
const COMMAND_SETTLE_GRACE_MS = 2000;
/** 宽限窗口内轮询间隔（毫秒） */
const COMMAND_SETTLE_POLL_MS = 100;
/** 检测到插件拉起 agent 后等待其完成的最长时间（毫秒） */
const COMMAND_RUN_TIMEOUT_MS = 10 * 60 * 1000;

export interface ChatOptions {
  /** 入站图片（base64），供 pi 视觉理解 */
  images?: Array<{ mimeType: string; data: string }>;
  replyContext?: ReplyContext;
}

/** 键值持久化映射：微信对话 key (from_user_id / session_id) → pi .jsonl 会话文件绝对路径 */
class SessionPathStore {
  private file: string;
  private map = new Map<string, string>();

  constructor(accountId: string) {
    this.file = sessionMapFile(accountId);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string" && existsSync(v)) this.map.set(k, v);
      }
    } catch {
      // 解析失败忽略
    }
  }

  get(key: string): string | undefined {
    const p = this.map.get(key);
    if (p && existsSync(p)) return p;
    this.map.delete(key);
    return undefined;
  }

  set(key: string, sessionFile: string): void {
    this.map.set(key, sessionFile);
    this.flush();
  }

  delete(key: string): void {
    this.map.delete(key);
    this.flush();
  }

  private flush(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map.entries()) obj[k] = v;
      writeFileSync(this.file, JSON.stringify(obj, null, 2), "utf8");
    } catch (err) {
      logger.warn(`[pi] 会话映射保存失败: ${String(err)}`);
    }
  }
}

/**
 * pi 会话管理器：每个微信对话对应一个持久化的 pi AgentSession（落盘 ~/.pi/agent/sessions/），
 * 可在 pi CLI / TUI 中随时通过 pi --resume 或会话列表并列查看与恢复。
 */
export class PiSessionManager {
  private sessions = new Map<string, AgentSession>();
  private locks = new Map<string, Promise<void>>();
  private replyContexts = new Map<string, ReplyContext>();
  private busy = new Set<string>();
  private pendingDirectives = new Map<string, string>();
  private modelRuntime?: ModelRuntime;
  private modelRef = MODEL_REF;
  private modelWarned = false;
  private pathStore: SessionPathStore;
  private sendPolicy: SendPolicy;
  /** key → userId，用于 cron 工具回发消息 */
  private userKeys = new Map<string, { userId: string; contextToken?: string }>();
  constructor(public readonly accountId: string = "default") {
    this.pathStore = new SessionPathStore(accountId);
    this.sendPolicy = loadSendPolicy();
  }

  /** 初始化；可注入 ModelRuntime（测试用） */
  async init(runtime?: ModelRuntime): Promise<void> {
    mkdirSync(WORKSPACE, { recursive: true });
    this.modelRuntime = runtime ?? (await ModelRuntime.create());
  }

  setDirective(key: string, directive: string): void {
    this.pendingDirectives.set(key, directive);
  }

  consumeDirective(key: string): string | undefined {
    const d = this.pendingDirectives.get(key);
    if (d) this.pendingDirectives.delete(key);
    return d;
  }

  async reload(): Promise<string> {
    if (!this.modelRuntime) return "模型运行时未初始化";
    try {
      await this.modelRuntime.refresh();
    } catch (err) {
      logger.warn(`[pi] 模型目录刷新失败: ${String(err)}`);
    }
    this.sendPolicy = loadSendPolicy();
    this.modelWarned = false;
    const model = this.resolveModel(this.modelRef);
    if (!model) {
      return `重载完成。当前模型 ${this.modelRef} 未在 pi 配置中注册`;
    }
    const sessions = [...this.sessions.values()];
    if (!sessions.length) return `重载完成。当前模型：${this.modelRef}（无活动会话）`;
    const results = await Promise.allSettled(sessions.map((s) => s.setModel(model)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      return `重载完成：${results.length - failed}/${results.length} 个会话已切到 ${this.modelRef}`;
    }
    return `重载完成。当前模型：${this.modelRef}（已应用到 ${sessions.length} 个会话）`;
  }

  getModelRef(): string {
    return this.modelRef;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  busyCount(): number {
    return this.busy.size;
  }

  getSessionStats(key: string): ReturnType<AgentSession["getSessionStats"]> | undefined {
    return this.sessions.get(key)?.getSessionStats();
  }

  async interrupt(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session || !this.busy.has(key)) return false;
    try {
      await session.abort();
    } catch {
      // 已完成
    }
    return true;
  }

  private resolveModel(ref: string): ReturnType<ModelRuntime["getModel"]> {
    const idx = ref.indexOf("/");
    if (idx <= 0 || idx === ref.length - 1) return undefined;
    const provider = ref.slice(0, idx);
    const modelId = ref.slice(idx + 1);
    return this.modelRuntime?.getModel(provider, modelId);
  }

  async switchModel(ref: string): Promise<string> {
    const model = this.resolveModel(ref);
    if (!model) return `未找到模型：${ref}`;
    const prev = this.modelRef;
    this.modelRef = ref;
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((s) => s.setModel(model)),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    try {
      saveSettings({ model: ref });
    } catch (err) {
      logger.warn(`[pi] 模型选择持久化失败: ${String(err)}`);
    }
    if (failed > 0) {
      return `已切换到 ${ref}（${failed} 个进行中会话切换失败）`;
    }
    return `已从 ${prev} 切换到 ${ref}（已保存为默认，重启后保持）`;
  }

  private userRegisteredProviders(): string[] {
    try {
      const file = join(getAgentDir(), "models.json");
      if (!existsSync(file)) return [];
      const data = JSON.parse(readFileSync(file, "utf8"));
      return Object.keys(data.providers ?? {});
    } catch {
      return [];
    }
  }

  async listModels(): Promise<string> {
    if (!this.modelRuntime) return "模型运行时未初始化";
    const providers = this.userRegisteredProviders();
    const all = this.modelRuntime.getModels();
    let models = providers.length
      ? providers.flatMap((p) => all.filter((m) => m.provider === p))
      : await this.modelRuntime.getAvailable();
    if (!models.length) models = await this.modelRuntime.getAvailable();
    if (!models.length) return "没有可用模型（检查 ~/.pi/agent/models.json 配置）";
    const MAX = 100;
    const lines = [`📋 可用模型（${Math.min(models.length, MAX)}）`, ""];
    models.slice(0, MAX).forEach((m, i) => {
      const ref = `${m.provider}/${m.id}`;
      lines.push(`${i + 1}. ${ref}${ref === this.modelRef ? " ✓ 当前" : ""}`);
    });
    if (models.length > MAX) lines.push(`… 另有 ${models.length - MAX} 个`);
    return lines.join("\n");
  }

  /**
   * 注册 weixin_send 工具：合并发送图片、视频与普通文件。
   * 支持通过 PI_GATEWAY_SEND_ALLOW / PI_GATEWAY_SEND_DENY 环境变量限制可发送目录。
   */
  private createSendTool(key: string) {
    const handleSend = async (params: { path: string }) => {
      const decision = checkSendPolicy(params.path, this.sendPolicy);
      if (!decision.allowed) {
        return {
          content: [{ type: "text" as const, text: `发送拒绝：${decision.reason}` }],
          details: {},
          isError: true,
        };
      }
      const ctx = this.replyContexts.get(key);
      if (!ctx) {
        return {
          content: [{ type: "text" as const, text: "当前无回复上下文，无法发送" }],
          details: {},
          isError: true,
        };
      }
      try {
        const buf = readFileSync(params.path);
        const fileName = basename(params.path);
        const kind = detectSendableKind(buf, fileName);
        await ctx.sendFile(params.path, kind);
        return {
          content: [
            {
              type: "text" as const,
              text: `已作为 ${kind === "image" ? "图片" : kind === "video" ? "视频" : "文件"} 发送：${params.path}`,
            },
          ],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `发送失败：${String(err)}` }],
          details: {},
          isError: true,
        };
      }
    };

    const userInfo = this.userKeys.get(key);

    return [
      defineTool({
        name: "weixin_send",
        label: "发送微信消息（图片/视频/文件）",
        description:
          "把本地文件发送到当前微信对话。支持图片、视频及各类普通文件（自动根据文件内容判定类型）。参数为文件的绝对路径。",
        parameters: Type.Object({
          path: Type.String({ description: "文件的绝对路径" }),
        }),
        execute: async (_toolCallId, params: { path: string }) => handleSend(params),
      }),
      // 定时任务工具：允许 agent 管理 cron 定时任务（增/查/改/删）
      ...(userInfo ? [createCronTool(userInfo.userId, userInfo.contextToken, this.accountId)] : []),
    ];
  }

  /** 设置 key 对应的用户信息（用于 cron 结果回发） */
  setUserKey(key: string, userId: string, contextToken?: string): void {
    this.userKeys.set(key, { userId, contextToken });
  }

  /** 读取 key 对应的用户信息（供 /cron add 使用真实用户与账号） */
  getUserKey(key: string): { userId: string; contextToken?: string } | undefined {
    return this.userKeys.get(key);
  }

  private async getOrCreate(key: string): Promise<AgentSession> {
    let session = this.sessions.get(key);
    if (!session) {
      const model = this.resolveModel(this.modelRef);
      if (!model && !this.modelWarned) {
        this.modelWarned = true;
        logger.warn(
          `[pi] 模型 ${this.modelRef} 未在当前 pi 配置中注册，回退 pi 默认模型`,
        );
      }
      // 持久化 SessionManager：若有历史 .jsonl 文件则 open 恢复，否则 create 新建
      const existingFile = this.pathStore.get(key);
      const sessionManager = existingFile
        ? SessionManager.open(existingFile)
        : SessionManager.create(WORKSPACE);

      const { session: created } = await createAgentSession({
        cwd: WORKSPACE,
        sessionManager,
        modelRuntime: this.modelRuntime,
        ...(model ? { model } : {}),
        customTools: this.createSendTool(key),
      });

      await created.bindExtensions({});
      session = created;
      this.sessions.set(key, session);
      if (session.sessionFile) {
        this.pathStore.set(key, session.sessionFile);
      }
    }
    return session;
  }

  async chat(key: string, text: string, options: ChatOptions = {}): Promise<string> {
    if (options.replyContext) this.replyContexts.set(key, options.replyContext);
    const directive = this.consumeDirective(key);
    const promptText = directive ? `${directive}\n\n${text}` : text;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const task: Promise<string> = prev.then(() => this.doChat(key, promptText, options.images));
    this.locks.set(
      key,
      task.then(
        () => {},
        () => {},
      ),
    );
    return task;
  }

  private async doChat(
    key: string,
    text: string,
    images?: Array<{ mimeType: string; data: string }>,
  ): Promise<string> {
    const session = await this.getOrCreate(key);
    let current = "";
    let final = "";
    const unsubscribe = session.subscribe((event) => {
      const e = event as {
        type: string;
        message?: { role: string };
        assistantMessageEvent?: { type: string; delta?: string };
      };
      if (e.type === "message_start" && e.message?.role === "assistant") {
        current = "";
      } else if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        current += e.assistantMessageEvent.delta ?? "";
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        if (current.trim()) final = current;
      }
    });
    this.busy.add(key);
    try {
      const promptImages = images?.length
        ? images.map((img) => ({ type: "image" as const, mimeType: img.mimeType, data: img.data }))
        : undefined;
      await session.prompt(text, promptImages ? { images: promptImages } : undefined);
      // 斜杠命令（如第三方插件的 /goal）在 prompt() 内同步执行后立即返回，
      // 但插件可能通过 pi.sendUserMessage(followUp) 触发后续 agent 轮次。
      // 先在宽限窗口内轮询会话是否被拉起，若被拉起则一直等到真正空闲，
      // 保证订阅窗口覆盖插件拉起的全部轮次；
      // 否则 final 为空 → 网关按“空回复”跳过发送，微信收不到结果。
      await this.settleCommandBackgroundWork(session);
    } finally {
      this.busy.delete(key);
      unsubscribe();
    }
    return (final || current).trim();
  }

  /**
   * 斜杠命令可能 fire-and-forget 触发后续 agent 轮次（如 /goal 插件）。
   * 在宽限窗口内轮询会话是否被拉起；若被拉起，则等待直到会话真正空闲。
   * （one-at-a-time 模式下队列在一轮内被合并排空，单轮结束后会话空闲即代表排空。）
   */
  private async settleCommandBackgroundWork(session: AgentSession): Promise<void> {
    const busy = () => !session.isIdle || session.getSteeringMessages().length > 0 || session.getFollowUpMessages().length > 0;
    let deadline = Date.now() + COMMAND_SETTLE_GRACE_MS;
    while (!busy() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, COMMAND_SETTLE_POLL_MS));
    }
    if (!busy()) return;

    // 会话已被插件拉起：等待其完全结束（覆盖多轮 goal 循环）。
    // 因为插件的 sendUserMessage 往往是在 agent_end 钩子里异步微任务(fire-and-forget)拉起的，
    // 在多轮循环交替的间隙，会有一刹那 session.isIdle 变为 true。
    // 为了避免提前退出，我们需要在 waitForIdle 后，连续稳定空闲至少 1.2 秒。
    deadline = Date.now() + COMMAND_RUN_TIMEOUT_MS;
    let consecutiveIdleMs = 0;
    const REQUIRED_STABLE_IDLE_MS = 1200;

    while (Date.now() < deadline) {
      try {
        await session.waitForIdle();
      } catch {
        return;
      }
      if (busy()) {
        consecutiveIdleMs = 0;
      } else {
        consecutiveIdleMs += COMMAND_SETTLE_POLL_MS;
        if (consecutiveIdleMs >= REQUIRED_STABLE_IDLE_MS) {
          return; // 持续空闲，说明插件确实没有再追加新一轮了
        }
      }
      await new Promise((r) => setTimeout(r, COMMAND_SETTLE_POLL_MS));
    }
    logger.warn(`[pi] 斜杠命令后台执行超过 ${COMMAND_RUN_TIMEOUT_MS / 1000}s，提前返回当前结果`);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      try {
        session.dispose();
      } catch {
        // 忽略
      }
    }
    this.sessions.clear();
  }

  async resetSession(key: string): Promise<void> {
    // 等待该会话的串行锁完成，避免重置与正在进行的对话冲突
    const prev = this.locks.get(key);
    if (prev) await prev.catch(() => {});

    const session = this.sessions.get(key);
    if (session) {
      try {
        session.dispose();
      } catch {
        // 忽略释放异常
      }
      this.sessions.delete(key);
    }
    // 断开 pathStore 映射（下次 getOrCreate 会新建会话），但保留磁盘 jsonl 文件供 TUI /resume
    this.pathStore.delete(key);
    this.replyContexts.delete(key);
    this.pendingDirectives.delete(key);
  }

  /** 列出 WORKSPACE 下可恢复的会话（按修改时间倒序），返回前 limit 个 */
  async listSessions(limit = 20): Promise<Array<{ file: string; modified: Date; messageCount: number; firstMessage: string }>> {
    try {
      const infos = await SessionManager.list(WORKSPACE, undefined, undefined, undefined);
      return infos
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .slice(0, limit)
        .map((i) => ({
          file: i.path,
          modified: i.modified,
          messageCount: i.messageCount,
          firstMessage: i.firstMessage || "",
        }));
    } catch (err) {
      logger.warn(`[pi] 列出会话失败: ${String(err)}`);
      return [];
    }
  }

  /** 恢复指定会话：dispose 当前，改用历史 jsonl */
  async resumeSession(key: string, file: string): Promise<boolean> {
    if (!existsSync(file)) return false;
    const prev = this.locks.get(key);
    if (prev) await prev.catch(() => {});
    const current = this.sessions.get(key);
    if (current) {
      try { current.dispose(); } catch { /* ignore */ }
      this.sessions.delete(key);
    }
    const model = this.resolveModel(this.modelRef);
    try {
      const { session: created } = await createAgentSession({
        cwd: WORKSPACE,
        sessionManager: SessionManager.open(file),
        modelRuntime: this.modelRuntime,
        ...(model ? { model } : {}),
        customTools: this.createSendTool(key),
      });
      await created.bindExtensions({});
      this.sessions.set(key, created);
      this.pathStore.set(key, file);
      return true;
    } catch (err) {
      logger.error(`[pi] 恢复会话失败: ${String(err)}`);
      return false;
    }
  }
}

