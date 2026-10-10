import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, getAllowUsers, saveSettings } from "./config.js";
import { IlinkClient } from "./ilink/client.js";
import { loginWithQR } from "./ilink/login.js";
import { listAccounts, removeAccount, loadState, saveState } from "./account.js";
import { runInstallWizard } from "./wizard.js";
import {
  BIN_PATH,
  BRIDGE_LOG_FILE,
  daemonStatus,
  readRestartCount,
  startDaemon,
  stopDaemon,
  tailLog,
} from "./daemon/daemon.js";
import { installBootTask, uninstallBootTask } from "./daemon/boot.js";
import { runSupervisor } from "./daemon/supervisor.js";
import { procStats, renderStatusTable, type StatusRow } from "./daemon/procs.js";

// 包根目录（src 的上级）
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function printHelp(): void {
  console.log(`pi-gateway — 微信 ClawBot ↔ pi 桥接服务

用法: pi-gateway <命令>

命令:
  install         一键安装：选择保存路径 + 扫码绑定微信 + 启动后台 daemon
  login           扫码登录 / 登录额外微信账号（多账号并存，每个账号独立会话上下文）
  accounts        列出已登录的全部微信账号
  remove-account  移除指定微信账号（daemon restart 后生效）
  start           前台运行桥接服务（默认命令）
  stop            停止后台 daemon
  status          查看后台 daemon 状态
  daemon          后台 daemon 管理（见 daemon help）
  update          更新到最新版（全局安装：npm i -g 拉 npm 最新；git 安装：pull+install；npx 提示重跑）
  uninstall       卸载：停止服务、移除开机自启（保留账号凭据）
  help            显示本帮助

选项:
  install --yes   非交互安装（全部使用默认路径，不询问）

示例:
  npx -y @ptbsare/pi-gateway install
  npx -y @ptbsare/pi-gateway login
  npx -y @ptbsare/pi-gateway status
`);
}

function printDaemonHelp(): void {
  console.log(`pi-gateway daemon <子命令>

子命令:
  start            启动后台 daemon（崩溃自动重启；已运行则跳过）
  stop             停止 daemon（杀进程树并清理 PID 文件）
  status           查看运行状态与日志路径
  restart          重启 daemon
  logs [n]         查看桥接日志末尾 n 行（默认 50）
  install-boot     注册开机自启（Linux systemd 用户服务；加 --system 安装系统级服务，需 root）
  uninstall-boot   移除开机自启（加 --system 移除系统级服务）
  supervise        内部命令：supervisor 进程本体（由 daemon start 拉起，勿手动运行）

说明:
  - PID 与日志位于 ~/.pi-gateway/daemon/（或 PI_GATEWAY_STATE_DIR 下）
  - 后台模式下会话过期无法扫码：日志会提示在终端运行
    pi-gateway login 重新扫码，扫码完成后服务自动恢复
`);
}

/** 扫码登录并保存账号（多账号并存：新扫码账号追加，不覆盖已有账号），返回是否成功 */
async function login(): Promise<boolean> {
  const client = new IlinkClient(CONFIG.fixedBaseUrl);
  try {
    const state = await loginWithQR(client);
    saveState(state);
    
    // 自动将新账号添加到白名单（如果未配置则初始化）
    const currentAllowUsers = getAllowUsers();
    const userId = state.userId ?? state.accountId; // userId优先，fallback到accountId
    if (!currentAllowUsers.includes(userId)) {
      currentAllowUsers.push(userId);
      saveSettings({ allowUsers: currentAllowUsers });
      console.log(`   ✅ 已自动添加到私聊白名单（${userId}）`);
    }
    
    console.log(`\n✅ 登录成功：${state.accountId}（已追加到账号列表）`);
    return true;
  } catch (err) {
    console.error(`\n❌ 登录失败：${String(err)}`);
    return false;
  }
}

/** 列出当前已配置的所有微信账号（多账号模式） */
function listAccountIds(): void {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log("（暂无已登录账号，请运行 `pi-gateway login` 扫码绑定）");
    return;
  }
  console.log(`已登录账号（共 ${accounts.length} 个）：`);
  for (const a of accounts) console.log(`  - ${a.accountId}`);
}

/** 移除指定账号凭据（不停止 daemon，需重启生效） */
function removeAccountCli(accountId: string): void {
  const removed = removeAccount(accountId);
  if (removed) {
    console.log(`已移除账号 ${accountId}（运行 daemon restart 后生效）`);
  } else {
    console.log(`未找到账号 ${accountId}（可通过 accounts 命令查看）`);
  }
}


async function runDaemon(args: string[]): Promise<void> {
  const sub = args[0] ?? "help";
  switch (sub) {
    case "start": {
      const r = startDaemon();
      console.log(r.message);
      if (!r.ok) process.exit(1);
      break;
    }
    case "stop": {
      const r = stopDaemon();
      console.log(r.stopped ? "已停止" : "服务未在运行");
      break;
    }
    case "status": {
      await printDaemonStatus();
      break;
    }
    case "restart": {
      stopDaemon();
      const r = startDaemon();
      console.log(r.message);
      if (!r.ok) process.exit(1);
      break;
    }
    case "logs": {
      const n = Math.max(1, Number.parseInt(args[1] ?? "50", 10) || 50);
      const tail = tailLog(BRIDGE_LOG_FILE, n);
      console.log(tail || "（暂无日志）");
      break;
    }
    case "install-boot": {
      const system = args.includes("--system");
      const r = installBootTask({ system });
      console.log(r.message);
      if (!r.ok) process.exit(1);
      break;
    }
    case "uninstall-boot": {
      const system = args.includes("--system");
      const r = uninstallBootTask({ system });
      console.log(r.message);
      break;
    }
    case "supervise": {
      // supervisor 进程本体：由 daemon start 以 detached 方式拉起
      await runSupervisor();
      break;
    }
    case "help":
    case "--help":
    case "-h":
      printDaemonHelp();
      break;
    default:
      console.error(`未知 daemon 子命令: ${sub}\n`);
      printDaemonHelp();
      process.exit(1);
  }
}

async function install(args: string[]): Promise<void> {
  const assumeYes = args.includes("--yes") || args.includes("-y");
  console.log("=== pi-gateway 安装 ===\n");

  // 第 1 步：选择保存路径（交互询问；结果写入 config.json，后续进程与 daemon 子进程均能读到）
  console.log("第 1 步：选择保存路径（账号凭据 / 会话上下文 / 后台日志 / 工作目录）");
  const choice = await runInstallWizard({ assumeYes });
  if (!choice.fromDefaults) {
    // 本进程的配置常量已在启动时解析完毕，用 env（优先级最高）重执行自身，
    // 保证后续登录/daemon 子进程都生效新路径
    const r = spawnSync(process.execPath, [BIN_PATH, "install", "--yes"], {
      stdio: "inherit",
      env: {
        ...process.env,
        PI_GATEWAY_STATE_DIR: choice.stateDir,
        PI_GATEWAY_WORKSPACE: choice.workspace,
      },
    });
    process.exit(r.status ?? 1);
  }
  console.log("");

  // 第 2 步：扫码绑定微信（多账号并存）
  const accounts = listAccounts();
  if (accounts.length > 0) {
    console.log(`已有 ${accounts.length} 个账号，跳过扫码（新增账号请用 login 命令）。\n`);
  } else {
    console.log("第 2 步：扫码绑定微信");
    const ok = await login();
    if (!ok) {
      console.error("登录失败，安装中止。");
      process.exit(1);
    }
    console.log("");
  }

  // 第 3 步：后台 daemon（内置，零第三方依赖：崩溃自动重启 + 日志）
  console.log("第 3 步：启动后台 daemon");
  const d = startDaemon();
  console.log(d.message);
  if (!d.ok) {
    console.error("daemon 启动失败，安装中止。");
    process.exit(1);
  }
  console.log("");
  console.log("✅ 安装完成。");
  console.log(`   - 状态目录: ${choice.stateDir}`);
  console.log(`   - pi 工作目录: ${choice.workspace}`);
  console.log("   - 服务已后台运行（pi-gateway status 查看）");
  console.log("   - 开机自启（可选）：pi-gateway daemon install-boot");
}

function uninstall(): void {
  console.log("=== 卸载 pi-gateway ===");
  const r = stopDaemon();
  console.log(r.stopped ? "已停止后台 daemon" : "daemon 未在运行");
  const boot = uninstallBootTask();
  console.log(boot.message);
  console.log(`✅ 已停止服务、移除开机自启（账号凭据保留在 ~/.pi-gateway/accounts/）`);
}

/** 更新到最新版：按安装方式分路——
 * 全局安装（npm i -g）：npm install -g @ptbsare/pi-gateway@latest（npm registry）+ 重启 daemon；
 * git 安装（克隆仓库）：git pull + npm install + 重启；
 * npx 临时安装：提示重跑 npx -y @ptbsare/pi-gateway install（npm registry，自动拉最新） */
function update(): void {
  console.log("=== 更新 pi-gateway ===\n");

  const restartDaemon = (): void => {
    console.log("\n重启服务加载新版本");
    stopDaemon();
    const r = startDaemon();
    console.log(r.message);
    console.log("\n✅ 更新完成。");
  };

  // 1) 全局安装（PKG_ROOT 位于 npm 全局目录）：从 npm registry 更新
  const globalRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).stdout.trim();
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\\?\/$/, "").toLowerCase();
  if (globalRoot && norm(PKG_ROOT).startsWith(norm(globalRoot))) {
    console.log("当前为全局安装（npm i -g），从 npm registry 更新到最新版…");
    const r = spawnSync("npm", ["install", "-g", "@ptbsare/pi-gateway@latest"], { stdio: "inherit", shell: true });
    if (r.status !== 0) {
      console.error("npm install -g 失败，更新中止。请检查网络/registry 后重试。");
      process.exit(1);
    }
    restartDaemon();
    return;
  }

  // 2) git 安装（克隆的仓库）：拉代码 + 装依赖 + 重启
  if (existsSync(join(PKG_ROOT, ".git"))) {
    console.log("第 1 步：拉取最新代码");
    const pull = spawnSync("git", ["pull"], { cwd: PKG_ROOT, stdio: "inherit", shell: true });
    if (pull.status !== 0) {
      console.error("git pull 失败，更新中止。");
      process.exit(1);
    }

    console.log("\n第 2 步：更新依赖");
    const install = spawnSync("npm", ["install"], { cwd: PKG_ROOT, stdio: "inherit", shell: true });
    if (install.status !== 0) console.error("npm install 失败，请手动检查。");

    restartDaemon();
    return;
  }

  // 3) npx 临时安装：npx 每次运行自动从 npm registry 拉最新版，重跑安装命令即可
  console.log("当前为 npx 临时安装，npx 每次运行自动从 npm 获取最新版，无需手动更新。");
  console.log("若后台服务还在跑旧版本，重新运行安装命令即可升级：");
  console.log("  npx -y @ptbsare/pi-gateway install");
}

/** 构建 daemon 状态表格（两行：supervisor + 桥接） */
async function buildStatusRows(): Promise<StatusRow[]> {
  const st = daemonStatus();
  const restarts = readRestartCount();
  const [sup, bridge] = await Promise.all([
    st.supervisorPid ? procStats(st.supervisorPid) : Promise.resolve(null),
    st.bridgePid ? procStats(st.bridgePid) : Promise.resolve(null),
  ]);
  return [
    {
      id: 0,
      name: "pi-gateway-supervisor",
      mode: "fork",
      restarts,
      online: st.running,
      pid: st.supervisorPid,
      ...(sup ?? {}),
    },
    {
      id: 1,
      name: "pi-gateway",
      mode: "fork",
      restarts,
      online: st.running && st.bridgePid !== undefined,
      pid: st.bridgePid,
      ...(bridge ?? {}),
    },
  ];
}

/** pm2 list 风格的 status 输出：表格 + pid + 日志路径 */
export async function printDaemonStatus(): Promise<void> {
  const rows = await buildStatusRows();
  console.log(renderStatusTable(rows));
  const st = daemonStatus();
  if (st.running) {
    console.log(
      `\nsupervisor pid ${st.supervisorPid}${st.bridgePid ? `，桥接 pid ${st.bridgePid}` : "（桥接进程未就绪）"}`,
    );
  } else {
    console.log("\n未运行（pi-gateway daemon start 启动）");
  }
  console.log(`桥接日志: ${BRIDGE_LOG_FILE}`);
}

export async function runCli(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  switch (command) {
    case "install":
      await install(args.slice(1));
      break;
    case "login":
      await login();
      break;
    case "start":
      // bin 包装器已处理 start；这里兜底（直接调 runCli 的场景）
      await import("./index.js");
      break;
    case "stop":
      stopDaemon();
      break;
    case "status":
      await runDaemon(["status"]);
      break;
    case "daemon":
      await runDaemon(args.slice(1));
      break;
    case "uninstall":
      uninstall();
      break;
    case "accounts":
      listAccountIds();
      break;
    case "remove-account": {
      const id = args[1];
      if (!id) {
        console.error("用法: pi-gateway remove-account <accountId>");
        break;
      }
      removeAccountCli(id);
      break;
    }
    case "update":
      update();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`未知命令: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}
