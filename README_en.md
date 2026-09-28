# pi-gateway (pi Agent Gateway)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-339933.svg)](https://nodejs.org)

**[中文](./README.md)** | English

`pi-gateway` is a versatile **AI Coding Agent Gateway Service** designed to bridge the full power of **pi** (a comprehensive coding & tool execution Agent powered by `@earendil-works/pi-coding-agent` SDK) into instant messaging (IM) apps and external clients.

By embedding the pi SDK in-process, the gateway offers unified multi-session management, historical session recovery, intelligent Cron task scheduling, precise token usage/cost auditing, and model switching. It empowers you to direct pi to inspect code, run terminal commands, and automate tasks straight from your chat interface.

> 💡 **Current Integration Status**: Phase 1 provides direct connectivity to Tencent's official **iLink protocol**, allowing full pi Agent functionality inside **WeChat ClawBot**. Support for additional IM clients (Telegram, Slack, etc.) will follow the same architecture.

---

## Architecture

```
 IM Clients (e.g., WeChat ClawBot)
             ↕  IM Protocol Layer (Direct HTTPS iLink Protocol)
┌────────────────────────────────────────────────────────┐
│                      pi-gateway                        │
│  ① Client Auth & Protocol Handshake                   │
│  ② Long-polling updates & multi-account state isolation│
│  ③ Inbound media decryption & image vision pipeline    │
│  ④ Unified session persistence & Cron engine          │
│  ⑤ Outbound media upload, batching & markdown chunking │
└────────────────────────────────────────────────────────┘
             ↕  In-Process SDK Call
   pi AgentSession (Supports Bash, Skills, MCP, etc.)
```

---

## Key Features

- 🌟 **Unified Agent Runtime**: Invokes `pi-coding-agent` SDK directly in the same process—no microservices, proxies, or bloatware.
- 👥 **Multi-Account Concurrency**: Multi-account support with isolated session mappings, context caches, and independent Cron schedulers.
- 🔄 **Session Recovery (`/resume`)**: Automatic persistence of chat history. Page through, inspect, and resume past sessions with `/resume` at any time without losing context.
- ⏰ **Smart Cron Scheduling (`/cron`)**: Schedule recurring tasks via standard crontab expressions or natural language (pi uses its built-in `cron` tool (add/list/update/remove)). Results are pushed directly back to the specified chat.
- 📊 **Usage & Cost Auditing (`/usage`)**: Real-time stats on messages, tool invocations, token breakdown (input/output/cache read), context window consumption %, and estimated API costs per session.
- 🛠️ **Slash Commands**: 11 built-in slash commands including `/new`, `/model` (list/switch models), `/skill` (load pi skills), `/mcp` (use Model Context Protocol tools), `/stop` (interrupt stuck Bash/coding tasks), `/reload` (reload configs), and `/ping`.
- 🛡️ **Security Policies**:
  - **Whitelisting** (`PI_GATEWAY_ALLOW_USERS`): Restricts access to allowed user IDs only.
  - **Outbound Sandboxing** (`PI_GATEWAY_SEND_ALLOW` / `PI_GATEWAY_SEND_DENY`): Strict path allow/deny policies for files pi attempts to send back to the client, preventing leakages of sensitive code.
- 🖥️ **Built-In Daemon**: Zero-dependency background process supervisor featuring auto-restart on crash, exponential backoff, log rotation (5MB cap), and system startup registration (Linux systemd user services).

---

## Prerequisites

1. **Node.js**: **>= 22** (required by `pi-coding-agent` SDK and undici).
2. **pi Client Setup**: `pi` configured locally with `~/.pi/agent` (the gateway reuses models, MCP servers, and credentials stored there).
3. **WeChat Requirements (if using WeChat)**: WeChat App **8.0.70+** with the **ClawBot plugin** enabled.

---

## Quick Start

### 1. One-Line Install & Run

Run directly via `npx` without manual cloning:

```bash
npx -y pi-gateway install
```

The `install` command will:
1. Walk you through **interactive path configuration** (default state directory `~/.pi-gateway`, agent workspace `~/pi-gateway-project`).
2. Display a QR code for binding (run again or use `login` to add extra accounts).
3. Launch the background **daemon** process managed by the supervisor.

### 2. Manual Local Installation

For customization or development:

```bash
git clone https://github.com/ptbsare/pi-gateway.git
cd pi-gateway
npm install

# Run in foreground for debugging
npm start
```

---

## CLI Commands

`pi-gateway` comes with a full CLI suite:

```bash
pi-gateway install     # Interactive installation (path setup + QR login + daemon start)
pi-gateway login       # Bind/add an extra account
pi-gateway start       # Start in foreground (shows real-time getUpdates logs)
pi-gateway stop        # Stop background daemon
pi-gateway status      # Show daemon status (pm2 list style table with CPU, RAM, uptime, restarts)
pi-gateway daemon      # Advanced daemon management: start/stop/status/restart/logs/install-boot/uninstall-boot
pi-gateway update      # Update to the latest version
pi-gateway uninstall   # Uninstall service and startup tasks (keeps credentials intact)
pi-gateway help        # Display help text
```

---

## Configuration & Precedence

Configuration is evaluated in the following priority:
**Environment Variables > `~/.pi-gateway/config.json` > Platform Defaults**.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PI_GATEWAY_STATE_DIR` | `~/.pi-gateway` | Directory for account credentials, session state, and daemon logs |
| `PI_GATEWAY_WORKSPACE` | `~/pi-gateway-project` | Agent workspace for reading/writing files and executing terminal commands |
| `PI_GATEWAY_MODEL` | `amax/qwen-3.8-27B` | Default model reference (must be registered in `~/.pi/agent/models.json`) |
| `PI_GATEWAY_ALLOW_USERS` | None (All allowed) | Comma/colon/semicolon-separated list of allowed user IDs for private messages |
| `PI_GATEWAY_SEND_ALLOW` | None | File send allowlist. Agent can only send files inside specified directories |
| `PI_GATEWAY_SEND_DENY` | None | File send denylist. Agent is strictly blocked from sending files from specified directories |
| `PI_GATEWAY_MSG_BATCH_MS`| `300` | Outbound message batching window (ms) to avoid single-line spam. Default: `300ms` |
| `PI_GATEWAY_HEADLESS` | Auto-detect TTY | Headless mode (`1`). Suppresses interactive QR scanning in background and waits for CLI `login` |

---

## Slash Commands (In-Chat Control)

Send messages starting with `/` in the chat to control the gateway directly. These commands are handled locally and **do not consume API tokens**:

| Command | Example | Description |
|---|---|---|
| `/help` | `/help` | Display command help |
| `/status` | `/status` | Show version, account, model, workspace, uptime, and session counts |
| `/new` | `/new` | Clear context and start a fresh session (history remains backed up on disk) |
| `/model` | `/model list` / `/model amax/qwen` | Show current model, list available models, or switch models on the fly |
| `/skill` | `/skill list` / `/skill <name>` | List available pi skills or apply a skill to the next prompt |
| `/mcp` | `/mcp list` / `/mcp <name>` | List configured MCP servers & tools or invoke MCP tools for the next prompt |
| `/usage` | `/usage` | Display message count, tool calls, token usage breakdown, and estimated cost |
| `/stop` | `/stop` | Interrupt running tasks, complex multi-step coding agent actions, or hanging terminal commands |
| `/cron` | `/cron list` / `/cron add ...` | Manage automated Cron jobs (also controllable via natural language) |
| `/resume` | `/resume` / `/resume 3` / `next` | Browse saved past sessions and restore any session instantly |
| `/reload` | `/reload` | Reload `~/.pi/agent/` configuration files (e.g. after updating `models.json`) |

---

## Linux / WSL Autostart configuration

Start on boot uses a **systemd user service** (no root required):

```bash
pi-gateway daemon install-boot     # register & enable the systemd user service
pi-gateway daemon uninstall-boot   # remove it
```

To start on boot **without a login session**, an admin must run `loginctl enable-linger <username>`.

---

## License

[MIT](./LICENSE).

The iLink protocol client (`src/ilink/`) is derived from Tencent's open-source project [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT License, Copyright (C) 2026 Tencent). See [LICENSE](./LICENSE) for details.
