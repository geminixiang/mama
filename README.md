# mama

[![npm version](https://img.shields.io/npm/v/@geminixiang/mama.svg)](https://www.npmjs.com/package/@geminixiang/mama)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A multi-platform AI agent bot for Slack, Telegram, and Discord — based on [pi-mom](https://github.com/badlogic/pi-mono), with the goal of merging improvements back upstream.

## 📜 Attribution & Origins

This project is a **forked and extended version** of the `mom` package from [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) by Mario Zechner, licensed under MIT.

- **Original project**: [pi-mom](https://github.com/badlogic/pi-mono/tree/main/packages/mom) (22K+ stars)
- **Base version**: forked from pi-mom v0.57.1 (synchronized with `@mariozechner/*` packages)
- **Primary motivation**: Internal services urgently needed a multi-platform bot — this fork enables rapid iteration while preparing changes to contribute back upstream

## 🎯 Positioning & Roadmap

| Aspect             | Description                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| **Current Status** | Temporary standalone fork for urgent internal deployment                       |
| **Ultimate Goal**  | Merge all improvements back into pi-mono monorepo                              |
| **Unique Value**   | Multi-platform support (Slack + Telegram + Discord) to be contributed upstream |

### Why a temporary fork?

Our internal services urgently needed a multi-platform bot, and we couldn't wait for upstream release cycles. This fork allows us to:

1. **Ship fast**: Deploy to production immediately while internal demand is high
2. **Iterate freely**: Test multi-platform adapters (Slack, Telegram, Discord) without monorepo constraints
3. **Contribute back**: All work here is intended to be merged into pi-mono — `mama` is not a replacement for `mom`

### Contribution Philosophy 🔄

> "This is not a separate product — it's a **temporary fork** for urgent internal needs, and all improvements will be contributed back to pi-mono."

We actively track the upstream `pi-mom` and plan to:

- ✅ Submit PRs for platform adapters (Telegram, Discord)
- ✅ Contribute cross-platform abstractions
- ✅ Keep dependencies synchronized with pi-mono releases
- ✅ Document what we learn from production use

---

## Features

- **Multi-platform** — Slack, Telegram, and Discord adapters out of the box
- **Persistent sessions** — session behavior is adapted per platform instead of forcing one thread model everywhere
- **Concurrent conversations** — Slack threads, Discord replies/threads, and Telegram reply chains can run independently
- **Sandbox execution** — run agent commands on host or inside a container
- **Persistent memory** — workspace-level and channel-level `MEMORY.md` files
- **Skills** — drop custom CLI tools into `skills/` directories
- **Event system** — schedule one-shot or recurring tasks via JSON files
- **Multi-provider** — configure any provider/model supported by `pi-ai`

## Platform Session Model

| Platform | User Interaction Structure                | `sessionKey` Rule                                                    | Default Session Model                                                                | Special Handling Needed | Notes                                                                                            |
| -------- | ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------ |
| Slack    | channel top-level + thread replies        | top-level: `channelId`; thread: `channelId:threadTs`                 | channel keeps one persistent session; thread forks from channel into its own session | High                    | channel -> thread inherits context via fork; thread -> channel does not merge back automatically |
| Discord  | normal messages, replies, thread channels | `channelId:threadTsOrMsgId`                                          | replies / thread channels naturally map to isolated sessions                         | Low                     | no aliasing layer needed; session identity is determined directly from the Discord event         |
| Telegram | private chats, group replies              | private chat: `chatId`; group reply chain: `chatId:replyToIdOrMsgId` | private chats use one long session; groups split by reply chain                      | Medium                  | Telegram has no native thread model; group sessions are modeled from reply chains                |

## Requirements

- Node.js >= 20
- One of the platform integrations below

## Installation

```bash
npm install -g @geminixiang/mama
```

Or run directly after cloning:

```bash
npm install
npm run build
```

---

## Quick Start

### Slack

1. Create a Slack app with **Socket Mode** enabled ([setup guide](docs/slack-bot-minimal-guide.md)).
2. Add the following **OAuth Bot Token Scopes**:
   - `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`
   - `files:read`, `files:write`, `groups:history`, `groups:read`
   - `im:history`, `im:read`, `im:write`, `users:read`
   - `assistant:write` — required for native "Thinking" status indicator
3. Enable the **Home Tab** and **Agent mode**:
   - **App Home → Show Tabs** — toggle **Home Tab** on
   - **App Home → Agents & AI Apps** — toggle **Agent or Assistant** on
4. Subscribe to **Bot Events**:
   - `app_home_opened`, `app_mention`
   - `assistant_thread_context_changed`, `assistant_thread_started`
   - `message.channels`, `message.groups`, `message.im`
5. Enable **Interactivity** (Settings → Interactivity & Shortcuts → toggle on).
6. Copy the **App-Level Token** (`xapp-…`) and **Bot Token** (`xoxb-…`).

Or import this **App Manifest** directly (Settings → App Manifest → paste JSON):

<details>
<summary>Example App Manifest</summary>

```json
{
  "display_information": {
    "name": "mama"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": false,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "mama",
      "always_online": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "assistant_thread_context_changed",
        "assistant_thread_started",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

</details>

```bash
export MOM_SLACK_APP_TOKEN=xapp-...
export MOM_SLACK_BOT_TOKEN=xoxb-...

mama [--sandbox=host|container:<container>] <working-directory>
```

The bot responds when `@mentioned` in any channel or via DM.

- **Top-level channel messages** — share one persistent channel session.
- **Thread replies** — fork from the channel session into an isolated thread session.
- **Thread memory** — inherited at fork time only; thread changes do not merge back into the channel automatically.

---

### Telegram

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` to create a bot and get the **Bot Token**.
2. Optionally disable privacy mode (`/setprivacy → Disable`) so the bot can read group messages without being `@mentioned`.

```bash
export MOM_TELEGRAM_BOT_TOKEN=123456:ABC-...

mama [--sandbox=host|container:<container>] <working-directory>
```

- **Private chats** — every message is forwarded to the bot automatically.
- **Group chats** — the bot only responds when `@mentioned` by username.
- **Reply chains** — replying to a previous message continues the same session.
- Say `stop` or `/stop` to cancel a running task.

---

### Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Under **Bot**, enable **Message Content Intent** (required to read message text).
3. Under **OAuth2 → URL Generator**, select scopes `bot` + permissions `Send Messages`, `Read Message History`, `Attach Files`. Invite the bot to your server with the generated URL.
4. Copy the **Bot Token**.

```bash
export MOM_DISCORD_BOT_TOKEN=MTI...

mama [--sandbox=host|container:<container>] <working-directory>
```

- **Server channels** — the bot responds when `@mentioned`.
- **DMs** — every message is forwarded automatically.
- **Threads** — messages inside a Discord thread share a single session.
- **Reply chains** — replying to a message continues that session.
- Say `stop` or `/stop` to cancel a running task.

---

## Options

| Option                                 | Default   | Description                                                             |
| -------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `--sandbox=host`                       | ✓         | Run commands directly on host                                           |
| `--sandbox=container:<name>`           |           | Run commands in a shared container (mama does not manage lifecycle)     |
| `--sandbox=image:<image>`              |           | Auto-provision one Docker container per platform user from an image     |
| `--sandbox=firecracker:<vm-id>:<path>` |           | Run commands inside a Firecracker microVM                               |
| `--state-dir <path>`                   | `~/.mama` | Store operator-managed settings, vaults, and bindings outside workspace |
| `--download <channel-id>`              |           | Download channel history to stdout and exit (Slack only)                |

### Container Mode Semantics

- `container:*` uses one shared container for all sessions/users. mama does not create/start/stop/delete this container.
- `image:*` creates and restarts per-user containers named from the platform/user id. mama manages this container lifecycle.
- `docker:*` is not supported; use `container:*` for a shared existing container or `image:*` for mama-managed per-user containers.

### Download channel history (Slack)

```bash
mama --download C0123456789
```

## Configuration

mama stores operator-managed configuration in `~/.mama` by default. Use `--state-dir <path>` to choose another location. Create or edit `settings.json` there:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "thinkingLevel": "off",
  "sessionScope": "thread",
  "logFormat": "console",
  "logLevel": "info",
  "sentryDsn": "https://examplePublicKey@o0.ingest.sentry.io/0"
}
```

| Field           | Default             | Description                                              |
| --------------- | ------------------- | -------------------------------------------------------- |
| `provider`      | `anthropic`         | AI provider (env: `MOM_AI_PROVIDER`)                     |
| `model`         | `claude-sonnet-4-6` | Model name (env: `MOM_AI_MODEL`)                         |
| `thinkingLevel` | `off`               | `off` / `low` / `medium` / `high`                        |
| `sessionScope`  | `thread`            | `thread` (per thread/reply chain) or `channel`           |
| `logFormat`     | `console`           | `console` (colored stdout) or `json` (GCP Cloud Logging) |
| `logLevel`      | `info`              | `trace` / `debug` / `info` / `warn` / `error`            |
| `sentryDsn`     | unset               | Sentry DSN (preferred over env `SENTRY_DSN`)             |

When `sentryDsn` is set, mama sends Sentry events with sensitive prompt/tool content redacted before upload.

### GCP Cloud Logging (Compute Engine)

Set `logFormat: "json"` to send structured logs directly to Cloud Logging via API — no Ops Agent or log file configuration needed.

**Requirements:**

1. VM service account has `roles/logging.logWriter`
2. `GOOGLE_CLOUD_PROJECT` env var is set

```bash
GOOGLE_CLOUD_PROJECT=<your-project-id> mama <working-directory>
```

`settings.json`:

```json
{
  "logFormat": "json",
  "logLevel": "info"
}
```

Logs appear in Cloud Logging under **Log name: `mama`**. Console output (stdout) is unaffected and continues to work alongside Cloud Logging.

## Working Directory Layout

```
<working-directory>/
├── MEMORY.md              # Global memory (all channels)
├── SYSTEM.md              # Installed packages / env changes log
├── skills/                # Global skills (CLI tools)
├── events/                # Scheduled event files
└── <channel-id>/
    ├── MEMORY.md          # Channel-specific memory
    ├── log.jsonl          # Full message history
    ├── attachments/       # Downloaded user files
    ├── scratch/           # Agent working directory
    ├── skills/            # Channel-specific skills
    └── sessions/
        ├── current                      # Pointer for the channel-level session
        ├── 2026-04-05T18-04-31-010Z_1d92b3ad.jsonl
        └── <thread-ts>.jsonl            # Fixed-path thread session
```

Operator-managed state lives outside the workspace:

```
<state-dir>/
├── settings.json          # AI provider/model/Sentry config
└── vaults/
    ├── vault.json         # Per-user vault routing
    └── bindings.json      # Optional platform-user to vault mapping
```

## Container Sandbox

```bash
# Create a container (mount your working directory to /workspace)
docker run -d --name mama-sandbox \
  -v /path/to/workspace:/workspace \
  alpine:latest sleep infinity

# Start mama with container sandbox
mama --sandbox=container:mama-sandbox /path/to/workspace
```

## Managed Per-User Container Sandbox

```bash
mama --sandbox=image:ubuntu:24.04 /path/to/workspace
```

In this mode mama creates one container per platform user, mounts the workspace at `/workspace`, injects that user's vault environment variables into tool execution, and stops idle containers after the configured idle window.

## Firecracker Sandbox

Firecracker provides lightweight VM isolation with the security benefits of a hypervisor. Unlike Docker containers, Firecracker runs a full Linux kernel, providing stronger isolation.

### Requirements

- SSH access to the Firecracker VM
- SSH key-based authentication configured
- Host workspace must be mounted at `/workspace` inside the VM

### Format

```
--sandbox=firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

| Parameter   | Default | Description                    |
| ----------- | ------- | ------------------------------ |
| `vm-id`     | -       | VM identifier (hostname or IP) |
| `host-path` | -       | Working directory on the host  |
| `ssh-user`  | `root`  | SSH username                   |
| `ssh-port`  | `22`    | SSH port                       |

### Examples

```bash
# Basic usage (VM at 192.168.1.100, default ssh user root:22)
mama --sandbox=firecracker:192.168.1.100:/home/user/workspace /home/user/workspace

# Custom SSH user
mama --sandbox=firecracker:192.168.1.100:/home/user/workspace:ubuntu /home/user/workspace

# Custom SSH port
mama --sandbox=firecracker:192.168.1.100:/home/user/workspace:root:2222 /home/user/workspace
```

### Setup

1. **Start a Firecracker VM** with your preferred method (fc-agent, firecracker-ctl, or manual)

2. **Configure SSH access** inside the VM:

   ```bash
   # Inside the VM - allow password-less SSH for mama
   sudo systemctl enable ssh
   sudo sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
   sudo sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
   sudo systemctl restart ssh
   ```

3. **Mount your workspace** at `/workspace` inside the VM:

   ```bash
   # Option A: 9pfs (recommended, from host)
   sudo mount -t 9p -o trans=virtio,version=9p2000.L host0 /workspace

   # Option B: NFS
   sudo mount -t nfs <host-ip>:/path/to/workspace /workspace
   ```

4. **Test SSH connectivity** from host:
   ```bash
   ssh root@192.168.1.100 "echo works"
   ```

The host path is mounted as `/workspace` inside the Firecracker VM. All bash commands will execute inside the VM.

## Events

Drop JSON files into `<working-directory>/events/` to trigger the agent:

```json
// Immediate — triggers as soon as mama sees the file
{"type": "immediate", "channelId": "C0123456789", "text": "New deployment finished"}

// One-shot — triggers once at a specific time
{"type": "one-shot", "channelId": "C0123456789", "text": "Daily standup reminder", "at": "2025-12-15T09:00:00+08:00"}

// Periodic — triggers on a cron schedule
{"type": "periodic", "channelId": "C0123456789", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "Asia/Taipei"}
```

## Skills

Create reusable CLI tools by adding a directory with a `SKILL.md`:

```
skills/
└── my-tool/
    ├── SKILL.md    # name + description frontmatter, usage docs
    └── run.sh      # the actual script
```

`SKILL.md` frontmatter:

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

## Development

```bash
npm run dev     # watch mode
npm test        # run tests
npm run build   # production build
```

## 📦 Dependencies & Versions

| Package                         | mama Version | pi-mom Synced Version         |
| ------------------------------- | ------------ | ----------------------------- |
| `@mariozechner/pi-agent-core`   | `^0.57.1`    | ✅ Synchronized               |
| `@mariozechner/pi-ai`           | `^0.57.1`    | ✅ Synchronized               |
| `@mariozechner/pi-coding-agent` | `^0.57.1`    | ✅ Synchronized               |
| `@anthropic-ai/sandbox-runtime` | `^0.0.40`    | ⚠️ Newer (pi-mom uses 0.0.16) |

## License

MIT — see [LICENSE](LICENSE).

**Note**: This project inherits the MIT license from pi-mom and aims to keep its contributions compatible with the upstream ecosystem.
