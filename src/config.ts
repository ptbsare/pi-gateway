import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** iLink-App-ClientVersion 编码：0x00MMNNPP（major<<16 | minor<<8 | patch） */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

// 与官方 @tencent-weixin/openclaw-weixin 保持一致的协议标识，确保服务端兼容
const CHANNEL_VERSION = "2.4.6";

/**
 * 引导目录：固定为 ~/.pi-gateway，存放 config.json（安装向导写入）。
 * 即使状态目录被自定义到别处，配置仍可被发现。
 */
export const BOOTSTRAP_DIR = join(homedir(), ".pi-gateway");
/** 安装向导写入的持久化配置 */
export const CONFIG_FILE = join(BOOTSTRAP_DIR, "config.json");

export interface BridgeSettings {
  stateDir?: string;
  workspace?: string;
  /** 默认模型引用（provider/modelId），由 /model 命令设置 */
  model?: string;
  /** 私聊白名单（微信用户 ID 列表） */
  allowUsers?: string[];
}

/** 读取安装向导写入的 config.json（不存在或损坏时回退默认，不抛错） */
export function loadSettings(): BridgeSettings {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as BridgeSettings;
  } catch {
    return {};
  }
}

const settings = loadSettings();

/** 内置默认模型（用户 pi 配置中已注册的 amax 网关上的 Qwen3.8-27B） */
export const DEFAULT_MODEL_REF = "amax/qwen-3.8-27B";
/** 模型引用：环境变量 > config.json > 内置默认 */
export const MODEL_REF =
  process.env.PI_GATEWAY_MODEL || settings.model || DEFAULT_MODEL_REF;

/** 合并写入 config.json（保留其他字段；值为 undefined 表示删除该字段） */
export function saveSettings(patch: BridgeSettings): void {
  const next: BridgeSettings = { ...loadSettings() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k as keyof BridgeSettings];
    else next[k as keyof BridgeSettings] = v;
  }
  mkdirSync(BOOTSTRAP_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
}

/** 桥接版本（读包根 package.json；dist 与 src 下均指向仓库/包根） */
export const BRIDGE_VERSION: string = (() => {
  try {
    const pkg = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "dev";
  } catch {
    return "dev";
  }
})();

/** 默认 pi 工作目录：Windows 保留既有 D:\pi_gateway_project，其他平台落到用户主目录 */
export function defaultWorkspace(): string {
  return process.platform === "win32" ? "D:\\pi_gateway_project" : join(homedir(), "pi-gateway-project");
}

/** 路径解析：~ 展开 + 相对路径转绝对（安装向导输入用） */
export function resolveUserPath(input: string): string {
  let p = input.trim();
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
  return resolve(p);
}

/** 状态目录（账号凭据、工作区）：环境变量 > config.json > 引导目录 */
export const STATE_DIR = process.env.PI_GATEWAY_STATE_DIR || settings.stateDir || BOOTSTRAP_DIR;
/** 多账号凭据目录：每个扫码账号一个 <accountId>.json */
export const ACCOUNTS_DIR = join(STATE_DIR, "accounts");
/** 旧版单账号凭据文件（存在且未迁移时自动导入多账号目录） */
export const LEGACY_ACCOUNT_FILE = join(STATE_DIR, "account.json");
/** 会话持久化映射（微信 key → pi 会话文件路径），按账号分文件 */
export function sessionMapFile(accountId: string): string {
  return join(STATE_DIR, `session-map.${accountId}.json`);
}
/** 每账号会话上下文缓存（context_token / typing ticket），按账号分文件 */
export function contextFile(accountId: string): string {
  return join(STATE_DIR, `context.${accountId}.json`);
}

/** 私聊白名单（PI_GATEWAY_ALLOW_USERS，逗号/分号/冒号分隔的微信用户 ID）；
 * 未设置时不限制（向后兼容）；设置后仅列表内用户可触发对话 */
export function parseAllowUsers(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(/[,;:，；：]/).map((s) => s.trim()).filter(Boolean);
}
export function getAllowUsers(): string[] {
  const s = loadSettings();
  return process.env.PI_GATEWAY_ALLOW_USERS !== undefined
    ? parseAllowUsers(process.env.PI_GATEWAY_ALLOW_USERS)
    : s.allowUsers ?? [];
}

/** pi 会话的工作目录（Agent 在此目录读写文件）：环境变量 > config.json > 平台默认 */
export const WORKSPACE = process.env.PI_GATEWAY_WORKSPACE || settings.workspace || defaultWorkspace();
/** 账号凭据持久化文件（旧版单账号格式；多账号见 ACCOUNTS_DIR） */
export const ACCOUNT_FILE = join(STATE_DIR, "account.json");

export const CONFIG = {
  /** iLink 固定接入域名（扫码登录始终用它） */
  fixedBaseUrl: "https://ilinkai.weixin.qq.com",
  /** 微信 CDN 域名（媒体上传/下载） */
  cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
  ilinkAppId: "bot",
  ilinkAppClientVersion: buildClientVersion(CHANNEL_VERSION),
  channelVersion: CHANNEL_VERSION,
  /** 自我声明的上游身份（类似 User-Agent，仅用于观测） */
  botAgent: "pi-gateway/1.0.0",
  /** ilink bot_type（当前渠道构建固定为 3） */
  botType: "3",
  /** getUpdates 长轮询超时 */
  longPollTimeoutMs: 35_000,
  /** 普通接口超时（sendMessage 等） */
  apiTimeoutMs: 15_000,
  /** 扫码状态长轮询超时 */
  qrPollTimeoutMs: 35_000,
  /** 登录总超时 */
  loginTimeoutMs: 480_000,
};
