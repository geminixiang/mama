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
- **Sandbox execution** — run agent commands on host, in a shared container, in a managed per-user container, or in a Firecracker VM
- **Credential vaults** — `/login` stores credentials under `--state-dir` and injects env only into container/image/Firecracker runs
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
6. (Optional) Add **Slash Commands** such as `/pi-login` and `/pi-new` in the Slack app settings if you want dedicated commands with less naming conflict. `/pi-new` is intended for DM use only.
7. Copy the **App-Level Token** (`xapp-…`) and **Bot Token** (`xoxb-…`).

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

mama [--state-dir=~/.mama] [--sandbox=host|container:<container>|image:<image>|firecracker:<vm-id>:<path>] <working-directory>
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

mama [--state-dir=~/.mama] [--sandbox=host|container:<container>|image:<image>|firecracker:<vm-id>:<path>] <working-directory>
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

mama [--state-dir=~/.mama] [--sandbox=host|container:<container>|image:<image>|firecracker:<vm-id>:<path>] <working-directory>
```

- **Server channels** — the bot responds when `@mentioned`.
- **DMs** — every message is forwarded automatically.
- **Threads** — messages inside a Discord thread share a single session.
- **Reply chains** — replying to a message continues that session.
- Say `stop` or `/stop` to cancel a running task.

---

## Options

| Option                                 | Default   | Description                                                       |
| -------------------------------------- | --------- | ----------------------------------------------------------------- |
| `--state-dir=<dir>`                    | `~/.mama` | Store settings, credential vaults, and bindings outside workspace |
| `--sandbox=host`                       | ✓         | Run commands directly on host; vault env is not injected          |
| `--sandbox=container:<name>`           |           | Run commands in an existing shared container                      |
| `--sandbox=image:<image>`              |           | Auto-provision one Docker container per platform user             |
| `--sandbox=firecracker:<vm-id>:<path>` |           | Run commands inside a Firecracker microVM                         |
| `--download <channel-id>`              |           | Download channel history to stdout and exit (Slack only)          |

### Sandbox and Vault Semantics

- `host`: no vault env injection.
- `container:<name>`: one container maps to one shared vault key: `container-<name>`.
- `image:<image>`: mama creates one container per resolved vault/user and injects that vault's env and file mounts.
- `firecracker:*`: per-user vault routing via `bindings.json` first, then direct userId vault.
- `docker:*` is not supported; use `container:*` or `image:*`.

See [docs/sandbox.md](docs/sandbox.md) for the full sandbox/vault behavior matrix.

### Download channel history (Slack)

```bash
mama --download C0123456789
```

## `/login` Credential Onboarding

For normal deployments, set `MOM_LINK_URL` to the externally reachable base URL of the web credential onboarding flow:

```bash
export MOM_LINK_URL="https://mama.example.com"
# optional; defaults to 8181 when MOM_LINK_URL is set
export MOM_LINK_PORT=8181
```

For local-only testing, you can set `MOM_LINK_PORT` without `MOM_LINK_URL`; mama will use `http://localhost:<port>` for the onboarding link.

Users can then run `/login` in a private conversation with the bot. mama returns a 15-minute link for storing API keys or using built-in OAuth providers. `/login` is rejected in shared channels to avoid leaking onboarding links.

On Slack, you can also register native slash commands such as `/pi-login` and `/pi-new`.

- `/pi-login` in a shared channel opens a DM and continues the credential flow there.
- `/pi-new` only works in a Slack DM and resets that DM session context.

Built-in OAuth guides:

- [GitHub OAuth](docs/oauth/github.md)
- [Google Workspace CLI OAuth](docs/oauth/google-workspace.md)

Credentials are stored under `<state-dir>/vaults` (default `~/.mama/vaults`). Runtime env injection only happens in `container`, `image`, and `firecracker` modes.

## Configuration

mama loads settings from `<state-dir>/settings.json` first, then falls back to `<working-directory>/settings.json` if the state-dir file is absent. For shared bot deployments, prefer the state-dir copy:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
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
| `model`         | `claude-sonnet-4-5` | Model name (env: `MOM_AI_MODEL`)                         |
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

In `<state-dir>/settings.json` (or `<working-directory>/settings.json` as a fallback):

```json
{
  "logFormat": "json",
  "logLevel": "info"
}
```

Logs appear in Cloud Logging under **Log name: `mama`**. Console output (stdout) is unaffected and continues to work alongside Cloud Logging.

## State Directory Layout

```
<state-dir>/
├── settings.json          # Preferred provider/model/logging/Sentry config
└── vaults/
    ├── bindings.json      # Platform user -> vault mapping
    ├── vault.json         # Vault metadata
    └── <vault-id>/
        ├── env            # Injected env vars
        └── ...            # Credential files (e.g. gws.json, .ssh/)
```

## Working Directory Layout

```
<working-directory>/
├── settings.json          # Optional fallback config if <state-dir>/settings.json is absent
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

## Container Sandbox

```bash
# Create a container (mount your working directory to /workspace)
docker run -d --name mama-tools \
  -v /path/to/workspace:/workspace \
  alpine:latest sleep infinity

# Start mama with container sandbox
mama --sandbox=container:mama-tools /path/to/workspace
```

`container:mama-tools` uses vault key `container-mama-tools`. If multiple users share the same container, they share that container vault.

## Managed Per-User Container Sandbox

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mama-sandbox:tools

# Start mama with managed image sandboxes
mama --sandbox=image:ghcr.io/geminixiang/mama-sandbox:tools /path/to/workspace
```

Or build the bundled image locally:

```bash
docker build -f docker/mama-sandbox.Dockerfile -t mama-sandbox:tools .
mama --sandbox=image:mama-sandbox:tools /path/to/workspace
```

In this mode mama creates one Docker container per resolved vault/user, attaches each container to its own Docker bridge network for per-user network isolation, mounts the workspace at `/workspace`, injects vault env on execution, mounts any credential files declared in the vault, and stops idle containers automatically.

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
{"type": "immediate", "conversationId": "C0123456789", "conversationKind": "shared", "text": "New deployment finished"}

// One-shot — triggers once at a specific time
{"type": "one-shot", "conversationId": "C0123456789", "conversationKind": "shared", "text": "Daily standup reminder", "at": "2025-12-15T09:00:00+08:00"}

// Periodic — triggers on a cron schedule
{"type": "periodic", "conversationId": "C0123456789", "conversationKind": "shared", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "Asia/Taipei"}
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

| Package                         | mama Version | pi-mom Synced Version            |
| ------------------------------- | ------------ | -------------------------------- |
| `@mariozechner/pi-agent-core`   | `^0.69.0`    | ✅ Synchronized                  |
| `@mariozechner/pi-ai`           | `^0.69.0`    | ✅ Synchronized                  |
| `@mariozechner/pi-coding-agent` | `^0.69.0`    | ✅ Synchronized                  |
| `@anthropic-ai/sandbox-runtime` | `^0.0.49`    | ⚠️ Newer than original fork base |

## License

MIT — see [LICENSE](LICENSE).

**Note**: This project inherits the MIT license from pi-mom and aims to keep its contributions compatible with the upstream ecosystem.
