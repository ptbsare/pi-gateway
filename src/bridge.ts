import { IlinkClient, SessionTimeoutError } from "./ilink/client.js";
import { AuthError, ProtocolError } from "./ilink/errors.js";
import { MessageType, TypingStatus, type WeixinMessage } from "./ilink/types.js";
import { downloadInboundMedia, uploadFile, uploadImage, uploadVideo, type SendableKind } from "./ilink/media.js";
import { ContextStore } from "./ilink/context-store.js";
import { parseIncomingMessage } from "./message/parser.js";
import { buildFileMessage, buildImageMessage, buildTextMessage, buildVideoMessage } from "./message/builder.js";
import { chunkText } from "./message/markdown.js";
import { SlashCommandHandler } from "./command.js";
import { PiSessionManager, type ReplyContext } from "./pi/sessions.js";
import { getAllowUsers, CONFIG } from "./config.js";
import { logger } from "./logger/index.js";
import { basename } from "node:path";

/** typing ticket 缓存时长（过期后重新 getconfig 获取） */
const TICKET_TTL_MS = 50 * 60 * 1000;
/** 消息批量合并窗口默认 300ms（与 hermes text_batch_delay_seconds=0.3 对齐） */
const DEFAULT_BATCH_DELAY_MS = 300;
/** 环境变量 PI_GATEWAY_MSG_BATCH_MS 可调，最大 10s */
const MAX_BATCH_DELAY_MS = 10_000;

export class Bridge {
  private getUpdatesBuf = "";
  private consecutiveFailures = 0;
  private slash: SlashCommandHandler;
  /** 每会话 key 缓冲的消息列表（斜杠命令之外的入队） */
  private readonly _pendingMessages = new Map<string, WeixinMessage[]>();
  /** 对应的 flush timer */
  private readonly _pendingTimers = new Map<string, NodeJS.Timeout>();
  /** 批量合并窗口（ms），由 PI_GATEWAY_MSG_BATCH_MS 环境变量控制 */
  private readonly _batchDelayMs: number;

  constructor(
    private client: IlinkClient,
    private pi: PiSessionManager,
    private contextStore: ContextStore,
    accountId: string,
  ) {
    this.slash = new SlashCommandHandler(pi, accountId);
    const raw = Number(process.env.PI_GATEWAY_MSG_BATCH_MS);
    this._batchDelayMs = Number.isFinite(raw) && raw >= 0
      ? Math.min(raw, MAX_BATCH_DELAY_MS)
      : DEFAULT_BATCH_DELAY_MS;
    logger.info(`[bridge] [${accountId}] 消息批量窗口: ${this._batchDelayMs}ms`);
  }

  async run(signal: AbortSignal): Promise<void> {
    let nextTimeout = CONFIG.longPollTimeoutMs;
    logger.info(`[bridge] [${this.pi.accountId}] 消息循环已启动，等待微信消息...`);
    while (!signal.aborted) {
      try {
        const resp = await this.client.getUpdates(this.getUpdatesBuf, nextTimeout, signal);
        if (signal.aborted) break;

        if (resp.errcode === -14) throw new SessionTimeoutError();
        if (resp.ret && resp.ret !== 0) {
          throw new ProtocolError(`getUpdates ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`, resp.errcode);
        }

        this.consecutiveFailures = 0;
        if (resp.get_updates_buf) this.getUpdatesBuf = resp.get_updates_buf;
        if (resp.longpolling_timeout_ms) nextTimeout = resp.longpolling_timeout_ms;

        for (const msg of resp.msgs ?? []) {
          // 逐条入队（单条失败不影响循环）
          this.handleMessage(msg).catch((err) => logger.error(`[bridge] 入队失败: ${String(err)}`));
        }
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof SessionTimeoutError || err instanceof AuthError) throw err;
        this.consecutiveFailures++;
        const backoff = this.consecutiveFailures >= 5 ? 30_000 : 3_000;
        logger.error(
          `[bridge] getUpdates 错误（连续 ${this.consecutiveFailures} 次），${backoff / 1000}s 后重试: ${String(err)}`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    // 退出前 flush 剩余缓冲
    for (const key of [...this._pendingMessages.keys()]) {
      clearTimeout(this._pendingTimers.get(key));
      this._pendingTimers.delete(key);
    }
    this._pendingMessages.clear();
    logger.info(`[bridge] [${this.pi.accountId}] 消息循环已退出。`);
  }

  /** 获取 typing ticket：优先用 contextStore 缓存（未过期），否则 getconfig 刷新 */
  private async getTypingTicket(userId: string, contextToken?: string): Promise<string | undefined> {
    const cached = this.contextStore.getTypingTicket(userId);
    if (cached) return cached;
    try {
      const resp = await this.client.getConfig(userId, contextToken);
      if (resp.typing_ticket) {
        this.contextStore.setTypingTicket(userId, resp.typing_ticket, TICKET_TTL_MS);
      }
      return resp.typing_ticket;
    } catch {
      return undefined;
    }
  }

  /** 发送「正在输入」状态（非关键路径，失败忽略） */
  private async sendTypingSafe(userId: string, contextToken: string | undefined, status: number): Promise<void> {
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;
    try {
      await this.client.sendTyping({ ilink_user_id: userId, typing_ticket: ticket, status });
    } catch {
      // 输入状态失败不影响主流程
    }
  }

  /** 入口：单条消息入队（斜杠命令跳过队列直接处理） */
  handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== MessageType.USER) return Promise.resolve();
    const incoming = parseIncomingMessage(msg);
    const from = incoming.fromUserId;
    const key = incoming.sessionId || from;
    const contextToken = incoming.contextToken;

    // 1. 过滤私聊白名单
    if (getAllowUsers().length > 0 && !getAllowUsers().includes(from)) {
      logger.info(`[bridge] [${this.pi.accountId}] 拦截非白名单用户消息 from=${from}`);
      return Promise.resolve();
    }
    // 持久化 context_token
    if (contextToken) this.contextStore.setContextToken(from, contextToken);

    // 2. 斜杠命令：立即 flush 同 key 的队列 + 直接处理当前消息（不等待窗口）
    if (incoming.text?.trimStart().startsWith("/")) {
      this._flushPending(key);
      return this._processSlash(incoming.text.trim(), from, key, contextToken);
    }

    // 3. 普通消息：入队 + 重置 timer
    const list = this._pendingMessages.get(key) ?? [];
    list.push(msg);
    this._pendingMessages.set(key, list);
    const prev = this._pendingTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => this._flushPending(key), this._batchDelayMs);
    this._pendingTimers.set(key, timer);
    return Promise.resolve();
  }

  /** 立即处理一条斜杠命令（不等待批量窗口）
   * 已知命令：直接回复结果
   * 未知命令：透传给 pi 处理（支持第三方插件注册的斜杠命令，如 /vision）
   */
  private async _processSlash(text: string, from: string, key: string, contextToken?: string): Promise<void> {
    const slashReply = await this.slash.handle(text, { key });
    if (slashReply !== null) {
      // 已知命令：直接回复
      logger.info(`[cmd] ${from}: ${text}`);
      for (const chunk of chunkText(slashReply)) {
        await this.client.sendMessage(buildTextMessage(chunk, { to: from, contextToken }));
      }
      return;
    }
    // 未知命令：透传给 pi 处理（第三方插件命令如 /vision 会在这里生效）
    logger.info(`[cmd] ${from}: ${text} (透传给 pi)`);
    await this._processPiInput(text, [], from, key, contextToken);
  }

  /** 处理来自 pi 的文本输入（含可选图片），统一入口 */
  private async _processPiInput(
    text: string,
    images: Array<{ mimeType: string; data: string }>,
    from: string,
    key: string,
    contextToken?: string,
  ): Promise<void> {
    if (!text.trim() && images.length === 0) return;
    
    let promptText = text.trim();
    if (!promptText && images.length > 0) {
      // 纯图片消息：不附加文字，直接交给 vision-tool
      promptText = "";
    }
    
    logger.info(
      `[in] ${from}: ${promptText.slice(0, 80)}${images.length ? `（+${images.length} 张图片）` : ""}`,
    );

    await this.sendTypingSafe(from, contextToken, TypingStatus.TYPING);

    const replyContext = this._makeReplyContext(from, contextToken);

    let reply = "";
    try {
      reply = await this.pi.chat(key, promptText, { images, replyContext });
    } catch (err) {
      logger.error(`[pi] 处理失败: ${String(err)}`);
      try {
        const detail = err instanceof Error ? err.message : String(err);
        const errText = `⚠️ 处理失败：${detail.slice(0, 300)}\n可发 /new 重置会话后重试。`;
        for (const chunk of chunkText(errText)) {
          await this.client.sendMessage(buildTextMessage(chunk, { to: from, contextToken }));
        }
      } catch (sendErr) {
        logger.error(`[bridge] 错误回复发送失败: ${String(sendErr)}`);
      }
      return;
    } finally {
      await this.sendTypingSafe(from, contextToken, TypingStatus.CANCEL);
    }

    if (!reply) {
      logger.info("[out]（空回复，跳过发送）");
      return;
    }
    logger.info(`[out] → ${from}: ${reply.length > 80 ? `${reply.slice(0, 80)}…` : reply}`);
    for (const chunk of chunkText(reply)) {
      await this.client.sendMessage(buildTextMessage(chunk, { to: from, contextToken }));
    }
  }

  /** 到期 flush：收集同 key 所有缓冲消息，合并后处理 */
  private async _flushPending(key: string): Promise<void> {
    const msgs = this._pendingMessages.get(key);
    this._pendingTimers.delete(key);
    this._pendingMessages.delete(key);
    if (!msgs?.length) return;
    // 按创建时间排序（seq 越大越新）
    msgs.sort((a, b) => ((b.seq ?? 0) - (a.seq ?? 0)));
    await this._processBatch(msgs);
  }

  /** 处理一批合并消息（内部逻辑提取自原 handleMessage） */
  private async _processBatch(msgs: WeixinMessage[]): Promise<void> {
    const first = msgs[0];
    const firstIncoming = parseIncomingMessage(first);
    const from = firstIncoming.fromUserId;
    const key = firstIncoming.sessionId || from;
    // context_token 用最新的（最后一条）
    const contextToken = [...msgs].reverse().find(m => m.context_token)?.context_token;

    // 合并所有 item_list，一次下载媒体
    const allItems = msgs.flatMap(m => m.item_list ?? []);
    const media = await downloadInboundMedia(allItems);

    // 合并文本：按原序（旧→新）用 \n 连接，保留每条的原始文本
    const texts = msgs.map(m => parseIncomingMessage(m).text).filter(Boolean);
    let promptText = texts.join("\n");

    if (media.notes.length) promptText = [promptText, ...media.notes].filter(Boolean).join("\n");
    // 纯图片消息不附加任何文字，直接原样交给 vision-tool
    if (!promptText.trim() && media.images.length) {
      promptText = "";
    }
    if (!promptText.trim() && !media.images.length) return;

    await this.sendTypingSafe(from, contextToken, TypingStatus.TYPING);

    // 设置用户 key（用于 cron 工具回发消息）
    this.pi.setUserKey(key, from, contextToken);

    logger.info(
      `[in] ${from}: ${promptText.slice(0, 80)}${media.images.length ? `（+${media.images.length} 张图片）` : ""}${msgs.length > 1 ? `（合并 ${msgs.length} 条）` : ""}`,
    );

    const replyContext = this._makeReplyContext(from, contextToken);

    await this._processPiInput(promptText, media.images, from, key, contextToken);
  }

  /** 构建 replyContext：支持 sendFile（统一 weixin_send 通道）和 sendImage（兼容别名） */
  private _makeReplyContext(from: string, contextToken?: string): ReplyContext {
    return {
      sendFile: async (path: string, kind?: SendableKind) => {
        const k = kind ?? "file";
        const fileName = basename(path);
        if (k === "image") {
          const uploaded = await uploadImage(this.client, path, from);
          await this.client.sendMessage(buildImageMessage(uploaded, { to: from, contextToken }));
        } else if (k === "video") {
          const uploaded = await uploadVideo(this.client, path, from);
          await this.client.sendMessage(buildVideoMessage(uploaded, { to: from, contextToken }));
        } else {
          const uploaded = await uploadFile(this.client, path, from);
          await this.client.sendMessage(buildFileMessage(uploaded, fileName, { to: from, contextToken }));
        }
      },
      sendImage: async (path: string) => {
        const uploaded = await uploadImage(this.client, path, from);
        await this.client.sendMessage(buildImageMessage(uploaded, { to: from, contextToken }));
      },
    };
  }
}
