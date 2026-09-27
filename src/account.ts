import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ACCOUNTS_DIR, LEGACY_ACCOUNT_FILE } from "./config.js";
import { logger } from "./logger/index.js";
import type { AccountState } from "./ilink/login.js";

/** 读取单账号凭据文件；损坏/不可读时 warn 并返回 null */
function readAccountFile(file: string): AccountState | null {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as AccountState;
    return state?.botToken ? state : null;
  } catch (err) {
    logger.warn(`账号文件 ${file} 读取/解析失败（已跳过）：${String(err)}`);
    return null;
  }
}

/** 账号文件名 = <accountId>.json（accountId 中的路径分隔符替换为下划线，防止逃逸） */
function accountFile(accountId: string): string {
  const safe = accountId.replace(/[\\/:*?"<>|]/g, "_");
  return `${ACCOUNTS_DIR}/${safe}.json`;
}

/** 旧版单账号 account.json 自动迁移到 accounts/<id>.json（迁移成功后删除旧文件） */
function migrateLegacy(): void {
  const legacy = readAccountFile(LEGACY_ACCOUNT_FILE);
  if (!legacy) return;
  try {
    mkdirSync(ACCOUNTS_DIR, { recursive: true });
    const target = accountFile(legacy.accountId);
    if (!existsSync(target)) {
      writeFileSync(target, JSON.stringify(legacy, null, 2), "utf8");
      chmodSync(target, 0o600);
    }
    rmSync(LEGACY_ACCOUNT_FILE, { force: true });
    logger.info(`[account] 已迁移旧版 account.json → ${target}`);
  } catch (err) {
    logger.warn(`[account] 旧账号文件迁移失败（保留原文件）：${String(err)}`);
  }
}

/** POSIX 下收紧状态目录权限（凭据所在，mkdir 的 mode 受 umask 影响，需显式修正） */
export function hardenStateDir(): void {
  if (process.platform === "win32" || !existsSync(ACCOUNTS_DIR)) return;
  try {
    chmodSync(ACCOUNTS_DIR, 0o700);
  } catch {
    // 非属主等场景不阻断主流程
  }
}

/** 列出全部已登录账号（旧格式自动迁移）；按 accountId 去重 */
export function listAccounts(): AccountState[] {
  migrateLegacy();
  if (!existsSync(ACCOUNTS_DIR)) return [];
  const out = new Map<string, AccountState>();
  for (const name of readdirSync(ACCOUNTS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const state = readAccountFile(`${ACCOUNTS_DIR}/${name}`);
    if (state) out.set(state.accountId, state);
  }
  return [...out.values()];
}

/** 读取指定账号（不存在返回 null） */
export function getAccount(accountId: string): AccountState | null {
  return readAccountFile(accountFile(accountId));
}

/** 保存/覆盖一个账号凭据；原子写 + 权限收紧（0600，凭据不可被其他用户读取） */
export function saveAccount(state: AccountState): void {
  mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  const file = accountFile(state.accountId);
  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpFile, file);
  if (process.platform !== "win32") {
    hardenStateDir();
    try {
      chmodSync(file, 0o600);
    } catch {
      // 非属主等场景 chmod 失败不阻断主流程
    }
  }
}

/** 删除指定账号凭据；返回是否存在 */
export function removeAccount(accountId: string): boolean {
  const file = accountFile(accountId);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

// ---- 旧 API 兼容（login/uninstall 等单账号入口） ----

/** @deprecated 单账号兼容入口：读第一个账号 */
export function loadState(): AccountState | null {
  return listAccounts()[0] ?? null;
}

/** @deprecated 单账号兼容入口：保存（多账号请用 saveAccount） */
export function saveState(state: AccountState): void {
  saveAccount(state);
}

/**
 * 等待指定账号被重新扫码保存（后台模式重登）：
 * 轮询该账号文件，直到 botToken 与 prev 不同（prev 为 null 时任意有效账号即可）。
 * 等待期间被 abort（进程退出）则抛错，避免挂起。
 */
export async function waitForAccountChange(
  prev: AccountState | null,
  signal: AbortSignal,
  pollMs = 10_000,
): Promise<AccountState> {
  for (;;) {
    if (signal.aborted) throw new Error("等待重登期间进程已退出");
    // 轮询等待，被 abort（退出信号）时立即唤醒，不睡满 pollMs
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    if (prev) {
      const s = getAccount(prev.accountId);
      if (s?.botToken && s.botToken !== prev.botToken) return s;
    } else {
      const s = listAccounts()[0];
      if (s?.botToken) return s;
    }
  }
}
