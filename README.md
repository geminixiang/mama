# mama

An AI agent bot for Slack, Telegram, and Discord. Built as an extension of the `mom` package from [badlogic/pi-mono](https://github.com/badlogic/pi-mono), MIT licensed.

## Features

- **Multi-platform** — Slack, Telegram, and Discord adapters out of the box
- **Thread sessions** — each thread / reply chain gets its own isolated conversation context
- **Concurrent threads** — multiple threads in the same channel run independently
- **Sandbox execution** — run agent commands on host or inside a Docker container
- **Persistent memory** — workspace-level and channel-level `MEMORY.md` files
- **Skills** — drop custom CLI tools into `skills/` directories
- **Event system** — schedule one-shot or recurring tasks via JSON files
- **Multi-provider** — configure any provider/model supported by `pi-ai`

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
2. Add the `app_mentions:read`, `chat:write`, `files:write`, and `im:history` OAuth scopes.
3. Copy the **App-Level Token** (`xapp-…`) and **Bot Token** (`xoxb-…`).

```bash
export MOM_SLACK_APP_TOKEN=xapp-...
export MOM_SLACK_BOT_TOKEN=xoxb-...

mama [--sandbox=host|docker:<container>] <working-directory>
```

The bot responds when `@mentioned` in any channel or via DM. Each Slack thread is a separate session.

---

### Telegram

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` to create a bot and get the **Bot Token**.
2. Optionally disable privacy mode (`/setprivacy → Disable`) so the bot can read group messages without being `@mentioned`.

```bash
export MOM_TELEGRAM_BOT_TOKEN=123456:ABC-...

mama [--sandbox=host|docker:<container>] <working-directory>
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

mama [--sandbox=host|docker:<container>] <working-directory>
```

- **Server channels** — the bot responds when `@mentioned`.
- **DMs** — every message is forwarded automatically.
- **Threads** — messages inside a Discord thread share a single session.
- **Reply chains** — replying to a message continues that session.
- Say `stop` or `/stop` to cancel a running task.

---

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--sandbox=host` | ✓ | Run commands directly on host |
| `--sandbox=docker:<name>` | | Run commands inside a Docker container |
| `--download <channel-id>` | | Download channel history to stdout and exit (Slack only) |

### Download channel history (Slack)

```bash
mama --download C0123456789
```

## Configuration

Create `settings.json` in your working directory to override defaults:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "thinkingLevel": "off",
  "sessionScope": "thread"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | `anthropic` | AI provider (env: `MOM_AI_PROVIDER`) |
| `model` | `claude-sonnet-4-5` | Model name (env: `MOM_AI_MODEL`) |
| `thinkingLevel` | `off` | `off` / `low` / `medium` / `high` |
| `sessionScope` | `thread` | `thread` (per thread/reply chain) or `channel` |

## Working Directory Layout

```
<working-directory>/
├── settings.json          # AI provider/model config
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
        └── <thread-ts>/
            └── context.jsonl   # LLM conversation context
```

## Docker Sandbox

```bash
# Create a container (mount your working directory to /workspace)
docker run -d --name mama-sandbox \
  -v /path/to/workspace:/workspace \
  alpine:latest sleep infinity

# Start mama with Docker sandbox
mama --sandbox=docker:mama-sandbox /path/to/workspace
```

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

## License

MIT — see [LICENSE](LICENSE).

Based on [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner, extended from the `mom` package.
