# mama (Multi-Agent Mischief Assistant)

[![npm version](https://img.shields.io/npm/v/@geminixiang/mama.svg)](https://www.npmjs.com/package/@geminixiang/mama)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A multi-platform AI assistant for Slack, Telegram, and Discord.

Forked from [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)'s `mom` package (MIT, by Mario Zechner) at v0.57.1. This fork adds Telegram and Discord adapters and exists to ship internally while we prepare changes to upstream.

## Features

- **Multi-platform** — Slack, Telegram, Discord adapters
- **Concurrent conversations** — Slack threads, Discord replies/threads, and Telegram reply chains run as independent sessions
- **Sandbox execution** — host, shared container, per-user managed container, Firecracker (alpha), or Cloudflare bridge (experimental)
- **Credential vaults** — `/login` stores credentials under `--state-dir` and injects env into sandbox runs
- **Web session viewer** — read-only web view of the current session via `session` / `/session`
- **Persistent memory** — workspace-level and channel-level `MEMORY.md`
- **Skills** — drop CLI tools into `skills/`
- **Events** — schedule one-shot or recurring tasks via JSON files
- **Multi-provider** — any provider/model supported by `pi-ai`

## Platform Session Model

| Platform | `sessionKey` Rule                                                                 | Notes                                                                                |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Slack    | top-level / DM: `conversationId`; thread: `conversationId:threadTs`               | thread inherits parent context at fork time only; branch changes do not merge back   |
| Discord  | DM: `channelId`; shared top-level: `channelId:messageId`; reply/thread: rooted id | replies in shared channels continue the root message session; DM replies do not fork |
| Telegram | private: `chatId`; shared top-level: `chatId:messageId`; reply chain: root reply  | no native thread model; shared sessions are inferred from reply chains               |

## Requirements

- Node.js >= 20

## Installation

```bash
npm install -g @geminixiang/mama
```

Or from source:

```bash
npm install && npm run build
```

## Quick Start

All platforms share the same CLI:

```bash
mama [--state-dir=~/.mama] [--sandbox=<mode>] <working-directory>
```

Set the platform tokens you need (you can run multiple platforms at once):

```bash
export MAMA_SLACK_APP_TOKEN=xapp-...
export MAMA_SLACK_BOT_TOKEN=xoxb-...
export MAMA_TELEGRAM_BOT_TOKEN=123456:ABC-...
export MAMA_DISCORD_BOT_TOKEN=MTI...
```

### Slack

Create a Socket Mode app with the scopes and event subscriptions listed in [docs/slack-bot-minimal-guide.md](docs/slack-bot-minimal-guide.md). The bot responds when `@mentioned` in channels and to all DMs.

### Telegram

Create a bot via [@BotFather](https://t.me/BotFather) and copy the token. The bot responds to all private messages, and to `@mention` or reply chains in groups. Say `stop` or `/stop` to cancel a running task.

### Discord

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent**, and invite the bot with `Send Messages`, `Read Message History`, `Attach Files`. The bot responds to `@mentions` in servers and to all DMs.

## Sandbox Modes

| Mode                         | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `host` (default)             | Run on host; no vault env injection                                    |
| `container:<name>`           | Run in an existing shared container; uses vault key `container-<name>` |
| `image:<image>`              | Auto-provision one Docker container per resolved vault/user            |
| `firecracker:<vm-id>:<path>` | Firecracker microVM (alpha; not recommended)                           |
| `cloudflare:<sandbox-id>`    | Cloudflare Worker bridge (experimental; no auto workspace sync)        |

Vault routing: `image`, `firecracker`, and `cloudflare` look up `bindings.json` first, then fall back to the userId vault. See [docs/sandbox.md](docs/sandbox.md) for the full matrix.

### Managed per-user containers (`image:*`)

```bash
docker pull ghcr.io/geminixiang/mama-sandbox:tools
mama --sandbox=image:ghcr.io/geminixiang/mama-sandbox:tools /path/to/workspace
```

Or build locally:

```bash
docker build -f docker/mama-sandbox.Dockerfile -t mama-sandbox:tools .
```

mama creates one container per vault, attaches each to its own bridge network, mounts the workspace at `/workspace`, injects vault env, mounts declared credential files, and stops idle containers.

### Firecracker / Cloudflare

See [docs/firecracker-setup.md](docs/firecracker-setup.md) and [examples/cloudflare-sandbox-bridge/README.md](examples/cloudflare-sandbox-bridge/README.md).

## `/login` and Web Session Viewer

```bash
export MAMA_LINK_URL="https://mama.example.com"   # public base URL
export MAMA_LINK_PORT=8181                         # optional, defaults to 8181
```

For local testing you can set just `MAMA_LINK_PORT`; mama will use `http://localhost:<port>`.

- `/login` (DM only) returns a 15-minute link to store API keys or run built-in OAuth flows ([GitHub](docs/oauth/github.md), [Google Workspace](docs/oauth/google-workspace.md)).
- `session` / `/session` (DM only) returns a read-only link showing the current session timeline.
- On Slack you can also register native commands like `/pi-login` and `/pi-new` (DM-only reset).

Credentials are stored under `<state-dir>/vaults` (default `~/.mama/vaults`). Vault env is only injected in `container`, `image`, `firecracker`, and `cloudflare` modes.

## Configuration

mama reads `<state-dir>/settings.json` (default `~/.mama/settings.json`, override via `--state-dir` or `MAMA_STATE_DIR`). Settings written via `/login` and friends are saved to the same file.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "thinkingLevel": "off",
  "logFormat": "console",
  "logLevel": "info",
  "sentryDsn": "https://examplePublicKey@o0.ingest.sentry.io/0"
}
```

| Field           | Default             | Description                                              |
| --------------- | ------------------- | -------------------------------------------------------- |
| `provider`      | `anthropic`         | AI provider (env: `MAMA_AI_PROVIDER`)                    |
| `model`         | `claude-sonnet-4-5` | Model name (env: `MAMA_AI_MODEL`)                        |
| `thinkingLevel` | `off`               | `off` / `low` / `medium` / `high`                        |
| `logFormat`     | `console`           | `console` (colored stdout) or `json` (GCP Cloud Logging) |
| `logLevel`      | `info`              | `trace` / `debug` / `info` / `warn` / `error`            |
| `sentryDsn`     | unset               | Sentry DSN; sensitive prompt/tool content is redacted    |

For GCP Cloud Logging, set `logFormat: "json"`, give the VM service account `roles/logging.logWriter`, and export `GOOGLE_CLOUD_PROJECT`. Logs land under log name `mama`.

## Layout

```
<state-dir>/
├── settings.json
└── vaults/
    ├── bindings.json          # platform user -> vault mapping
    ├── vault.json
    └── <vault-id>/
        ├── env
        └── ...                # credential files

<working-directory>/
├── MEMORY.md                  # global memory
├── SYSTEM.md                  # installed packages / env log
├── skills/                    # global skills
├── events/                    # scheduled events
└── <conversation-id>/
    ├── MEMORY.md
    ├── log.jsonl
    ├── attachments/
    ├── scratch/
    ├── skills/
    └── sessions/
```

## Events

Drop JSON files into `<working-directory>/events/`:

```json
// Immediate
{"type": "immediate", "platform": "slack", "conversationId": "C0123456789", "conversationKind": "shared", "text": "Deploy finished"}

// One-shot
{"type": "one-shot", "platform": "telegram", "conversationId": "574247312", "conversationKind": "direct", "text": "Standup", "at": "2025-12-15T09:00:00+08:00"}

// Periodic (cron)
{"type": "periodic", "platform": "discord", "conversationId": "1498975469343739948", "conversationKind": "shared", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "Asia/Taipei"}
```

## Skills

```
skills/my-tool/
├── SKILL.md      # name + description frontmatter, usage docs
└── run.sh
```

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

## Slack: Download channel history

```bash
mama --download C0123456789
```

## Development

```bash
npm run dev     # watch mode
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE). Inherits from pi-mom.
