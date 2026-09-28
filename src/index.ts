import { contextFile, CONFIG, STATE_DIR } from "./config.js";
import { IlinkClient, SessionTimeoutError } from "./ilink/client.js";
import { AuthError } from "./ilink/errors.js";
import { loginWithQR, type AccountState } from "./ilink/login.js";
import { ContextStore } from "./ilink/context-store.js";
import { listAccounts, saveState, waitForAccountChange } from "./account.js";
import { PiSessionManager } from "./pi/sessions.js";
import { Bridge } from "./bridge.js";
import { logger } from "./logger/index.js";
import { startScheduler, stopScheduler } from "./cron/scheduler.js";
import { registerCronExecutor, unregisterCronExecutor, dispatchCronJob } from "./cron/handler.js";
import { buildTextMessage } from "./message/builder.js";
import { chunkText } from "./message/markdown.js";

/** 退出信号是否已触发（区分“信号导致的等待中断”与真正的致命错误） */
let shuttingDown = false;

async function doLogin(client: IlinkClient): Promise<AccountState> {
  logger.info("[main] 开始扫码登录...");
  const state = await loginWithQR(client);
  saveState(state);
  return state;
}

/** 后台模式重登：无法交互扫码，等待用户在终端跑 login 命令更新凭据后继续 */
async function waitForHeadlessLogin(
  prev: AccountState | null,
  signal: AbortSignal,
): Promise<AccountState> {
  if (prev) {
    logger.warn(
      `[main] 账号 [${prev.accountId}] 鉴权失效/过期。请在终端运行 \`pi-gateway login\` 重新扫码登录，扫码完成后服务自动恢复（后台等待中...）`
    );
  } else {
    logger.warn(
      "[main] 当前无有效账号凭据。请在终端运行 `pi-gateway login` 扫码，扫码完成后服务自动启动..."
    );
  }
  const state = await waitForAccountChange(prev, signal);
  logger.info(`[main] 检测到新账号 [${state.accountId}] 凭据已就绪，启动/恢复服务`);
  return state;
}

/** 运行一个独立的微信账号桥接服务 */
async function runAccountRunner(
  initialState: AccountState | null,
  headless: boolean,
  signal: AbortSignal
): Promise<void> {
  let state = initialState;
  const client = new IlinkClient(state?.baseUrl ?? CONFIG.fixedBaseUrl, state?.botToken);

  if (!state?.botToken) {
    state = headless
      ? await waitForHeadlessLogin(null, signal)
      : await doLogin(client);
  } else {
    logger.info(`[main] 正在拉起账号 [${state.accountId}] 的桥接实例`);
  }

  client.setToken(state.botToken);
  client.setBaseUrl(state.baseUrl);

  const accountId = state.accountId;
  const pi = new PiSessionManager(accountId);
  logger.info(`[main] [${accountId}] 初始化 pi 会话管理器...`);
  await pi.init();

  // 每账号隔离的 contextStore
  const contextStore = new ContextStore(contextFile(accountId));

  // 注册 cron 执行器：到期任务由该账号的 pi 执行，结果回发给发起任务的微信用户
  const cronExecutor = async (job: import("./cron/scheduler.js").CronJob) => {
    logger.info(`[cron] [${accountId}] 执行任务 ${job.id}: "${job.prompt.slice(0, 50)}"`);
    // 用该账号的 pi 会话跑 prompt（key 即发起用户的会话 key，沿用其上下文）
    const reply = await pi.chat(job.userId, job.prompt);
    job.lastResult = reply.slice(0, 500);
    // 回发结果：优先用 job.contextToken，过期则从 contextStore 刷新
    const contextToken = job.contextToken ?? contextStore.getContextToken(job.userId);
    if (reply) {
      for (const chunk of chunkText(`⏰ 定时任务结果：\n${reply}`)) {
        await client.sendMessage(buildTextMessage(chunk, { to: job.userId, contextToken }));
      }
    }
    logger.info(`[cron] [${accountId}] 任务 ${job.id} 执行完成，结果已回发 ${job.userId}`);
  };
  registerCronExecutor(accountId, cronExecutor);

  try {
    while (!signal.aborted) {
      try {
        const bridge = new Bridge(client, pi, contextStore, accountId);
        await bridge.run(signal);
        break; // 正常退出（被 abort）
      } catch (err) {
        if (signal.aborted) break;
        // 会话超时 / 鉴权失效 → 重新登录
        if (err instanceof SessionTimeoutError || err instanceof AuthError) {
          if (!headless) {
            logger.warn(`[main] [${accountId}] ${err instanceof AuthError ? "鉴权失效" : "会话已过期"}，重新扫码登录...`);
          }
          state = headless
            ? await waitForHeadlessLogin(state, signal)
            : await doLogin(client);
          client.setToken(state.botToken);
          client.setBaseUrl(state.baseUrl);
          continue;
        }
        throw err;
      }
    }
  } finally {
    unregisterCronExecutor(cronExecutor);
    pi.dispose();
    logger.info(`[main] [${accountId}] 桥接实例已完全释放并退出。`);
  }
}

async function main(): Promise<void> {
  const headless = process.env.PI_GATEWAY_HEADLESS === "1" || !process.stdout.isTTY;
  const controller = new AbortController();

  const shutdown = () => {
    shuttingDown = true;
    logger.info("[main] 收到退出信号，正在停止所有微信账号实例...");
    stopScheduler();
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 启动定时任务调度器（到期任务分发到已注册的账号执行器）
  startScheduler(dispatchCronJob);

  const accounts = listAccounts();

  if (accounts.length === 0) {
    if (headless) {
      // 没配置任何账号时，headless 挂起直到有新账号扫入
      logger.info("[main] 当前暂无已配置账号，服务已进入 headless 侦听模式...");
      const state = await waitForHeadlessLogin(null, controller.signal);
      if (!controller.signal.aborted) {
        await runAccountRunner(state, headless, controller.signal);
      }
    } else {
      // 交互式前台：没有账号直接引导扫码登录一个
      const state = await runAccountRunner(null, headless, controller.signal);
    }
  } else {
    logger.info(`[main] 检测到已配置 ${accounts.length} 个账号，开始多实例并行启动`);
    // 并行拉起所有已配置的账号
    const promises = accounts.map((state) =>
      runAccountRunner(state, headless, controller.signal).catch((err) => {
        logger.error(`[main] [${state.accountId}] 实例运行遭遇严重错误崩溃: ${String(err)}`);
      })
    );
    await Promise.all(promises);
  }
}

main().catch((err) => {
  if (shuttingDown) return;
  logger.error(`[main] 致命错误: ${String(err)}`);
  process.exit(1);
});
