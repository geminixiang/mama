# Sandbox 與 Vault

這份文件說明 mama 目前支援的 sandbox 模式，以及 credential vault 在各模式下的行為。

## 支援模式

| 模式                                                        | 執行位置              | Vault env injection | Vault key 語意                            | 備註                                                           |
| ----------------------------------------------------------- | --------------------- | ------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `host`                                                      | 宿主機                | 不注入              | 可存，但執行時不用                        | 最適合本機開發；不把 vault env 放進 host process               |
| `container:<name>`                                          | 既有 Docker container | 注入                | `container-<name>`                        | one container one vault；多人共用同一 container 就共用該 vault |
| `image:<image>`                                             | mama 管理的 Docker    | 注入                | binding / direct userId / generated vault | per-user container lifecycle 由 mama 管理                      |
| `firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]` | Firecracker VM        | 注入                | binding 優先，再 fallback 到 userId vault | VM 需自行啟動，workspace 需在 VM 內掛到 `/workspace`           |

`docker:*` 不是可用模式；請改用 `container:*` 或 `image:*`。

---

## State directory 與 vault 位置

state directory 預設是：

```text
~/.mama/
```

其中重要內容包含：

```text
~/.mama/
├── settings.json
└── vaults/
    ├── bindings.json
    ├── vault.json
    └── <vault-id>/
```

也可以用 `--state-dir` 指定：

```bash
mama --state-dir=/secure/mama-state --sandbox=container:mama-tools /path/to/workspace
```

此時 credential 會在：

```text
/secure/mama-state/vaults/
```

而設定檔的優先順序是：

1. `<state-dir>/settings.json`
2. `<working-directory>/settings.json`（只有前者不存在時才 fallback）

啟動時 mama 會拒絕使用 world-writable 或非目前使用者擁有的 `--state-dir`，避免本機其他使用者竄改 settings、vault 或 binding。

---

## Vault 內容

每個 vault entry 可包含：

- `env` file：`KEY=value` 形式的環境變數
- file credentials：例如 `gws.json`、`.ssh/config`
- mount metadata：記錄 file credential 理想上應該投影到 sandbox 內哪個 target path

範例：

```text
~/.mama/vaults/
├── vault.json
├── bindings.json
└── container-mama-tools/
    ├── env
    └── gws.json
```

`env` 範例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

---

## `host`

```bash
mama --sandbox=host /path/to/workspace
```

特性：

- commands 直接在宿主機執行
- 不注入 vault env
- `/login` 仍可把 credential 存進 `state-dir/vaults`

適合：

- 本機開發
- 不希望 mama 把 vault credential 放進 host command process

---

## `container:<name>`

```bash
docker run -d --name mama-tools \
  -v /path/to/workspace:/workspace \
  alpine:latest sleep infinity

mama --sandbox=container:mama-tools /path/to/workspace
```

特性：

- mama 使用 `docker exec` 在既有 container 中執行 command
- container 內 workspace 預期是 `/workspace`
- vault key 是：

```text
container-<name>
```

例如：

```bash
--sandbox=container:mama-tools
```

會使用：

```text
~/.mama/vaults/container-mama-tools/
```

這是 **one container one vault**：

- 不同 container 有不同 vault
- 多個使用者如果共用同一個 container，就共用同一個 container vault

限制：

- mama 只在 `docker exec` 時注入 env
- `docker exec` 不能新增 bind mount
- vault file credential 會被保存，但目前不會自動投影到 container 內的 target path

---

## `image:<image>`

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mama-sandbox:tools

# Run mama with managed per-user containers
mama --sandbox=image:ghcr.io/geminixiang/mama-sandbox:tools /path/to/workspace
```

如果你想自行客製 image，也可以本地 build：

```bash
docker build -f docker/mama-sandbox.Dockerfile -t mama-sandbox:tools .
mama --sandbox=image:mama-sandbox:tools /path/to/workspace
```

特性：

- mama 會為每個 resolved vault / user 建立一個獨立 container
- workspace 會固定 mount 到 `/workspace`
- vault env 會在執行時注入
- vault file credential 會依 target path 自動 bind mount 進 container
- 閒置 container 會自動 stop；下次需要時再 start 或 recreate

vault key 選擇邏輯：

1. 先看 `bindings.json` 是否把 platform user 綁到指定 vault
2. 若沒有 binding，但存在同名 `userId` vault，使用該 direct vault
3. 若都沒有，建立一個 platform-scoped vault key，例如 `slack-u123`

適合：

- 多使用者共用一個 mama instance
- 需要 per-user env/file credential isolation
- 想比 shared container 更安全，但又不想直接上 Firecracker

### 容器資源限制

在 `settings.json` 中可設定每個 managed container 的 CPU 與記憶體上限：

```json
{
  "sandboxCpus": "0.5",
  "sandboxMemory": "512m"
}
```

| 欄位            | 說明                             | 範例值           |
| --------------- | -------------------------------- | ---------------- |
| `sandboxCpus`   | CPU 核心數上限（浮點數字串）     | `"0.5"`, `"2"`   |
| `sandboxMemory` | 記憶體上限（Docker memory 格式） | `"512m"`, `"2g"` |

- 建立新 container 時，限制直接加進 `docker run` 參數
- 已在執行的 container 會在下次 provision 時透過 `docker update` 立即套用新限制，不需重新建立

---

## `firecracker:<vm-id>:<host-path>`

```bash
mama --sandbox=firecracker:192.168.1.100:/home/mama/workspace /home/mama/workspace
```

完整格式：

```text
firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

範例：

```bash
mama --sandbox=firecracker:192.168.1.100:/home/mama/workspace:root:22 /home/mama/workspace
```

特性：

- mama 透過 SSH 進 VM 執行 command
- VM 內 workspace 預期是 `/workspace`
- vault env 會透過 SSH stdin 注入，避免 secret 出現在宿主機 command line
- vault 選擇邏輯：
  1. 先看 `bindings.json` 是否把 platform user 綁到 vault
  2. 若沒有 binding，使用同名 `userId` vault（如果存在）
  3. 找不到 vault 時不注入 env

限制：

- VM lifecycle 由你管理
- workspace mount 由你管理
- vault file credential 會被保存，但目前不會自動投影到 VM 內的 target path

---

## `/login` 與 vault

使用者在私訊中執行：

```text
/login
```

mama 會產生一個 15 分鐘有效的 onboarding link。使用者可在網頁中：

- 儲存任意 API key / env var
- 走 GitHub OAuth
- 走 Google Workspace CLI OAuth

`/login` 只能在 DM / 私訊使用，避免共享頻道中的其他人取得 credential onboarding link。

### 啟用 link server

正式部署時，設定公開 URL：

```bash
export MOM_LINK_URL="https://mama.example.com"
```

若沒有設定 `MOM_LINK_PORT`，mama 會在 `MOM_LINK_URL` 存在時預設使用 port `8181`。

也可以明確指定：

```bash
export MOM_LINK_PORT=8181
```

若只是本機測試，也可以只設：

```bash
export MOM_LINK_PORT=8181
```

此時 `/login` link 會使用：

```text
http://localhost:8181
```

OAuth callback URL 是：

```text
<MOM_LINK_URL>/oauth/callback
```

---

## Binding store

`bindings.json` 可把 platform user 對應到指定 vault：

```json
{
  "bindings": [
    {
      "platform": "slack",
      "platformUserId": "U123456",
      "internalUserId": "alice",
      "vaultId": "alice",
      "status": "active",
      "createdAt": "2026-04-26T00:00:00Z",
      "updatedAt": "2026-04-26T00:00:00Z"
    }
  ]
}
```

目前 binding 主要影響 `image` / `firecracker` 這類 per-user routing 模式。`container:<name>` 會固定使用 container vault，因此不看 per-user binding。
