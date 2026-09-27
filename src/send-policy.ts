// 出站媒体发送目录黑白名单：防止 Agent 把指定目录（如机密文档）下的文件发到微信。
// 通过环境变量配置，目录间用冒号分隔（Windows 上建议用分号，两者都支持）：
//   PI_GATEWAY_SEND_ALLOW  白名单模式：仅允许发送列表内目录的文件（设置后 DENY 被忽略）
//   PI_GATEWAY_SEND_DENY   黑名单模式：列表内目录的文件一律拒绝
// 两条规则均未设置时不做任何限制（向后兼容）。
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** 拆分环境变量里的目录列表（兼容 : 与 ; 分隔，过滤空段） */
export function parseDirList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s))
    .map((p) => (p.endsWith(sep) ? p : p + sep)); // 统一以分隔符结尾，前缀判定不含糊
}

/** 当前生效的出站策略（从环境变量读取一次，daemon 子进程继承） */
export interface SendPolicy {
  /** 白名单目录（设置后只允许这些目录）；空数组表示未启用白名单 */
  allow: string[];
  /** 黑名单目录；空数组表示未启用黑名单 */
  deny: string[];
}

export function loadSendPolicy(env: NodeJS.ProcessEnv = process.env): SendPolicy {
  return {
    allow: parseDirList(env.PI_GATEWAY_SEND_ALLOW),
    deny: parseDirList(env.PI_GATEWAY_SEND_DENY),
  };
}

/** 判定 path 是否位于 dir 内（含 path === dir 去掉尾分隔符的情况） */
function isInside(path: string, dirWithSep: string): boolean {
  const rel = relative(dirWithSep, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface PolicyDecision {
  allowed: boolean;
  /** 拒绝原因（用于工具返回给模型与日志） */
  reason?: string;
}

/**
 * 校验待发送文件是否被策略允许：
 * - 白名单启用时：必须落在任一 allow 目录内
 * - 否则黑名单启用时：不得落在任何 deny 目录内
 * - 两者均未启用：一律允许
 */
export function checkSendPolicy(
  filePath: string,
  policy: SendPolicy = loadSendPolicy(),
): PolicyDecision {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { allowed: false, reason: `文件不存在或不是普通文件: ${abs}` };
  }
  if (policy.allow.length > 0) {
    if (policy.allow.some((d) => isInside(abs, d) || abs + sep === d)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `文件 ${abs} 不在发送白名单目录内（PI_GATEWAY_SEND_ALLOW）`,
    };
  }
  if (policy.deny.some((d) => isInside(abs, d) || abs + sep === d)) {
    return { allowed: false, reason: `文件 ${abs} 位于发送黑名单目录内（PI_GATEWAY_SEND_DENY）` };
  }
  return { allowed: true };
}
