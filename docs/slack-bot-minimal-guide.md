# Slack Bot Minimal Setup Guide

This guide lists the minimum Slack app settings needed to run `mama` over Socket Mode.

## 1. Create the Slack app

1. Open <https://api.slack.com/apps>.
2. Click **Create New App**.
3. Choose **From scratch**.
4. Pick an app name, for example `mama`, and select your workspace.

## 2. Enable Socket Mode

1. Go to **Settings → Socket Mode**.
2. Turn **Enable Socket Mode** on.
3. Create an app-level token with the `connections:write` scope.
4. Save the token as `MAMA_SLACK_APP_TOKEN`.

The token starts with `xapp-`.

## 3. Configure bot token scopes

Go to **OAuth & Permissions → Scopes → Bot Token Scopes** and add:

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `channels:read`
- `chat:write`
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `users:read`

Then install or reinstall the app to your workspace and save the bot token as `MAMA_SLACK_BOT_TOKEN`.

The token starts with `xoxb-`.

## 4. Enable App Home and Agent mode

1. Go to **Features → App Home**.
2. Enable **Home Tab**.
3. In **Agents & AI Apps**, enable **Agent or Assistant**.

This allows Slack's native assistant thread events and working indicators to reach the bot.

## 5. Subscribe to bot events

Go to **Features → Event Subscriptions** and enable events.

Subscribe to these bot events:

- `app_home_opened`
- `app_mention`
- `assistant_thread_context_changed`
- `assistant_thread_started`
- `message.channels`
- `message.groups`
- `message.im`

## 6. Enable interactivity

Go to **Features → Interactivity & Shortcuts** and turn interactivity on.

A public request URL is not required for Socket Mode-only local development, but Slack may still ask for one in some app configurations.

## 7. Optional slash commands

You can add slash commands for common controls:

- `/pi-login` → login portal
- `/pi-new` → start a new DM session
- `/pi-session` → session viewer

Slash commands are optional because text commands also work in supported contexts.

## 8. Run mama

```bash
export MAMA_SLACK_APP_TOKEN=xapp-...
export MAMA_SLACK_BOT_TOKEN=xoxb-...

mama --state-dir ~/.mama /path/to/workspace
```

The bot responds in DMs and when mentioned in channels. Slack thread replies fork into isolated sessions using the thread timestamp as part of the session key.
