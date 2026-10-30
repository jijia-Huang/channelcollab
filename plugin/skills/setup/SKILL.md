---
name: setup
description: channelcollab 設定精靈。帶成員（多半是企劃）一步步完成：檢查 Node、安裝 Bot 執行環境、匯入管理員給的 Bot 交付檔、設定主人、綁定第一個頻道、啟動 Bot 並確認上線、在桌面建立啟動／停止捷徑。使用者說「設定 channelcollab」「安裝 Bot」「匯入交付檔」「setup」「第一次使用」時使用。
argument-hint: "[交付檔路徑]"
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# channelcollab 設定精靈

每位成員有一個自己的 Discord Bot，背後是他自己電腦上的 Claude Code。這個精靈把 Bot 裝好、設好、啟動。對象多半是不熟技術的企劃：**一次只做一步、用白話說明、做完一步回報結果再往下**。

本 plugin 的總控腳本（下文簡稱「總控」）：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" <子命令>
```

匯入交付檔用建 Bot 工具的腳本：

```
node "${CLAUDE_PLUGIN_ROOT}/skills/create-bot/scripts/create-bot.mjs" import-handoff "<交付檔路徑>" --json
```

路徑一律加雙引號。指令只用「`node "…" 參數`」這種形式，不要用 `&&`、`$env:`、heredoc，這樣 Bash 和 PowerShell 都能執行。

**HOME**：Bot 的資料（設定檔、log、執行環境）放在 HOME 資料夾，預設 `%USERPROFILE%\.channelcollab`，有環境變數 `CHANNELCOLLAB_HOME` 時用它。一般使用者不用管這個；使用者明確說要用別的資料夾時，所有指令都加 `--home "<資料夾>"`。

## 安全守則（一律遵守）

1. **交付檔和 `config.json` 裡有明文 Bot token。絕對不要用 Read、cat、type、Get-Content 或任何方式打開、讀取、顯示這兩個檔案**，只能把路徑交給腳本處理。腳本的輸出不含 token。
2. 不要叫使用者貼 token。使用者不小心把 token 貼進對話時，不要複述，請他通知管理員重新產生（Reset Token）並重給交付檔。
3. 不要用 `bypassPermissions`。

---

## 步驟 0：說明與現況

先用兩三句話告訴使用者接下來會做什麼（裝執行環境 → 匯入交付檔 → 綁頻道 → 啟動 → 桌面捷徑），大約 5～10 分鐘。

## 步驟 1：檢查 Node

執行 `node --version`。

- **找不到 node 指令，或版本低於 v22**：**不要自己安裝**。請使用者：
  1. 開一個終端機（開始選單搜尋「終端機」或「PowerShell」），執行 `winget install OpenJS.NodeJS.LTS`；
  2. 裝完後**關掉所有終端機和 Claude Code，重新開啟**（新的 PATH 才會生效）；
  3. 再執行一次 `/channelcollab:setup`。

  說明完就停在這裡。
- 版本是 v22 以上：執行總控 `check`，看目前狀態。
  - 已經有 token 和頻道綁定、Bot 也在執行：告訴使用者已經設定好了，問他想重做哪一步（重新匯入、改綁定、重建桌面捷徑），只做那一步。
  - npm 顯示找不到：請使用者重新安裝 Node（同上）。

## 步驟 2：安裝執行環境

執行總控 `install-runtime`。第一次要下載約 300 MB，可能要幾分鐘：**指令逾時請設成 10 分鐘**，執行前先告訴使用者要等一下。

- 失敗多半是網路問題（公司網路擋 registry.npmjs.org、代理伺服器）。把錯誤訊息的重點轉述給使用者，請他確認網路後再試；仍不行就請他聯絡管理員。

## 步驟 3：匯入交付檔

交付檔是管理員私下傳給使用者的 `.json` 檔，例如 `小明-bot.json`。

1. 呼叫時有帶參數就把它當交付檔路徑；沒有就問使用者檔案放在哪裡（常見是「下載」資料夾）。可以用 Glob 在 `%USERPROFILE%\Downloads` 找 `*-bot.json` 來確認檔案存在，**但不要打開它**。
2. 匯入：`import-handoff "<路徑>" --json`（上方的建 Bot 腳本）。腳本會向 Discord 驗證 token，再把 token、主人 ID、名冊寫進 HOME。最後一行 `RESULT {...}` 有 `botName`、`ownerId`、`rosterCount`。
3. 依結果處理：
   - **「已經有另一個 Bot 的 token」**：這台電腦的 HOME 已經有別的 Bot。不要自己加 `--replace`。問使用者：要取代原本的 Bot（加 `--replace` 重跑），還是用另一個資料夾跑第二個 Bot（之後每個指令都加 `--home`）。
   - **401／token 無效**：交付檔過期了（管理員重設過 token）。請使用者向管理員要新的交付檔。
   - **連不到 Discord**：請使用者確認網路可以連 discord.com。
4. 匯入成功後，用 AskUserQuestion 問要不要現在刪除交付檔（建議刪除：裡面是明文 token，設定已經存好了）。同意就執行：
   ```
   node -e "require('fs').rmSync(process.argv[1])" "<交付檔路徑>"
   ```
   並提醒：如果檔案是用 Discord 私訊或其他聊天工具傳的，也把那則訊息刪掉。

## 步驟 4：主人 ID

主人是 Bot 的擁有者，只有主人能在 Discord 上按權限按鈕（允許 Bot 改檔、執行指令）。

- `RESULT` 的 `ownerId` 有值：告訴使用者「主人已設定為 <ID>」，跳到下一步。
- `ownerId` 是 null（交付檔沒附）：請使用者提供自己的 Discord 使用者 ID，教他取得方式：
  1. Discord 左下角齒輪「使用者設定」→「進階」→ 打開「開發者模式」；
  2. 在任何地方對自己的頭像按右鍵 →「複製使用者 ID」。

  拿到 17～20 位數字後執行總控 `set-owner <ID>`。

## 步驟 5：綁定第一個頻道

Bot 只在綁定的頻道回應。一次問清楚（自由輸入的項目直接在對話裡一起問）：

| 項目 | 說明 |
|---|---|
| 頻道 ID | Discord 上對頻道名稱按右鍵 →「複製頻道 ID」（需要開發者模式，見步驟 4）。是一串 17～20 位數字 |
| 工作資料夾 | Bot 在這個資料夾裡讀寫檔案，例如專案的資料夾。企劃沒有特定資料夾時，建議在「文件」底下建一個 `channelcollab-work`（用 `node -e "require('fs').mkdirSync(process.argv[1],{recursive:true})" "<路徑>"` 建立） |
| 模型 | 用 AskUserQuestion：sonnet（建議，均衡）／haiku（最便宜、適合簡單問答）／opus（最強、最貴） |

權限模式不用問，一律用 `default`（每次 Bot 要改檔或執行指令都會在 Discord 出現按鈕，由主人確認）。使用者主動要求別的模式時，改用 `/channelcollab:bind`。

執行總控：

```
bind --channel <頻道ID> --cwd "<工作資料夾>" --model <模型> --permission-mode default
```

## 步驟 6：啟動 Bot

執行總控 `start`（會等 Bot 上線，最多 90 秒；**指令逾時設 3 分鐘**；runtime 需要更新時會先自動安裝，那時要更久）。

- 出現「✅ Bot 已上線：登入成 …」就成功了，再執行總控 `status` 給使用者看整體狀態。
- 失敗時，腳本會印出最近的錯誤。常見原因：token 失效（向管理員要新的交付檔）、網路連不到 discord.com、管理員那邊沒開 Message Content Intent。

## 步驟 7：桌面捷徑

執行總控 `shortcut`，在桌面建立兩個檔案：「啟動 channelcollab Bot.bat」和「停止 channelcollab Bot.bat」。告訴使用者之後有兩種方式啟動、停止 Bot，效果一樣：

- 雙擊桌面的「啟動／停止 channelcollab Bot」，看到結果後按任意鍵關閉視窗；
- 在 Claude Code 輸入 `/channelcollab:start`、`/channelcollab:stop`。

Bot 都是在背景獨立執行，關掉視窗或 Claude Code 都不會停。

## 步驟 8：完成

用簡短清單告訴使用者：

- Bot 名稱、主人、綁定的頻道與工作資料夾、桌面捷徑的位置。
- 怎麼用：在綁定的頻道 **@Bot 名稱** 加上要交辦的事，Bot 會開一個討論串回覆；之後在討論串裡直接講話就好。
- 訊息上的表情：👀 收到（排隊中）、⚙️ 處理中、⏳ 等待確認、✅ 完成、❌ 失敗。
- Bot 要改檔或執行指令時會出現按鈕，只有主人能按。
- 常用指令：`/channelcollab:status`（狀態）、`/channelcollab:stop`（停止）、`/channelcollab:start`（啟動）、`/channelcollab:bind`（綁更多頻道）。
- 交付檔還沒刪的話，再提醒一次。
