# GitHub OAuth Setup for mama

This guide covers only three things:

1. Create a GitHub OAuth App
2. Get `Client ID` and `Client Secret`
3. Set them as environment variables for mama

## 1) Create a GitHub OAuth App

Open GitHub:

- `Settings` -> `Developer settings` -> `OAuth Apps` -> `New OAuth App`

Fill in:

- `Application name`: any name (for example: `MAMA`)
- `Homepage URL`: your public mama link domain
- `Authorization callback URL`: `<YOUR_MOM_LINK_URL>/oauth/callback`

Example:

- `MOM_LINK_URL=https://noble-attempt-tracked-asset.trycloudflare.com`
- callback URL: `https://noble-attempt-tracked-asset.trycloudflare.com/oauth/callback`

`Enable Device Flow` is not required for this flow.

## 2) Get Client ID / Client Secret

After creating the app:

- Copy `Client ID`
- Click `Generate a new client secret` and copy `Client Secret`

## 3) Set mama environment variables

Set these in the same runtime environment that starts `mama`:

```bash
export MOM_LINK_URL="https://your-public-domain"
export GITHUB_OAUTH_CLIENT_ID="<your-client-id>"
export GITHUB_OAUTH_CLIENT_SECRET="<your-client-secret>"
```

If using Telegram:

```bash
export MOM_TELEGRAM_BOT_TOKEN="<your-telegram-bot-token>"
```

Start or restart mama:

```bash
docker build -f docker/mama-sandbox.Dockerfile -t mama-sandbox:tools .
mama --sandbox=image:mama-sandbox:tools /path/to/workspace
```

Then in Telegram run:

```text
/login
```

Then choose `OAuth login` and `GitHub` on the login page.
