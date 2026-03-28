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
- **Per-user Google OAuth** — each Slack user authorises their own Google account once; the agent uses their identity for GCP / GDC operations
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
3. Enable the **Home Tab**:
   - **App Home → Show Tabs** — toggle **Home Tab** on
   - **App Home → Agents & AI Apps** — toggle **Agent or Assistant** on
   - **Event Subscriptions → Subscribe to bot events** — add `app_home_opened`
4. Copy the **App-Level Token** (`xapp-…`) and **Bot Token** (`xoxb-…`).

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

| Option                    | Default | Description                                              |
| ------------------------- | ------- | -------------------------------------------------------- |
| `--sandbox=host`          | ✓       | Run commands directly on host                            |
| `--sandbox=docker:<name>` |         | Run commands inside a Docker container                   |
| `--download <channel-id>` |         | Download channel history to stdout and exit (Slack only) |

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
  "sessionScope": "thread",
  "logFormat": "console",
  "logLevel": "info"
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

---

## Google OAuth — per-user GCP authentication

This feature lets each Slack user authorise their own Google account **once**. After that, the agent can run `gdcloud` / GCP API calls **as that user** rather than as the bot's service account.

### Architecture

```
[ First-time setup — once per user ]

User sends "auth" in Slack
  → Bot generates a Google consent URL and replies
  → User clicks the link, completes the consent screen
  → Google redirects to /oauth/callback on the mama server
  → Server exchanges the code for a refresh_token
  → refresh_token is stored in GCP Secret Manager
     key: gdc-sandbox-token-{slack_user_id}

[ Every subsequent command ]

User sends a command in Slack
  → Agent fetches the user's access_token via
    GET http://localhost:PORT/api/token/{slack_user_id}
    (auto-refreshes from Secret Manager when expired)
  → Agent runs: CLOUDSDK_AUTH_ACCESS_TOKEN=<token> gdcloud ...
```

### Prerequisites

| Requirement | Details |
|---|---|
| GCP project | Set `GOOGLE_CLOUD_PROJECT` |
| Secret Manager API | Enable `secretmanager.googleapis.com` in your project |
| Service account | Needs `roles/secretmanager.admin` (or a custom role with `secretmanager.secrets.*` permissions) |
| OAuth 2.0 client | Create in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — **Web application** type |
| Public HTTPS URL | The redirect URI must be reachable from users' browsers (use Cloud Run, a load balancer, or ngrok for testing) |

### Step-by-step setup

#### 1 — Enable APIs

```bash
gcloud services enable secretmanager.googleapis.com --project=YOUR_PROJECT
gcloud services enable oauth2.googleapis.com --project=YOUR_PROJECT
```

#### 2 — Create an OAuth 2.0 client

1. Open **APIs & Services → Credentials** in Google Cloud Console.
2. Click **Create Credentials → OAuth client ID**.
3. Choose **Web application**.
4. Add your redirect URI, e.g. `https://mama.example.com/oauth/callback`.
5. Download or copy the **Client ID** and **Client Secret**.

#### 3 — Grant Secret Manager permissions to the mama service account

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:mama-sa@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.admin"
```

#### 4 — Set environment variables

```bash
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT
export GOOGLE_OAUTH_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
export GOOGLE_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET
export GOOGLE_OAUTH_REDIRECT_URI=https://mama.example.com/oauth/callback
export GOOGLE_OAUTH_PORT=8080          # optional, default: 8080
```

#### 5 — Expose the callback port

The mama process listens on `GOOGLE_OAUTH_PORT` (default **8080**). Make sure this port is reachable from the public internet (or your internal network) at the domain you registered as the redirect URI.

**Cloud Run example** — add the port to the container and use the service URL as the redirect URI:

```yaml
# service.yaml (excerpt)
spec:
  template:
    spec:
      containers:
        - image: gcr.io/YOUR_PROJECT/mama
          ports:
            - containerPort: 8080   # Slack Socket Mode (no inbound port needed)
            - containerPort: 8080   # OAuth callback
          env:
            - name: GOOGLE_OAUTH_PORT
              value: "8080"
```

**Local testing** — use ngrok:

```bash
ngrok http 8080
# Use the ngrok HTTPS URL as GOOGLE_OAUTH_REDIRECT_URI
```

### User workflow

Once deployed, users interact with the bot via Slack:

```
# Authorise (one-time):
@mama auth
  → Bot replies with a Google consent URL (valid for 10 minutes)
  → Click the link → authorise → see "✓ Authorised as you@company.com"

# Remove authorisation:
@mama revoke
```

### Using the token in agent commands

The OAuth server exposes a **localhost-only** token endpoint:

```
GET http://localhost:PORT/api/token/{slack_user_id}
```

- Returns the current access token as plain text (auto-refreshed when < 5 min remaining).
- Returns `404 no_token` if the user has never authorised.
- Only accepts connections from `127.0.0.1` / `::1` — safe to call from bash.

Inside a skill or the agent's bash tool:

```bash
SLACK_USER_ID="${MAMA_SLACK_USER_ID:?missing slack user id}"
TOKEN_URL="${MAMA_GOOGLE_ACCESS_TOKEN_URL:-http://127.0.0.1:8080/api/token/$SLACK_USER_ID}"
TOKEN=$(curl -sf "$TOKEN_URL")
if [ -z "$TOKEN" ] || [ "$TOKEN" = "no_token" ]; then
  echo "User has not authorised. Ask them to send 'auth' in Slack first."
  exit 1
fi

CLOUDSDK_AUTH_ACCESS_TOKEN=$TOKEN gdcloud compute instances list \
  --project=sandbox-project
```

For Slack-triggered runs, mama now injects the caller context into bash/skills:

- `MAMA_PLATFORM`
- `MAMA_USER_ID`
- `MAMA_CHANNEL_ID`
- `MAMA_THREAD_TS` (when in thread)
- `MAMA_SLACK_USER_ID` (Slack only)
- `MAMA_GOOGLE_TOKEN_BASE_URL` / `MAMA_GOOGLE_ACCESS_TOKEN_URL` when Google OAuth is enabled

In Docker sandbox mode, `MAMA_GOOGLE_ACCESS_TOKEN_URL` automatically uses `host.docker.internal` instead of `localhost`, so the container can still fetch the caller's token from the mama process running on the host.

### Secret storage layout in Secret Manager

| Secret name | Content |
|---|---|
| `gdc-sandbox-token-{slack_user_id}` | JSON: `{ refresh_token, access_token, expires_at, email }` |

Each new authorisation adds a new **version** to the existing secret (previous versions are retained by GCP for audit purposes).

### Security notes

- The token endpoint (`/api/token/…`) rejects all non-localhost connections.
- Refresh tokens are never logged or included in Slack messages.
- Users can revoke access at any time with `@mama revoke` (deletes the secret).
- You can also revoke from Google at <https://myaccount.google.com/permissions>.

---

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
