# Google Workspace CLI OAuth Setup

這份文件說明如何設定 mama `/login` 內建的 Google Workspace CLI OAuth。

> 注意：目前 mama 會把 Google authorized_user JSON 存進 vault，並保存 target path metadata；但現有 `container` / `firecracker` runtime 尚未自動把 vault file 投影到 sandbox 內的 target path。env token 類 credential 會自動注入，file credential 的自動投影會在後續 PR 處理。

## 1. 建立 Google OAuth Client

到 Google Cloud Console：

```text
APIs & Services → Credentials → Create Credentials → OAuth client ID
```

設定：

- Application type：`Web application`
- Authorized redirect URI：`<MOM_LINK_URL>/oauth/callback`

範例：

```text
MOM_LINK_URL=https://mama.example.com
Redirect URI=https://mama.example.com/oauth/callback
```

如果 OAuth app 還在 testing mode，請把使用者加入：

```text
OAuth consent screen → Test users
```

## 2. 設定環境變數

```bash
export MOM_LINK_URL="https://mama.example.com"
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<client-secret>"
```

可選：覆蓋預設 scopes：

```bash
export MOM_GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES="https://www.googleapis.com/auth/drive https://mail.google.com/ https://www.googleapis.com/auth/calendar"
```

## 3. 使用 `/login`

在與 bot 的私訊中輸入：

```text
/login
```

打開 mama 回傳的 link，選擇 Google Workspace CLI OAuth。

成功後，mama 會把 authorized user credential 存成 vault file，例如：

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "type": "authorized_user"
}
```

預設 metadata target path 是：

```text
/root/.config/gws/credentials.json
```

## Notes

- mama 使用 web OAuth callback，因此 Google OAuth client 必須是 `Web application`，不是 desktop app。
- 如果 Google 沒有回傳 `refresh_token`，請撤銷既有 consent 後重新 `/login`。mama 會要求 `access_type=offline` 與 `prompt=consent`，但 Google 仍可能因既有授權而省略 refresh token。
- file credential 自動投影尚未完成；目前請把這份文件視為 OAuth provisioning 設定，而不是完整 gws runtime 使用教學。
