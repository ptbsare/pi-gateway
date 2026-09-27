# pi-gateway (pi Agent Gateway)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-339933.svg)](https://nodejs.org)

**中文** | [English](./README_en.md)

`pi-gateway` 是一个通用的 **AI Coding Agent 网关服务**，旨在将 **pi**（基于 `@earendil-works/pi-coding-agent` SDK 的全能型编码/工具 Agent）的强大能力桥接到各种即时通讯软件 (IM) 与外部客户端。

通过同进程嵌入 pi SDK，网关提供了统一的多会话管理、历史会话恢复、智能定时任务（Cron）、用量/成本审计以及模型管理等高级能力，让您能够在聊天界面直接调度 pi 来协助您阅读代码、执行命令和运行自动化任务。

> 💡 **当前集成状态**：第一阶段已完美直连腾讯官方 **iLink 协议**，支持在**微信 ClawBot** 中使用 pi 编码 Agent。未来将基于该架构逐步扩展至 Telegram、Slack 等更多客户端。

---

## 架构

```
 聊天客户端 (如 微信 ClawBot 等)
             ↕  IM 协议层 (当前支持微信 iLink 协议直连)
┌───────────────────────────────────────┐
│              pi-gateway               │
│  ① 客户端接入与鉴权                     │
│  ② 长轮询收消息与多账号状态隔离           │
│  ③ 入站媒体解密与图片视觉流处理           │
│  ④ 统一会话持久化与 Cron 智能调度引擎    │
│  ⑤ 出站媒体上传、消息合并与分块发送        │
└───────────────────────────────────────┘
             ↕  同进程调用（SDK）
   pi AgentSession (支持 Bash, Skills, MCP 等)
```

---

## 核心功能

- 🌟 **统一的 Agent 运行时**：同进程直接调用 `pi-coding-agent` 的 SDK，无需任何外部中间件或微服务。
- 👥 **多账号并行与隔离**：支持多账号同时在线，每个账号拥有完全独立的会话映射、上下文缓存和定时任务调度器。
- 🔄 **历史会话恢复 (`/resume`)**：自动保存历史对话。通过 `/resume` 可随时翻页查看、检索并一键恢复到历史任一会话，无需担心上下文丢失。
- ⏰ **智能定时任务 (`/cron`)**：支持使用 crontab 表达式或通过自然语言对话（Agent 会自动调用 `cron_add` 工具）配置定时任务。执行结果将准时推送回对应的聊天界面。
- 📊 **精准用量与成本审计 (`/usage`)**：实时统计会话级别消息数、工具调用次数、输入/输出 Token、上下文窗口占比以及 API 成本。在流式响应不支持 Usage 时，会自动提供本地预估并明确说明。
- 🛠️ **多级控制斜杠命令**：内置 11 个高级斜杠控制命令，包括 `/new`、`/model` (切换/列出模型)、`/skill` (加载 pi 技能)、`/mcp` (调用 Model Context Protocol 服务工具)、`/stop` (一键中断死循环或重度 Bash 任务)、`/reload` (重载模型) 等。
- 🛡️ **安全防护策略**：
  - **私聊白名单** (`PI_GATEWAY_ALLOW_USERS`)：仅限授权用户触发对话，杜绝未授权人员滥用机器算力。
  - **出站沙箱策略** (`PI_GATEWAY_SEND_ALLOW` / `PI_GATEWAY_SEND_DENY`)：通过物理路径白名单与黑名单，限制 Agent 可以发往客户端的文件路径，严防敏感数据泄露。
- 🖥️ **内置 Daemon**：零第三方依赖的轻量级后台守护进程，支持崩溃自动重启、指数级退避（Backoff）、日志按大小（5MB）自动滚动轮转以及开机自启动（Linux systemd 用户服务）。

---

## 前置条件

1. **Node.js**: **>= 22**（由于 `pi-coding-agent` SDK 及 undici 的底层依赖要求）。
2. **pi 客户端**: 已完成 `pi` 的基础配置，本机存在 `~/.pi/agent`（网关会自动复用该目录下的模型注册、MCP 以及凭证等配置）。
3. **微信接入要求（如使用微信客户端）**：微信 App 版本 **8.0.70+**，且账号已开通 **ClawBot 插件**。

---

## 快速开始

### 1. 一键安装并运行

支持直接使用 `npx` 运行发布在 npm 上的包，无须手动克隆编译：

```bash
npx -y pi-gateway install
```

`install` 命令将会：
1. 引导您**交互式配置目录**（默认状态目录 `~/.pi-gateway`，默认 Agent 工作区 `~/pi-gateway-project`，会进行写入探测校验权限）。
2. 打印登录二维码供您扫码绑定（多账号可重跑该命令或 `login` 额外追加）。
3. 启动后台 **daemon** 守护服务（由 supervisor 进程在后台常驻运行）。

### 2. 本地手动安装

如果您想自定义修改源码或进行开发，可本地克隆本仓库：

```bash
git clone https://github.com/ptbsare/pi-gateway.git
cd pi-gateway
npm install

# 前台调试运行
npm start
```

---

## 常用命令

`pi-gateway` 提供了一套完备的 CLI 控制命令：

```bash
pi-gateway install     # 交互式一键安装（路径向导 + 扫码绑定 + 后台守护）
pi-gateway login       # 追加绑定一个新账号
pi-gateway start       # 在前台启动服务（用于调试，展示 getUpdates 日志）
pi-gateway stop        # 优雅停止后台守护 daemon 进程
pi-gateway status      # 查看后台守护状态 (pm2 list 风格控制台表格，显示重启次数、内存、CPU、时长)
pi-gateway daemon      # daemon 高级管理：start/stop/status/restart/logs/install-boot/uninstall-boot
pi-gateway update      # 自动更新至最新版本
pi-gateway uninstall   # 卸载：停止后台服务并清理开机自启，保留凭据
pi-gateway help        # 显示本帮助
```

---

## 配置与优先级

网关采用三级配置加载，优先级由高到低为：
**环境变量 > `~/.pi-gateway/config.json`（由安装向导写入）> 平台内置默认值**。

### 环境变量

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PI_GATEWAY_STATE_DIR` | `~/.pi-gateway` | 状态目录（账号凭据、会话历史、运行日志存放处） |
| `PI_GATEWAY_WORKSPACE` | `~/pi-gateway-project` | Agent 工作的物理路径（Agent 在该目录下读写文件、运行 Bash 任务） |
| `PI_GATEWAY_MODEL` | `amax/qwen-3.8-27B` | 启动网关时默认启用的模型名（需在 `~/.pi/agent/models.json` 中配置注册） |
| `PI_GATEWAY_ALLOW_USERS` | 无（空则代表全放行） | 私聊白名单限制。支持逗号/冒号/分号分隔的微信用户 ID/微信号。 |
| `PI_GATEWAY_SEND_ALLOW` | 无 | 文件发送白名单路径限制。配置后，Agent 只能向客户端发送此路径下的文件。 |
| `PI_GATEWAY_SEND_DENY` | 无 | 文件发送黑名单路径限制。命中此路径的文件一律拒绝被 Agent 发送至客户端。 |
| `PI_GATEWAY_MSG_BATCH_MS`| `300` | 出站消息最大批处理延迟 (ms)。可有效避免 Agent 产生高频零碎打字机回复，推荐 `300ms` |
| `PI_GATEWAY_HEADLESS` | 根据 TTY 自动检测 | 后台静默模式。为 `1` 时，会话超时不主动弹扫码，而是静候终端重新执行 `login` 恢复。 |

---

## 终端/聊天框内控制（斜杠命令）

在客户端对话框输入以 `/` 开头的命令可直接控制网关运行时，这些命令由网关直接本地解析，**不消耗任何 API Token**：

| 命令 | 示例 | 功能说明 |
|---|---|---|
| `/help` | `/help` | 显示完整的可用命令帮助信息 |
| `/status` | `/status` | 返回当前版本、登录账号、默认模型、Agent 工作目录、运行时长和活跃会话数 |
| `/new` | `/new` | 抛弃当前会话历史，开始一次全新的干净对话（不影响磁盘上的历史备份） |
| `/model` | `/model list` / `/model amax/qwen` | `/model` 查看当前模型；`list` 列出可用模型；输入新模型名即可无缝切换 |
| `/skill` | `/skill list` / `/skill <名称>` | 列出 pi 支持的技能清单，或指定下一条消息使用对应的 Skill 引擎处理 |
| `/mcp` | `/mcp list` / `/mcp <名称>` | 列出已配置的 Model Context Protocol 服务器及工具，或下达 MCP 工具调用指令 |
| `/usage` | `/usage` | 统计并返回当前会话的消息数、工具调用次数、Token 输入/输出成本比例 |
| `/stop` | `/stop` | 一键中止当前会话正在执行的多步骤复杂 Coding 任务或陷入死循环的 Bash 任务 |
| `/cron` | `/cron list` / `/cron add ...` | 定时任务的高级配置。可手动管理，也可通过自然语言让 Agent 全自动调用 |
| `/resume` | `/resume` / `/resume 3` / `next` | 翻页浏览当前账号关联的所有历史保存会话，输入数字可秒级恢复现场继续对话 |
| `/reload` | `/reload` | 实时重载 `~/.pi/agent/` 下的所有配置（例如您刚刚手动编辑了 `models.json`） |

---

## Linux / WSL 自启动配置

开机自启用 **systemd 用户服务**（免 root）：

```bash
pi-gateway daemon install-boot     # 注册并 enable systemd user service
pi-gateway daemon uninstall-boot   # 移除
```

如需**未登录也随开机启动**，请管理员执行 `loginctl enable-linger <用户名>`。

---

## 许可协议

本项目采用 [MIT 许可证](./LICENSE)。

其中，iLink 协议客户端（位于 `src/ilink/`）派生自腾讯开源项目 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (基于 MIT 协议，Copyright (C) 2026 Tencent)，完整的许可证与版权追溯声明请参见 [LICENSE](./LICENSE)。
