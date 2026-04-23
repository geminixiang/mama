# Sandbox 介紹

這份文件說明 mama 支援的 sandbox 模式、vault 在不同模式下的行為，以及它們之間的安全邊界差異。

## 設計方向

mama 的 sandbox 不是單一模型的不同別名，而是一組**逐步提高隔離強度**的執行模型：

```text
host
  → container:<name>
    → image:<image>
      → firecracker:<vm-id>:<host-path>
```

越往後：

- 隔離越強
- 每使用者憑證投影能力越完整
- 執行與維運成本也越高

這個設計允許從低門檻的本機/共用環境開始，逐步升級到較強的多使用者憑證隔離。

---

## Vault 在不同 sandbox 下的共同概念

vault 主要保存兩類資料：

### 1. 環境變數型憑證（env secrets）

例如：

- `OPENAI_API_KEY`
- `GH_TOKEN`
- `GITHUB_OAUTH_ACCESS_TOKEN`

這類資料通常可以在**每次執行時動態注入**。

### 2. 檔案型憑證（file secrets）

例如：

- `gws.json`
- `.ssh/config`
- `.kube/config`

這類資料通常除了存放在 vault 中，還可能帶有一個目標路徑，例如：

```json
{
  "source": "gws.json",
  "target": "/root/.config/gws/credentials.json"
}
```

這個 `target` 的意思是：

> 若 sandbox 支援檔案投影（file projection / mount），這是理想的容器或 VM 內路徑。

**它不是所有 sandbox 模式都必須實作的保證行為。**

---

## Sandbox 能力總表

| 模式                              | 執行環境         | vault 模式 | env            | 檔案存於 vault | file target projection | 隔離強度 |
| --------------------------------- | ---------------- | ---------- | -------------- | -------------- | ---------------------- | -------- |
| `host`                            | 宿主機           | per-user   | 有             | 有             | 無 / 不保證            | 低       |
| `container:<name>`                | 共用容器         | shared     | 有（共用一組） | 有（共用一組） | 無 / 不保證            | 低 ~ 中  |
| `image:<image>`                   | 每使用者獨立容器 | per-user   | 有             | 有             | 有                     | 中 ~ 高  |
| `firecracker:<vm-id>:<host-path>` | VM               | per-user   | 有             | 有             | 有                     | 高       |

---

## `host`

最弱隔離，也是最容易啟動的模式。

### 作用

- 指令直接在宿主機執行
- 會根據 actor 選到對應的 vault
- 會把 vault 中的 env 注入當次執行

### 適合的理解方式

> `host` = 弱隔離，只保證正常流程下的 per-user credential routing。

### 能保證的

- Alice 的執行拿到 Alice 的 vault env
- Bob 的執行拿到 Bob 的 vault env
- `/login` / OAuth 寫入後，env 能在後續執行中使用

### 不能保證的

- 不提供真正檔案系統隔離
- 不保證檔案型憑證會出現在 `target` 指定路徑
- 不防止有能力的宿主機流程讀取其他地方的資料

### 適用場景

- 單人使用
- 本機開發
- 對隔離要求較低，但希望避免正常流程拿錯 key

---

## `container:<name>`

共用容器模式。比 `host` 多一層容器邊界，但本質上仍是**共享執行環境**。這個模式下，vault 也是**單一共享 vault**，不是 per-user vault。

### 作用

- 使用既有容器，透過 `docker exec` 執行命令
- 預期容器內存在 `/workspace`
- 所有使用者共用同一個 container-level vault
- 會把共享 vault 中的 env 注入每次執行

### 適合的理解方式

> `container:<name>` = 共用容器 + 單一 shared vault。

### 能保證的

- 每次執行都可拿到同一組 shared vault env
- 執行環境落在容器內，不直接使用宿主機 shell
- OAuth / `/login` 寫入的 credentials 會集中到這個 shared vault

### 不能保證的

- 不支援 per-user file projection
- 不應期待 `gws.json` 這類檔案自動出現在 `target` 路徑
- 多個使用者仍共用同一個容器檔案系統與同一組 vault credentials

### 對 vault file 的正確理解

若 `vault.json` 中有：

```json
{
  "source": "gws.json",
  "target": "/root/.config/gws/credentials.json"
}
```

在 `container:<name>` 模式下，應解讀為：

> 這個 shared vault 有一個檔案型憑證；若未來在支援 file projection 的 sandbox 中執行，理想目標路徑是 `/root/.config/gws/credentials.json`。

**這不表示共用容器會自動把檔案放到那裡。**

### 適用場景

- 想把 agent 跑在工具容器內
- 不想直接在宿主機跑命令
- 接受共享容器，不追求每使用者檔案隔離

### 為什麼這個模式不能把 vault files 自動 mount 進去？

因為 `container:<name>` 使用的是**既有容器**，mama 只是在執行時透過 `docker exec` 進去跑命令。

這代表它可以做的事情主要是：

- 指定工作目錄
- 注入 env
- 執行命令

但它**不能在 `docker exec` 當下新增 bind mount**。

所以若你看到 vault 中有像這樣的設定：

```json
{
  "source": "gws.json",
  "target": "/root/.config/gws/credentials.json"
}
```

在 shared container 模式下，這仍然只是 vault metadata，不會在執行時突然變成容器內的 mount。

---

## `image:<image>`

這是第一個真正提供**每使用者 sandbox**語意的模式。

### 作用

- 以指定 image 為基礎，自動建立 per-user container
- 每個 vault 對應自己的 container
- 支援 env 注入
- 支援 vault file mounts / target projection

### 適合的理解方式

> `image:<image>` = 每使用者獨立容器，是 vault file mounts 真正有意義的起點。

### 能保證的

- 每使用者有自己的容器
- 每使用者有自己的 env
- `gws.json`、`.ssh/config` 之類的檔案可投影到預期路徑

### 相較 `container:<name>` 的提升

- 不再是共享同一個容器
- file secrets 可以有自己的檔案視圖
- 更接近 per-user credential isolation

### 為什麼 `image:<image>` 可以支援 mounts？

因為 `image:<image>` 不是拿既有 container 直接 `docker exec`，而是由 mama 自己管理 container 的生命週期。

執行前，mama 會先確認該使用者對應的 container 是否存在、是否啟動、以及 bind mounts 是否符合目前 vault 描述。若 mounts 改變，例如：

- 新增了 `gws.json`
- 更換了 target path
- 調整了其他 vault file mounts

mama 會在必要時：

1. 停掉並移除舊 container
2. 用新的 bind mounts 重新 `docker run`
3. 再在新 container 中執行命令

也就是說，`image:<image>` 之所以能讓 vault file projection 生效，不是因為 Docker 支援在 exec 當下加 mount，而是因為這個模式**必要時會重建 container**。

### 注意

這也表示 `image:<image>` 的 mount 更新可能是**破壞性操作**：

- 若 bind mounts 漂移，container 可能被重建
- 容器內未持久化的本地狀態可能消失

因此這個模式適合把 container 視為可重建的執行環境，而不是長期保存重要 container-local state 的地方。

### 適用場景

- 多使用者 bot
- 希望不同使用者的檔案型憑證不要混在同一個共享容器內
- 需要讓 OAuth credentials 以預期路徑存在於執行環境中

---

## `firecracker:<vm-id>:<host-path>`

目前最強的隔離模型。

### 作用

- 在 VM 邊界內執行命令
- `/workspace` 對應到明確的 host path
- 支援 env 注入
- 支援 vault file mounts / target projection

### 適合的理解方式

> `firecracker` = 強隔離版本的 per-user sandbox。

### 能保證的

- 比容器更強的執行邊界
- 支援每使用者憑證投影
- 更適合高敏感憑證場景

### 適用場景

- 高風險、多租戶環境
- 對憑證隔離要求高
- 希望降低共享容器或宿主機帶來的側向影響

---

## 為什麼 `vault.json` 看起來像「都支援」，但其實不是？

因為 `vault.json` 承載的是一個**統一的憑證資料模型**，而不是每個 sandbox 都完整實作的執行合約。

可以把它理解成：

- `vault.json` 描述「這個 user 有哪些 env / file secrets」
- 也描述「若 sandbox 支援投影，這些檔案應出現在什麼位置」
- 真正會不會投影，取決於 sandbox 能力

因此：

- `host` / `container:<name>` 主要使用這個模型中的 **env 部分**
- `image:<image>` / `firecracker` 則會使用 **env + file projection** 的完整語意

---

## 如何選擇 sandbox

### 想要最低門檻、最容易開發

用：

```bash
--sandbox=host
```

### 想要工具都在容器裡，但接受共享環境

用：

```bash
--sandbox=container:<name>
```

### 想要每個使用者自己的容器與檔案型憑證路徑

用：

```bash
--sandbox=image:<image>
```

### 想要更強的隔離邊界

用：

```bash
--sandbox=firecracker:<vm-id>:<host-path>
```

---

## 建議的心智模型

若只記一件事，建議記這句：

> vault 是統一的憑證資料模型；不同 sandbox 只實作其安全等級允許的能力。`host` 與 `container:<name>` 主要提供 per-user env routing，而 `image:<image>` 與 `firecracker` 才提供 file mounts / target projection 與更強的憑證隔離。
