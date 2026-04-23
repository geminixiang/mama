# Google Workspace CLI OAuth Setup for mama

This guide covers the server-side OAuth flow for `mama /login` when you want to provision
`googleworkspace/cli` credentials inside each user's sandbox.

This flow stores an `authorized_user` JSON file in the user's vault secret store and mounts it to:

```text
/root/.config/gws/credentials.json
```

## 1) Create a Google OAuth client for mama

Open Google Cloud Console:

- Credentials: `https://console.cloud.google.com/apis/credentials`

Create an OAuth client with these settings:

- Client type: `Web application`
- Authorized redirect URI: `<YOUR_MOM_LINK_URL>/oauth/callback`

Example:

- `MOM_LINK_URL=https://mama.example.com`
- redirect URI: `https://mama.example.com/oauth/callback`

If your app is in testing mode, also add each user under:

- OAuth consent screen -> `Test users`

Without that, Google will reject login with an access-blocked error.

## 2) Set mama environment variables

Set these in the same runtime environment that starts `mama`:

```bash
export MOM_LINK_URL="https://your-public-domain"
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<your-google-oauth-client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<your-google-oauth-client-secret>"
```

Optional: override the default scope set used by the built-in `Google Workspace CLI` login option:

```bash
export MOM_GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES="https://www.googleapis.com/auth/drive https://mail.google.com/ https://www.googleapis.com/auth/calendar"
```

If unset, mama uses a built-in multi-service scope set for common Workspace APIs.

Start or restart mama:

```bash
docker build -f docker/mama-sandbox.Dockerfile -t mama-sandbox:tools .
mama --sandbox=image:mama-sandbox:tools /path/to/workspace
```

## 3) Run `/login`

In Slack, Telegram, or Discord:

```text
/login
```

Then choose:

- `OAuth login`
- `Google Workspace CLI`

After consent succeeds, mama writes a credential file like:

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "type": "authorized_user"
}
```

That file is stored in the user's vault secret store and mounted into the sandbox at:

```text
/root/.config/gws/credentials.json
```

## Notes

- This is different from the local `gws auth login` flow documented in the `googleworkspace/cli` repo. That local flow commonly uses a desktop app client and localhost callback. mama needs a web callback because the browser returns to `MOM_LINK_URL/oauth/callback`.
- If Google does not return a `refresh_token`, revoke the app's prior consent and retry `/login`. mama requests `access_type=offline` and `prompt=consent`, but Google can still suppress refresh token reuse in some cases.
