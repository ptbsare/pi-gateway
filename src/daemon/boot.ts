// Linux：systemd 用户服务（默认，用户登录时启动；免 root）
//        systemd 系统服务（`--system`，需 root，开机即启动）
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAllowUsers, MODEL_REF, STATE_DIR, WORKSPACE } from "../config.js";
import { BIN_PATH } from "./daemon.js";

const TASK_NAME = "pi-gateway";

// ---------- Linux：systemd 服务 ----------

const UNIT_NAME = `${TASK_NAME}.service`;
const USER_UNIT_FILE = join(homedir(), ".config", "systemd", "user", UNIT_NAME);
const SYSTEM_UNIT_FILE = "/etc/systemd/system/" + UNIT_NAME;

export interface SystemdUnitOptions {
  /** 系统服务（multi-user.target）还是用户服务（default.target） */
  system?: boolean;
  /** 固化到单元的环境变量（系统服务运行用户 HOME 不同，需显式指定状态/工作目录） */
  environment?: Array<[string, string | undefined]>;
}

/** 生成 systemd 单元内容（纯函数，便于单测）；含空格的路径加引号（systemd 按空白分词） */
export function renderSystemdUnit(
  nodePath: string,
  binPath: string,
  pidFile: string,
  opts: SystemdUnitOptions = {},
): string {
  const q = (s: string) => (/[\s"']/.test(s) ? `"${s}"` : s);
  const lines: string[] = [
    "[Unit]",
    "Description=pi-gateway background daemon",
    "After=network-online.target",
    "",
    "[Service]",
    // Type=forking：`daemon start` 拉起 supervisor 后退出，systemd 经 PIDFile 接管 supervisor
    "Type=forking",
    `ExecStart=${q(nodePath)} ${q(binPath)} daemon start`,
    `PIDFile=${q(pidFile)}`,
  ];
  for (const [key, value] of opts.environment ?? []) {
    if (value !== undefined) lines.push(`Environment=${key}=${value}`);
  }
  lines.push("", "[Install]", `WantedBy=${opts.system ? "multi-user.target" : "default.target"}`, "");
  return lines.join("\n");
}

function checkRootForSystemService(system: boolean): string | null {
  if (!system) return null;
  const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (euid !== null && euid !== 0) {
    return "安装系统服务需要 root 权限，请用 `sudo pi-gateway daemon install-boot --system` 运行。";
  }
  return null;
}

function runSystemctl(args: string[], system: boolean): { ok: boolean; output: string } {
  const fullArgs = system ? args : ["--user", ...args];
  const r = spawnSync("systemctl", fullArgs, { encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function installBootLinux(system: boolean): { ok: boolean; message: string } {
  const rootErr = checkRootForSystemService(system);
  if (rootErr) return { ok: false, message: rootErr };

  const unitFile = system ? SYSTEM_UNIT_FILE : USER_UNIT_FILE;
  // 探测 systemd 会话是否可用（WSL 未启用 systemd 时 daemon-reload 会失败）
  const probe = runSystemctl(["daemon-reload"], system);
  if (probe.output.includes("command not found") || probe.output.includes("未找到")) {
    return {
      ok: false,
      message: "未找到 systemctl（WSL 未启用 systemd 或系统不支持）。可手动运行 `pi-gateway daemon start`。",
    };
  }
  if (!probe.ok) {
    return {
      ok: false,
      message: `systemd ${system ? "系统" : "用户"}会话不可用（${probe.output || "daemon-reload 失败"}）。可手动运行 ` +
        "`pi-gateway daemon start`。",
    };
  }

  mkdirSync(dirname(unitFile), { recursive: true });
  const environment: SystemdUnitOptions["environment"] = system
    ? [
        ["PI_GATEWAY_STATE_DIR", STATE_DIR],
        ["PI_GATEWAY_WORKSPACE", WORKSPACE],
        ["PI_GATEWAY_MODEL", MODEL_REF],
        ...(getAllowUsers().length ? [["PI_GATEWAY_ALLOW_USERS", getAllowUsers().join(",")]] as Array<[string, string]> : []),
      ]
    : undefined;
  writeFileSync(
    unitFile,
    renderSystemdUnit(process.execPath, BIN_PATH, join(STATE_DIR, "daemon", "supervisor.pid"), {
      system,
      environment,
    }),
    "utf8",
  );

  runSystemctl(["daemon-reload"], system);
  const enable = runSystemctl(["enable", TASK_NAME], system);
  if (!enable.ok) {
    return { ok: false, message: `systemctl enable 失败: ${enable.output}` };
  }
  return {
    ok: true,
    message: system
      ? `已注册 systemd 系统服务 ${TASK_NAME}（开机即启动，unit: ${unitFile}）。\n   运行用户为 root，若需其他用户请在 unit 中设置 User= 并相应调整目录权限。`
      : `已注册 systemd 用户服务 ${TASK_NAME}（用户登录时启动，unit: ${unitFile}）。\n   如需未登录时也随开机启动，请管理员执行: sudo loginctl enable-linger <用户名>（或改用 --system 安装系统服务）`,
  };
}

function uninstallBootLinux(system: boolean): { ok: boolean; message: string } {
  const rootErr = checkRootForSystemService(system);
  if (rootErr) return { ok: false, message: rootErr };
  const unitFile = system ? SYSTEM_UNIT_FILE : USER_UNIT_FILE;
  runSystemctl(["disable", TASK_NAME], system); // 不 --now：只影响自启，不动正在运行的服务
  rmSync(unitFile, { force: true });
  runSystemctl(["daemon-reload"], system);
  return { ok: true, message: `已移除 systemd ${system ? "系统" : "用户"}服务 ${TASK_NAME}` };
}

// ---------- 对外入口 ----------

/** --system：安装为系统级服务 */
export function installBootTask(opts: { system?: boolean } = {}): { ok: boolean; message: string } {
  if (process.platform !== "linux") {
    return { ok: false, message: "开机自启服务当前仅支持 Linux systemd" };
  }
  return installBootLinux(!!opts.system);
}

export function uninstallBootTask(opts: { system?: boolean } = {}): { ok: boolean; message: string } {
  if (process.platform !== "linux") {
    return { ok: false, message: "开机自启服务当前仅支持 Linux systemd" };
  }
  return uninstallBootLinux(!!opts.system);
}