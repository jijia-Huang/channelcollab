# channelcollab — 多人 × 多 Bot 的 Discord 協作 實作計畫

> 狀態：Phase 1、Phase 2 與 Phase 3 的大部分已完成並在 Discord 實測（見第 15 節）
> 本資料夾之後會成為 plugin marketplace 的 repo。
> 外部工具（例如決策類工具）不在本工具內，只透過 `channelcollab resume` 指令接回（見第 9 節）。

---

## 1. 目標與非目標

### 目標

- **多人協作**：每位成員（工程師、企劃）各有一個 Discord Bot，背後是**他自己電腦上的 Claude Code**，使用他自己的環境（CLAUDE.md、skills、plugins、repo）。
- 人類與 Bot 在同一個 Discord 伺服器裡用 @ 互相交辦、反問、接力。
- **在 Discord 上的體驗要像在終端機或 Claude App 裡，但不洗版**：Discord 上只出現 Claude 用 `reply` 工具刻意說給人聽的話；工作狀態用表情符號表示；權限按鈕、選擇題選單、隨時中止照樣有。
- 每個頻道由安裝者自己決定**工作目錄**和**用哪個啟動器啟動 Claude**（可以搭配套用某個 profile 的自訂啟動器等）。
- 企劃安裝要簡單：一行指令裝 plugin，加上一個設定精靈。

### 非目標

- 不做規則式安全過濾。要不要找人、找誰，交給 Claude 依照協作守則判斷。
- 不自動 merge。協作守則預設最多做到開 PR。
- 決策類功能不在本工具內（交給外部工具，例如決策類工具）。channelcollab 只提供 `resume` 指令讓外部工具接回來。
- 不在程式碼或文件中提及、依賴任何其他特定 plugin 或外部系統。對外只有設定與指令介面。

---

## 2. 架構總圖

```
┌──────────────────── Discord 伺服器 ────────────────────┐
│ 📋 論壇頻道 repo-a       ← 一個頻道對應一個 repo（由各人自行綁定）│
│    ├─ 貼文「購買按鈕文字改成立即購買」 [完成]             │
│    └─ 貼文「首頁動畫重做」 [進行中]                       │
│ 📋 論壇頻道 repo-b                                       │
│ 💬 一般頻道（被 @ 才回應）                                │
│ 1 篇貼文／討論串 = 1 個任務 = 1 個 Claude session         │
└───────────────────────────┬────────────────────────────┘
                            │ 被 @
                            ▼
┌──── channelcollab Bot（每人電腦上；桌面 .bat 或 /channelcollab:start 啟動）────┐
│ 觸發判斷 → 轉手計數 → 帶入上下文 → 依頻道設定啟動 Claude      │
│ 提供 reply 等工具給 Claude；狀態表情、按鈕、選單              │
│ 停止：桌面 .bat 或 /channelcollab:stop；狀態：/channelcollab:status │
└───────────────────────────┬────────────────────────────┘
                            │ Agent SDK（雙向串流）
                            ▼
          Claude Code（cwd = 頻道設定；啟動器 = 頻道設定）
          載入使用者設定、skills、plugins（含使用者自行安裝的外部工具）
```

**原則**
1. Discord 是介面，Claude 做判斷，channelcollab 只負責轉送和呈現。
2. 每個人只設定自己的 Bot，設定只存在本機。
3. 對外只有兩種介面：**頻道設定**和**指令**（`post` / `resume` / `listen`），不認識任何其他工具。

---

## 3. 技術選型

| 項目 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript | 官方 Agent SDK 有 TypeScript 版 |
| Claude 驅動 | `@anthropic-ai/claude-agent-sdk` | 雙向串流：權限回呼（canUseTool）、AskUserQuestion、中斷、session 接續 |
| Discord | discord.js v14 | 最成熟；按鈕、選單、Modal、論壇標籤都支援 |
| 執行環境 | Node 22 以上（開發期用 `tsx` 直接跑 `src/`） | 成員需自行安裝 Node；setup 偵測不到時請使用者用 winget 安裝 |
| 打包 | esbuild 打包成 `plugin/runtime/bot.mjs`（npm 套件不打包），提交進 repo；成員端 `npm ci` 安裝固定版本的依賴（見第 13 節） | Agent SDK 內建平台專屬的 CLI 執行檔，只能由 npm 依平台安裝。單一 exe（Phase 0-1）延後 |
| 名冊 | `<HOME>\roster.json`（每人一份） | 由管理員經交付檔或 `/channelcollab:update-roster` 發放，不放在 plugin 裡（第 12 節） |
| 本機狀態 | JSON 檔（`%USERPROFILE%\.channelcollab\state.json`） | 討論串 ↔ session 對應、轉手計數、排隊；資料量小，先用 JSON，不夠用再換 SQLite |
| 設定 | `%USERPROFILE%\.channelcollab\config.json` | 只在本機，Discord 上不能改；Discord token 也存在其中（`discord.token`） |

---

## 4. Discord 結構

- **論壇頻道（建議）**：一個 repo 或專案一個。貼文標題就是任務標題，**論壇標籤表示狀態**。
  - 預設標籤：`進行中`、`等待回覆`、`待驗收`、`完成`（可在設定中改名）。
  - 改用標籤而不改討論串名稱，是因為 Discord 限制改名的頻率。
- **一般頻道**：被 @ 時自動開一個討論串來處理，避免洗版。
- **私訊**：只接受主人本人，用於私人操作。
- 討論串和論壇貼文**沿用上層頻道的設定**。

---

## 5. 頻道設定

設定檔：`%USERPROFILE%\.channelcollab\config.json`（設定了 `CHANNELCOLLAB_HOME` 時是 `<HOME>\config.json`，見第 6 節「一台電腦跑多個 Bot」）

```json
{
  "discord": {
    "token": "<由 /channelcollab:setup 或建 Bot 的 skill 寫入>",
    "guild_id": "111111111111111111",
    "owner_id": "222222222222222222"
  },
  "defaults": {
    "history": 30,
    "max_hops": 5,
    "busy_policy": "queue",
    "idle_close_minutes": 120,
    "max_live_sessions": 4,
    "permission_mode": "default",
    "permission_timeout_minutes": 10
  },
  "channels": {
    "1234567890": {
      "cwd": "D:\\work\\repo-a",
      "launcher": "claude",
      "model": "opus",
      "permission_mode": "default",
      "tools": ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
    },
    "2345678901": {
      "cwd": "D:\\work\\repo-b",
      "launcher": "D:\\scripts\\claude-profile.cmd"
    },
    "3456789012": {
      "cwd": "D:\\work\\repo-b",
      "external": "D:\\scripts\\external-inject.cmd"
    }
  },
  "unbound": "ignore",
  "on": {
    "task_completed": ""
  }
}
```

範例中的三個頻道：`1234567890` 是 repo-a 論壇（直接用 `claude`）；`2345678901` 是 repo-b 頻道（用自訂啟動器）；`3456789012` 是簡易模式頻道（交給外部指令）。JSON 字串中的 Windows 路徑反斜線要寫成 `\\`。

### 頻道設定欄位說明

| 欄位 | 說明 |
|---|---|
| `discord.token` | Discord Bot token，由 `/channelcollab:setup` 或建 Bot 的 skill 寫入，不要手動貼到別處。這個檔案含 token，**不要分享或提交到版本控制** |
| `discord.guild_id` | Discord 伺服器 ID |
| `discord.owner_id` | Bot 擁有者（主人）的 Discord 使用者 ID。只有這個人能核准權限請求。沒填時退回用名冊裡這個 Bot 的 `ownerDiscordId`；兩者都沒有時權限請求一律拒絕（見第 8 節）。由 `/channelcollab:setup` 從交付檔寫入，或用總控的 `set-owner` 設定；`bind` 等其他指令不會動到它 |
| `defaults.history` | 每次帶入討論串最近幾則訊息 |
| `defaults.max_hops` | Bot 之間轉手上限 |
| `defaults.busy_policy` | Claude 正在跑時收到新訊息：`queue`（排隊）或 `interrupt`（打斷） |
| `defaults.idle_close_minutes` | 常駐 session 閒置多久關閉程序（之後再 resume；重啟要付 20～40 秒啟動時間，見第 6 節） |
| `defaults.max_live_sessions` | 同時常駐的 session 上限，預設 4。超過時關掉閒置最久的那個（之後一樣可以 resume）；正在執行或還有排隊訊息的不會被關 |
| `defaults.permission_mode` | 必須明確設定（見下方說明） |
| `defaults.permission_timeout_minutes` | 等待擁有者核准權限請求（以及等人回答選擇題）的時間，預設 10 分鐘。逾時權限請求自動拒絕、選擇題視為沒有人回答 |
| `channels.<頻道 ID>.cwd` | 這個頻道的工作目錄 |
| `channels.<頻道 ID>.launcher` | `claude`（內建：直接用已安裝的 claude），或自訂啟動器的路徑（例如套用某個 profile，見下方契約） |
| `channels.<頻道 ID>.model` | 依頻道指定模型；簡單的頻道用 sonnet / haiku 省成本 |
| `channels.<頻道 ID>.permission_mode` | 覆寫 `defaults.permission_mode` |
| `channels.<頻道 ID>.tools` | 真正限縮可用的工具集；省略表示全部 |
| `channels.<頻道 ID>.external` | 簡易模式：外部指令，只做文字往來（見第 9 節）。設定這個欄位時不使用 `launcher` |
| `unbound` | 沒綁定的頻道怎麼處理；`ignore` 表示不回應 |
| `on.task_completed` | 任務標記完成時執行的指令（stdin 傳 JSON），空字串表示不接 |

補充：

- `permission_mode`：**必須明確設定**（預設寫 `default`）。省略時 Claude 會沿用使用者自己的設定（例如 auto 模式），權限回呼就不會被呼叫，Discord 上也不會出現權限按鈕。
- `tools`：真正限縮這個頻道可用的工具集（對應 SDK 的 `tools`）。注意 SDK 的 `allowedTools` 只是「預先放行、不再詢問」，**不會**限縮工具集，所以設定檔不提供 `allowed_tools` 以免誤用。
- `model`：依頻道指定模型。Opus 單輪約 $0.2，Haiku 單輪不到 $0.01（Phase 0 實測），簡單的頻道可以用便宜的模型。

### 啟動器（launcher）契約

- channelcollab 透過 Agent SDK 啟動 Claude 時，把「執行檔路徑」換成啟動器。
- **啟動器必須最終執行 `claude`，並原封不動傳遞收到的參數和 stdin/stdout**。只要做到這點，完整體驗就不受影響。
- **啟動器本身不得輸出任何東西到 stdout**（stdout 是 Claude 的串流協定通道）；要留紀錄就寫檔或寫 stderr。
- 例：`claude-profile.cmd` 內容可能是「先套用某個 profile 的設定，再 `claude %*`」。
- **`.cmd` / `.bat` 啟動器的啟動方式（Phase 0-5 實測）**：
  - 不能直接把 `.cmd` 當執行檔交給 SDK：Node 22 基於安全修補，不帶 shell 啟動 `.cmd` 會直接丟 `spawn EINVAL`。
  - channelcollab 改用 SDK 的 `spawnClaudeCodeProcess` 自行以 `cmd.exe /d /s /c` 啟動，並負責跳脫：每個參數先依 Windows C runtime 規則加引號，再把 cmd 的特殊字元（`" % ^ & | < > ! ( )` 等）**加兩層 `^`**——一層給 `cmd /c`，一層給啟動器內 `%*` 展開後的再次解析。只跳脫一層時，引號數為奇數的參數會被截斷，後面的 `&` 會被當成指令執行。
  - 限制：cmd 命令列上限 8191 字元、參數中不能有換行。目前 SDK 放在命令列的只有短旗標（協作守則等長文字透過 stdin 的初始化訊息傳入），不受影響；之後若新增命令列參數要注意。
  - 中止時要結束整個程序樹（例如 `taskkill /T /F`）：Windows 上只殺 `cmd.exe` 不會帶走底下的 `claude.exe`（推論，Phase 0 只驗證了正常收尾時沒有殘留程序，強制中止尚未實測）。
- 不論哪種啟動器，Claude 程序一律由 channelcollab 自己 spawn（透過 `spawnClaudeCodeProcess`），以便記下 PID；強制結束時用 `taskkill /T /F` 結束整棵程序樹。

### 設定方式

- `/channelcollab:bind` skill：在 Claude Code 裡說「把這個頻道綁到 D:\work\repo-a，用 xxx 啟動器」，skill 就幫你寫入 `config.json`。
- 設定檔變更會自動重新載入，不用重啟。

---

## 6. 訊息處理流程

```
收到訊息
 ├─ 自己發的 → 忽略
 ├─ 頻道沒綁定 → 忽略
 ├─ 來自其他 Bot 且沒有明確 @ 我 → 忽略
 ├─ 主頻道：沒 @ 我 → 忽略；@ 我 → 從這則訊息開討論串
 ├─ 討論串，人類發言（見下方「多 Bot 觸發規則」）：
 │   ├─ 有 @ 我 → 處理
 │   ├─ 有 @ 其他 Bot、沒 @ 我 → 忽略（即使討論串是我開的）
 │   └─ 沒 @ 任何 Bot → 只有開這個討論串的 Bot 處理
 ├─ 轉手次數超過 max_hops → 不處理，@ 最後發言的人類：「Bot 之間已連續轉手 N 次……請人類接手」
 ├─ 此頻道／討論串正被頂替 → 不啟動 session，轉給頂替者的 listen（第 10 節）
 └─ 處理：
     1. 找到或建立討論串 ↔ session 的對應
     2. 組合提示詞：
        【發話者】名字／角色／是否為 Bot（取自名冊）
        【位置】頻道、討論串 ID
        【最近 N 則訊息】包含其他 Bot 的發言
        【本則訊息】內容與附件（附件先下載到本機，提示詞裡寫本機路徑，見第 7 節「附檔」）
     3. 這個討論串若正在執行 → 依 busy_policy 排隊或打斷
     4. 透過 Agent SDK 啟動或接續 session（cwd、launcher、model 依頻道設定）
     5. 在觸發訊息上更新狀態表情；Claude 透過 reply 工具發言（第 7 節）
        需要權限或提問時，在討論串貼按鈕，等人回應（第 8 節）；超過 5 秒的一輪會出現 🛑 停止按鈕
     6. 結束後依結果更新論壇標籤
```

### 多 Bot 觸發規則

- 一個討論串裡可以有多個 Bot，各自跑在不同的程序（通常在不同人的電腦上），彼此不共用狀態。
- **誰開的討論串**：看 Discord 的 `thread.ownerId`（Bot 從主頻道訊息開的討論串，owner 就是那個 Bot）。所有 Bot 讀到的是同一個答案，不靠各自的 `state.json` 猜。
- 人類在討論串發言：
  - 有 @ 某些 Bot → 只有被 @ 的 Bot 回。
  - 都沒 @ → 只有開討論串的 Bot 回。
- **加入（adopt）**：被 @ 而進入別人討論串的 Bot，會在自己的 `state.json` 記下這個討論串（存 session）。之後沒被 @ 就不回應人類，但下次被觸發時，提示詞的「最近訊息」仍包含上次之後討論串裡所有人（含其他 Bot）的發言。
- Bot 的訊息：只有明確 @ 我時才處理（同上）。
- 人類在主頻道同時 @ 多個 Bot：每個 Bot 都想從同一則訊息開討論串，只有一個會成功（它就是 owner），其他 Bot 加入那個討論串。

### 轉手計數

- 以討論串為單位。Bot 的訊息裡 @ 了另一個 Bot，算一跳；人類發言歸零。
- **從 Discord 訊息歷史推算，不存在各 Bot 的狀態檔**：收到 Bot 的觸發訊息時，從這則訊息往回讀（最多 500 則），遇到人類訊息就停；途中每一則「@ 了其他 Bot 的 Bot 訊息」算一跳（含觸發訊息本身），沒 @ Bot 的 Bot 訊息和系統訊息略過。人類觸發時直接是 0。
  - 對同一則訊息，每個 Bot 讀到的歷史相同，算出的數字也相同，所以不會重複計數或漏算；計數只看觸發訊息之前（含）的歷史，之後才出現的訊息不影響。
- 跳數 > `max_hops` 時不執行，由被 @ 的那個 Bot 在討論串留一句說明並 @ 最後發言的人類（討論串裡找不到時，用討論串起始訊息的作者——從主頻道訊息開的討論串，那則訊息在主頻道）。這則說明不 @ 任何 Bot，所以本身不算一跳。
- Bot 觸發的一輪成功結束但沒有呼叫 reply（例如對方只是通知完成，沒有要它做的事）：不貼「沒有呼叫 reply」的自動摘要，只記 log，避免多一則雜訊。人類觸發時照舊貼摘要。
- 上限是保險。實務上 Claude 依協作守則（第 11 節）不會無限轉手。

### 一台電腦跑多個 Bot（HOME）

- 每個 Bot 有自己的資料夾（HOME）：環境變數 `CHANNELCOLLAB_HOME`，沒設時是 `%USERPROFILE%\.channelcollab`。
- 跟著 HOME 分開的：`config.json`（含各自的 token）、`state.json`、`bot.pid`、`bot.log`／`bot.err.log`（背景執行時重導到這裡），以及停止用的 named pipe（名稱由 HOME 路徑的雜湊產生，例如 `\\.\pipe\channelcollab-0123456789ab`；啟動時的 `[start]` log 會印出 `home=` 和 `pipe=`）。
- 啟動與停止都要帶同一個 HOME（PowerShell）：

  ```powershell
  # 啟動第二個 Bot（背景，log 寫到它自己的 HOME）
  $env:CHANNELCOLLAB_HOME = "$env:USERPROFILE\.channelcollab-bot2"
  Start-Process node -ArgumentList '--import','tsx','src/main.ts' -WorkingDirectory <專案目錄> `
    -RedirectStandardOutput "$env:CHANNELCOLLAB_HOME\bot.log" -RedirectStandardError "$env:CHANNELCOLLAB_HOME\bot.err.log" -WindowStyle Hidden
  # 停止它
  $env:CHANNELCOLLAB_HOME = "$env:USERPROFILE\.channelcollab-bot2"; npm run stop
  # 停止預設 HOME 的 Bot：不設 CHANNELCOLLAB_HOME
  Remove-Item Env:CHANNELCOLLAB_HOME; npm run stop
  ```

- 同一個 HOME 同時只能跑一個 Bot：第二個啟動時拿不到那個 HOME 的 named pipe 會直接退出。不同 HOME 互不影響。

### Session 生命週期

- 一個討論串 = 一個 session ID（存在本機狀態檔 `state.json`）。
- **常駐**：討論串第一次被觸發時啟動一個 query（Agent SDK 的 streaming input，`prompt` 是 AsyncIterable），之後同一個討論串的新訊息都推進這個 query 的輸入佇列，不再重啟程序。
- **一輪**：推入一則使用者訊息 → 收到 `result` 訊息為止。`result` 出來時把狀態表情改成 ✅／❌，並記下這一輪的工具與費用給「📄 詳細」。
- **排隊**：一輪還在跑時，新訊息掛 ⏳ 排隊，等這輪的 `result` 出來才送進去；不會在一輪執行到一半時塞訊息。歷史訊息只附上次之後的新訊息（同 Phase 1）。
- **費用**：`total_cost_usd` 在 streaming 模式下是這個 query 的**累計值**。resume 的 query 會從 transcript 存的累計值接著算，但 CLI **只在正常結束時**存這個值；被強制結束或當掉時，那之後的幾輪不會算進去（實測）。所以：
  - 同一個常駐 query 內：單輪費用 = 這次的累計值 − 上一輪的累計值。
  - resume 後的第一輪：單輪費用 = 這次的累計值 − `resumeCostBase`（上次**正常結束**時的累計值，存在 `state.json`；當掉時不更新）。
  - 若累計值比基準小（被重設），就直接用這次的值。
- **子程序的環境變數**：Claude 程序繼承 Bot 的環境，只拿掉兩類：
  - `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`（一律用主人自己的 claude.ai 登入）；
  - 「從某個 Claude Code session 裡啟動」才會有的標記：`CLAUDECODE`、`CLAUDE_PID`、`CLAUDE_EFFORT`、`CLAUDE_AGENT_SDK_VERSION`，以及 `CLAUDE_CODE_` 開頭的 `ENTRYPOINT`、`EXECPATH`、`SESSION_ID`、`SESSION_KIND`、`SESSION_ATTENDED`、`CHILD_SESSION`、`REMOTE_SESSION_ID`、`MESSAGING_SOCKET`、`MESSAGING_TOKEN`、`SSE_PORT`。
  - 其餘都保留，包括使用者自己的設定：`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_USE_BEDROCK`／`USE_VERTEX`、`CLAUDE_CODE_GIT_BASH_PATH`、`CLAUDE_CODE_OAUTH_TOKEN` 等。所以不能用「`CLAUDE_CODE_*` 全部拿掉」這種前綴規則。
  - 實測（Phase 2 spike）：沒拿掉 `CLAUDE_CODE_MESSAGING_SOCKET` 時，子程序曾經把訊息送回啟動 Bot 的那個 session。建議從一般終端機啟動 Bot，不要從 Claude Code 或其他代理工具的 session 裡啟動。
- `maxTurns` 在 streaming 模式下是**每則訊息各自計算**，不是整個 session 累計（實測）。
- **啟動成本**：從啟動程序到 session 就緒（init）約 20～40 秒（含載入使用者的 skills、MCP、plugins）。只有啟動或 resume 時要付；常駐期間的後續訊息不用。啟動期間觸發訊息掛 ⚙️。

**什麼時候關閉**

| 情況 | 做法 |
|---|---|
| 閒置超過 `idle_close_minutes` | 正常結束（關閉 stdin，讓 CLI 自己收尾），15 秒內沒結束才強制結束整棵程序樹 |
| 常駐數超過 `max_live_sessions` | 關掉閒置最久的那個（方式同上）；正在執行或還有排隊訊息的不會被選中，全部都忙時暫時超過上限並記 log |
| Bot 收到停止要求（`npm run stop`、Ctrl+C） | 不再開新 session；閒置的正常結束，執行中的直接強制結束並把那一輪標 ❌；確認程序樹都結束後 Bot 才退出 |
| 一輪的工作時間超過 10 分鐘 | 強制結束這個 session，這一輪標 ❌。等人回應權限請求或問題的時間**不算**在內（等待期間計時暫停） |
| 有人按 🛑 | 不關閉 session：用 `query.interrupt()` 中斷這一輪，標 ⏹️；下一則訊息接著同一個 session（見第 7 節） |
| query 意外結束或丟出例外 | 這一輪標 ❌，在討論串簡短說明；Bot 本身不受影響 |

**什麼時候 resume**

- 上述任何一種關閉之後，同一個討論串再被觸發時，用 `state.json` 裡的 sessionId 啟動新的 query 並 resume，接回原本的對話。
- Bot 重啟後也一樣：第一次被觸發時 resume。
- 舊 session 還在關閉中時，新的 query 會等它完全結束才 resume。

**停止 Bot**

- `npm start` 以單一 node 程序執行（`node --import tsx src/main.ts`），`bot.pid` 就是整棵程序樹的根。
- `npm run stop`：透過本機 named pipe 要求 Bot 正常關閉，等它退出；60 秒內沒退出就 `taskkill /T /F`。
- Windows 上從外部送不出 SIGTERM（`taskkill`／`Stop-Process` 都是直接終止，不會執行收尾），所以要正常關閉請用 `npm run stop` 或在 Bot 的主控台按 Ctrl+C。Bot 卡死時才用 `taskkill /T /F /PID <bot.pid>`。
- 同一個 HOME 同時只能跑一個 Bot：第二個啟動時拿不到 named pipe 會直接退出。要在同一台電腦跑多個 Bot，各用一個 HOME（見上方「一台電腦跑多個 Bot」）。
- **等人回應**（權限請求、AskUserQuestion）：在 Bot 程序內直接 await Discord 的按鈕，不需要 IPC 或 `defer`；常駐程序在等待期間保持開著。等待上限是 `defaults.permission_timeout_minutes`（預設 10 分鐘），逾時自動拒絕。要等好幾個小時的情境（例如等企劃）目前不支援，之後若需要再評估 `defer`。

---

## 7. 終端機般的體驗

### 發言原則：只講給人聽的話

- **Claude 的輸出不會自動轉貼到 Discord。**channelcollab 透過 Agent SDK 的程序內 MCP，提供 Claude 以下工具：

| 工具 | 用途 |
|---|---|
| `reply(text, files?)` | 在目前的討論串發言（超過 2000 字自動切段）；`files` 是本機路徑陣列，附在最後一段（見下方「附檔」） |
| `mention(user, text)` | 發言並 @ 某人（交棒、反問時使用） |
| `set_status(tag)` | 更新論壇標籤（例如 `待驗收`） |

- 協作守則要求 Claude：**簡短、只講結論**，需要時附上 PR 連結。
- **保險機制**：如果一輪結束時 Claude 一次都沒有呼叫 `reply`，channelcollab 會自動貼出它最後一段文字的摘要（截斷），避免使用者完全沒收到回應。

### 狀態表情

狀態顯示在**觸發這次處理的那則訊息**上，不另外發文字：

| 表情 | 意思 |
|---|---|
| 👀 | 收到（排隊中） |
| ⚙️ | 處理中 |
| ⏳ | 排隊中，或等待某人回應權限請求／問題（同時會發一則帶按鈕的訊息） |
| ✅ | 完成 |
| ❌ | 失敗 |
| ⏹️ | 被 🛑 停止 |

### 互動（Phase 2 實作）

- **權限請求**：討論串出現一則訊息，@ 主人，內容是工具名稱和精簡的輸入（Bash／PowerShell：說明與指令；Edit：檔案路徑和簡短 diff，最多 3 處、每邊 8 行；Write：路徑、行數和開頭 10 行；其他：路徑或 JSON 摘要）。三個按鈕：
  - 「允許」：只放行這一次。
  - 「這個 session 一律允許 <工具>」：放行，而且這個討論串之後同名工具不再詢問（以工具名稱為單位，例如 Bash 全部指令）。記在 `state.json` 的 `alwaysAllow`，resume 和 Bot 重啟後仍有效。
  - 「拒絕」：跳出 Modal 可填理由（選填）。Claude 收到的拒絕訊息會帶上理由。
  - 處理後按鈕移除，訊息標註誰允許／拒絕；逾時標註「⌛ 逾時，已自動拒絕」；這一輪被停止時標註「已取消」。
- **選擇題（AskUserQuestion）**：一則訊息列出所有問題（最多 4 題），每題一個下拉選單；多選題用選單的多選。每個選單另有「其他…（自行輸入）」，選了會跳出 Modal 自由輸入（多選時和其他選項合併）。每題都答完才把答案交回 Claude；逾時沒答完就告訴 Claude「沒有人回答」。
- **🛑 停止**：一輪執行超過 5 秒，Bot 會發一則「⚙️ 處理中…」的進度訊息，帶 🛑 按鈕。按下後用 `query.interrupt()` 中斷（不殺程序），等待中的權限請求和問題一併取消；觸發訊息標 ⏹️，進度訊息改成「已由 X 停止」並附「📄 詳細」。下一則訊息接著同一個 session。一輪正常結束時進度訊息會被刪掉（有自動摘要或失敗說明時改用它來顯示）。
- 這些按鈕都存在記憶體裡；Bot 重啟後按舊按鈕會看到「已處理過或已失效」。

### 附檔

- **收**：觸發訊息的附件下載到 `<HOME>\inbox\<討論串 ID>\<訊息 ID>-<檔名>`，提示詞裡寫本機路徑、類型和大小，Claude 用 Read 讀（圖片也可以）。單檔上限 25MB，超過的不下載、只附原連結並註明。只有觸發訊息的附件會下載；歷史訊息的附件只給連結。
- **送**：`reply` 的 `files` 只接受工作目錄（cwd）或這個討論串的 inbox 底下的檔案（解析捷徑後再檢查，`..` 跳出去的會被拒絕），一則最多 10 個。被拒絕的檔案會在工具結果裡告訴 Claude 原因；Discord 本身的大小限制由 Discord 回報錯誤。

### 看細節

- Bot 的回覆附一個「📄 詳細」按鈕：按下後**只有按的人看得到**這一輪的工具動作摘要，或拿到完整 log 附檔。
- 需要更深入時，用 `/terminal` 在終端機接手。

### Phase A（核心，MVP 必做）

| 終端機的體驗 | Discord 呈現 |
|---|---|
| Claude 回話 | `reply` 工具，只講結論 |
| 工作狀態 | 觸發訊息上的狀態表情 |
| 過程細節 | 「📄 詳細」按鈕（只有自己看得到）或 log 附檔 |
| 權限確認 | 按鈕：允許／一律允許／拒絕（拒絕可附理由，用 Modal 輸入） |
| 選擇題（AskUserQuestion） | 下拉選單（單選或多選）＋「其他」（Modal 自由輸入） |
| 中止 | 進度訊息上的 🛑 Stop 按鈕 |
| 附檔與圖片 | 使用者上傳的檔案交給 Claude；Claude 產出的檔案上傳回討論串 |
| 長輸出 | 超過 2000 字自動切段，太長就改附檔 |

### Phase B（進階）

| 功能 | Discord 呈現 |
|---|---|
| 計畫審核（ExitPlanMode） | 顯示計畫＋「核准／修改」按鈕 |
| 待辦清單（Todo） | 一則持續更新的清單訊息 |
| `/model`、`/mode` | 切換此討論串的模型或權限模式 |
| `/new`、`/resume` | 開新 session；接續舊 session（自動完成） |
| `/btw` | 把目前上下文分出一個新討論串，問旁支問題，不打擾主線 |
| `/terminal` | 給一行 `claude --resume <ID>`，在終端機接手（Discord 這邊會暫停） |
| `/diff` | 顯示目前 worktree 的變更（附檔或摘要） |
| `/usage` | 顯示用量 |
| skills 變成斜線指令 | `/skill` 加自動完成 |

**Discord 先天限制**：單則訊息上限 2000 字（`reply` 會自動切段或改附檔）；表情與編輯有頻率限制，狀態更新要合併處理。

---

## 8. 多人權限規則

| 互動 | 誰可以操作 |
|---|---|
| 權限確認（改檔、執行指令） | **只有 Bot 的主人**（因為是在主人的電腦上執行） |
| 選擇題（AskUserQuestion） | 提出需求的人；主人也可以代答 |
| 計畫審核 | 主人（可設定為也允許提出需求的人） |
| 🛑 Stop | 主人和提出需求的人 |
| 斜線指令（/model、/mode、/terminal…） | 只有主人 |
| 標記完成 | 提出需求的人或主人 |

其他人按了沒有權限的按鈕，只會看到一則僅自己可見的提示：權限請求是「只有 Bot 擁有者可以核准。」；問題和 🛑 是「只有 @提出需求的人 或 @主人 可以回答／停止這一輪。」。由其他 Bot 觸發的一輪，「提出需求的人」是空的（Bot 不會按按鈕，提示裡也不 @ Bot，避免觸發它），只有主人能操作。判斷邏輯在 `src/runner/policy.ts` 的 `canAct`，由 `spike/authz-check.ts` 驗證。

### 誰是主人

- `config.json` 的 `discord.owner_id`（setup 精靈會寫入）；沒填時用名冊裡這個 Bot 的 `ownerDiscordId`。
- 兩者都沒有：權限請求一律直接拒絕，並在討論串說明；啟動時的 `[owner]` log 會提示。
- 相關設定：`defaults.permission_timeout_minutes`（預設 10）是權限請求和問題的等待上限，逾時自動拒絕／略過。

### 哪些工具要問（依頻道的 `permission_mode`）

| 工具 | `default` | `acceptEdits` | `plan` | `dontAsk` | `auto` |
|---|---|---|---|---|---|
| Bot 自己的工具（`reply`） | 放行 | 放行 | 放行 | 放行 | 放行 |
| 唯讀工具（Read、Glob、Grep、LS、LSP、NotebookRead、ToolSearch、TodoWrite、Task 系列、Skill），目標在 cwd 或這個討論串的 inbox 內（或沒有指定路徑） | 放行 | 放行 | 放行 | 放行 | 交給 Claude Code |
| 唯讀工具，目標在 cwd／inbox **以外**（例如 Bot 自己含 token 的 config） | 問主人 | 問主人 | 問主人 | 問主人 | 交給 Claude Code |
| Edit、Write、MultiEdit、NotebookEdit，目標在 cwd／inbox 內 | 問主人 | 放行 | 拒絕 | 拒絕 | 交給 Claude Code |
| 其他（Bash、PowerShell、cwd 外的編輯、WebFetch、其他 MCP 工具…） | 問主人 | 問主人 | 拒絕 | 拒絕 | 交給 Claude Code |
| AskUserQuestion | 在 Discord 提問 | 同左 | 同左 | 同左 | 同左 |

- 「這個 session 一律允許」過的工具：除了 `plan` 以外都直接放行（`auto` 本來就交給 Claude Code）。
- `auto`：使用者選了 Claude Code 自己的自動判斷，Bot 不介入，所以不會出現權限按鈕。
- Claude Code 自己仍想詢問的情況（例如 `auto` 的判斷結果是要問）會走到 `canUseTool`，一樣變成 Discord 的權限按鈕。

### 權限按鈕的實作方式（Phase 2 實測）

- 權限判斷放在 in-process 的 **PreToolUse hook**（`options.hooks`），不靠 `canUseTool`。
  - 原因：使用者設定裡的 allow 規則（例如一律允許 Bash）和 SDK 的 `allowedTools` 會在 `canUseTool` 之前直接放行，回呼根本不會被呼叫（SDK 會印 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告）。
  - 實測（`spike/phase2-check.ts`，SDK 0.3.314）：使用者 settings 有 `Bash` allow 規則時，PreToolUse hook **仍然每次被呼叫**；回傳 `permissionDecision: 'deny'` 會擋下，`permissionDecisionReason` 原文會出現在 Claude 看到的工具結果（`PreToolUse:Bash hook error: <理由>`）；回傳 `'allow'` 會放行且不再經過 `canUseTool`。
  - hook 直接在 Bot 程序內 await Discord 按鈕，不需要 IPC 或 `defer`。hook 預設逾時是 60 秒，所以 matcher 的 `timeout` 設成「權限等待上限 + 60 秒」（實測 await 65 秒沒有問題）。
- **AskUserQuestion**：hook 對它不做決定（回傳 `{}`），交給 `canUseTool`；Bot 在 Discord 問完後回傳 `{ behavior: 'allow', updatedInput: { ...input, answers } }`，`answers` 的 key 是問題原文、值是選項 label（多選用 `, ` 連接）。實測 Claude 收到「Your questions have been answered…」並照答案繼續。hook 若對它回 allow，`canUseTool` 就不會被呼叫，Claude 會拿不到答案。
- **🛑 停止**：`query.interrupt()` 約 0.1 秒回應（`still_queued: []`），執行中的 Bash 被中止，這一輪以 `error_during_execution` 結束（Bot 記為 `interrupted`）。程序不會結束，下一則訊息在同一個 session 繼續，記得先前的對話。
- 等待期間的取消：hook 和 `canUseTool` 收到的 `signal`，加上這一輪自己的 AbortController（🛑、強制關閉、逾時時觸發），任一個 abort 就把按鈕訊息標成「已取消」並回傳拒絕，hook 不會卡住。

---

## 9. 對外介面

### 指令

| 指令 | 用途 |
|---|---|
| `channelcollab post --thread <ID> "內容"` | 從任何腳本發訊息到指定討論串 |
| `channelcollab resume --session <ID> --message "內容"` | 接續指定 session，送入一則訊息（例如決策結果），並把輸出呈現到對應的討論串 |
| `channelcollab status` | 查看執行中、排隊中、等待中的任務 |
| `channelcollab listen --target <頻道或討論串>` | 頂替模式用：向常駐程式登記為該目標的頂替者，之後每收到一則訊息就輸出一行；程序結束即交還（見第 10 節） |

`resume` 是給外部工具（例如決策類工具）接回來用的，也是外部工具與 channelcollab 之間唯一的接點。channelcollab 不需要知道是誰在呼叫。

### 任務完成事件

- 討論串被標記為 `完成` 時，執行設定中的 `on.task_completed`，任務資料以 JSON 從 stdin 傳入（標題、提出者、討論串連結、PR 連結、摘要）。
- 要同步到哪裡由使用者自己寫腳本決定。

### 簡易模式（external）

- 頻道設定 `external: <指令>` 時，channelcollab 不透過 Agent SDK，而是把訊息 JSON 交給該指令，例如把提示詞塞進外部終端管理工具裡常駐的 Claude。
- 回覆由對方自己用 `channelcollab post` 送回。
- **只有文字往來**，沒有逐字輸出、按鈕、選單。完整過程到外部工具裡看。
- 範例腳本放在 `examples/`，不屬於核心。

---

## 10. 頂替模式（takeover）

使用者在**任何一個正在使用的互動式 Claude Code session** 裡執行 `/channelcollab:takeover <頻道或討論串>`，讓這個 session 頂替 Bot。之後 Discord 上對該目標的訊息不再由 Bot 自己啟動 SDK session 處理，而是轉送進這個互動式 session；Claude 用 `reply` 工具回到 Discord。`/channelcollab:handback` 交還。

### 流程

```
使用者的互動式 session
 │ /channelcollab:takeover <目標>
 │   skill 在背景啟動 channelcollab listen --target <目標>，
 │   用 Claude Code 內建的背景監聽機制（Monitor）掛著
 ▼
Discord 上有人 @Bot（目標頻道或討論串內）
 │ Bot 常駐程式：此目標正被頂替 → 不啟動自己的 session，經本機 IPC 轉給 listen
 ▼
listen 輸出一行（討論串 ID、發話者、內容；整則訊息壓成一行 JSON）
 │ 互動式 session 被喚醒，Claude 處理
 ▼
Claude 用 reply 工具（或 channelcollab post）回到討論串
 │ /channelcollab:handback → listen 結束 → 恢復由 Bot 處理
```

### 架構需求

- Bot 常駐程式在本機提供 IPC（named pipe 或 localhost HTTP，待定，見第 17 節），讓 `listen`、`post`、`reply` 能和它溝通。
- 互動式 session 裡沒有常駐程式的程序內 MCP，所以這裡的 `reply` 由 plugin 附帶的 MCP server 提供，經 IPC 請常駐程式發到 Discord。
- 頂替期間，Bot 不為該目標啟動自己的 session。
- 同一目標同時只能有一個頂替者；第二個 takeover 會被拒絕，並告知目前由誰頂替。
- 頂替的 session 結束或 listen 斷線時自動交還：listen 定期送心跳，逾時就視為交還。

### 好處

- 帶著使用者目前 session 的上下文接手（剛討論過的程式碼、做過的決定都還在）。
- 過程即時可見，使用者可以直接在終端機介入。
- 權限確認走終端機原本的提示。
- 只用 Claude Code 內建機制，不依賴任何外部終端管理工具。

### 注意事項

- 使用者的 session 正在忙時，訊息排隊：觸發訊息先掛 👀，輪到處理時改 ⚙️。
- 頂替模式下 Discord 的權限按鈕不適用（權限確認出現在使用者的終端機）。

### 頂替與接續的差別

| | 頂替（takeover） | 接續（resume） |
|---|---|---|
| 誰接管誰 | 使用者的 session 接管 Bot | 使用者用 `claude --resume <ID>` 打開 Bot 的 session |
| 帶的上下文 | 使用者的 | Bot 的（該討論串至今的對話） |
| 入口 | `/channelcollab:takeover`、`/channelcollab:handback` | 第 7 節 Phase B 的 `/terminal` |

---

## 11. 協作守則 skill

channelcollab 會在每個 session 附上一份協作守則（`--append-system-prompt` 或 skill），內容包含：

- 你是「OOO 的 Bot」，正在 Discord 討論串中與多人協作；訊息前綴標示了發話者。
- **只透過 `reply` / `mention` 發言**，你的其他輸出別人看不到。發言要簡短、只講結論。
- 小事直接做，**最多做到開 PR，不要 merge**。
- 需要快速選擇時，用 AskUserQuestion（會變成 Discord 選單）。
- 需要主人好好思考的決策：如果主人有安裝決策類的外部工具就交給它，然後回報「已交給主人決策」；沒有的話就 @ 主人。
- **只有要交棒時才 @ 其他 Bot**，提到別人時不要用 @。
- 完成時清楚說明做了什麼，並附上 PR 連結。

---

## 12. 名冊

- 記錄每個 Bot 的 Discord ID、主人、主人的 Discord ID、角色（工程師／企劃）、顯示名稱。
- 每個人的名冊放在自己的 `<HOME>\roster.json`，Bot 只讀這一份；沒有就當作空名冊。**不放在 plugin 裡**（repo 是公開的，plugin 只附假資料的 `roster.example.json`）。
- 發放方式：管理員的 `<HOME>\roster.json` 是正本，create-bot 建 Bot 時把整份名冊附進交付檔，成員 setup 匯入交付檔時一併寫入；名冊有異動時，管理員把 `roster.json` 傳給所有成員，各自 `/channelcollab:update-roster` 匯入。新名冊從下一個新對話開始生效，不用重啟 Bot。
- Bot 啟動時在 log 印出 `[roster] N bots from <路徑>`，方便確認讀到哪一份。
- 用途：提示詞中標示發話者；讓 Bot 知道怎麼找其他 Bot；判斷按鈕權限（誰是主人）。
- **放進提示詞**（每次啟動 session 時讀一次，附在系統提示詞後面）：
  - 自己是誰（名稱、ID）、主人是誰、角色。
  - 名冊上其他 Bot 的名稱、主人、角色，以及「要找它就在 reply 文字裡寫 `<@BotID>`」。對話紀錄中顯示的「@名稱」只是文字，照抄不會通知對方。
  - 協作守則：需要對方做事或回答時才 @；其他 Bot 向你提問或交辦時，回答裡 @ 它；自己要的答案拿到後直接做，不再 @ 對方；不要禮貌性地互 @ 道謝或寒暄；一輪只在最後一則 reply 放 @；任務完成就停，完成報告不 @ 任何 Bot；被 @ 但沒事要做時不呼叫 reply。
- 每則訊息的【發話者】／【最近訊息】若是名冊上的 Bot，會標上「主人 的 角色，ID」。
- reply 送出時 `allowedMentions` 是 `{ parse: ['users'] }`：Bot 也是 user，所以文字裡的 `<@BotID>` 會真的通知到對方。

---

## 13. 安裝

完整步驟見 `docs/企劃使用說明.md`（成員）與 `docs/管理員說明.md`（管理員）。

### 發佈管道

- 公開 GitHub repo `jijia-Huang/channelcollab`。repo 根目錄的 `.claude-plugin/marketplace.json` 宣告一個 plugin，`source` 是 `./plugin`。
- **repo 是公開的**：不能有 token、真實的 Discord ID 與帳號名稱、使用者本機路徑、公司或專案名稱。所以名冊不放在 plugin 裡（只附假資料的 `roster.example.json`），每個人的名冊在自己的 `<HOME>\roster.json`。
- 更新判斷依 `plugin/.claude-plugin/plugin.json` 的 `version`：**每次發佈都要改版本號**，否則成員收不到更新。

### Bot 執行檔怎麼隨 plugin 發佈

- `npm run build:plugin` 用 esbuild 把 `src/` 打包成 `plugin/runtime/bot.mjs`、`stop.mjs`（npm 套件不打包），並產生釘死版本的 `package.json`、`package-lock.json` 和 `version.json`（plugin 版本＋產物 hash）。這些產物**提交進 repo**，成員端不建置。
- plugin 安裝資料夾每次更新都會換新（舊的 14 天後刪除），所以 setup 把 runtime 複製到 `<HOME>\runtime\`，在那裡 `npm ci --omit=dev`（約 300 MB，主要是 Agent SDK 內建的平台專屬 CLI，只能由 npm 依平台安裝）。
- `start` 每次比對 `<HOME>\runtime\version.json` 與 plugin 內的版本，不同就自動重新安裝（Bot 必須先停止）。
- 需要 Node 22 以上。setup 偵測不到時**不代裝**，請使用者執行 `winget install OpenJS.NodeJS.LTS` 後重開終端機。單一 exe 打包（Phase 0-1）延後。

### 管理員（每新增一人）

1. `/channelcollab:create-bot`（幫成員建）：在 Team 底下建 Bot → token 經剪貼簿存成交付檔（`save-token --for member --owner-id <成員 Discord ID>`）→ 驗證、邀請進伺服器 → `roster --handoff <交付檔>` 更新管理員的 `<HOME>\roster.json`，並把整份名冊附進交付檔。
2. 交付檔裡是明文 token：用私下管道交給本人，對方匯入後雙方都刪除。
3. 名冊有異動時，把 `<HOME>\roster.json` 傳給所有成員，請大家 `/channelcollab:update-roster`。

### 成員

1. 安裝 Node 22（若沒有）。
2. `claude plugin marketplace add jijia-Huang/channelcollab`、`claude plugin install channelcollab@channelcollab`。
3. `/channelcollab:setup`：檢查 Node → 安裝 runtime → 匯入交付檔（token、`discord.owner_id`、名冊；之後提醒刪除交付檔）→ 綁定第一個頻道（`permission_mode` 一律 `default`）→ 啟動並確認上線 → 在桌面建立啟動／停止的 `.bat`。
4. 之後用 `/channelcollab:bind` 綁更多頻道，`/channelcollab:start`／`stop`／`status` 管理 Bot。

### 啟動與停止（兩種方式，效果相同）

- **桌面雙擊**：setup 用總控 `shortcut` 在桌面產生「啟動 channelcollab Bot.bat」「停止 channelcollab Bot.bat」（桌面位置向系統查詢，OneDrive 重新導向也正確）。`.bat` 執行 `<HOME>\runtime\ctl.mjs`（總控腳本的複本，每次 start／install-runtime／shortcut 都會同步），所以 plugin 更新後路徑仍有效；node 用產生時的絕對路徑，找不到再用 PATH 上的。
- **Claude Code 斜線指令**：`/channelcollab:start`、`/channelcollab:stop`、`/channelcollab:status`，呼叫 plugin 裡同一支總控腳本。
- `start`：Bot 以 detached、隱藏視窗的子程序在背景執行，stdout／stderr 寫到 `<HOME>\bot.log`／`bot.err.log`（上一次的改名為 `bot.prev*.log`），等 log 出現 `[ready]`（最多 90 秒）後回報登入身分與綁定的頻道。已經在跑（停止用的 named pipe 連得上）就只回報「已在執行中」，不重複啟動。
- `stop`：執行 runtime 的 `stop.mjs`（同 `npm run stop`），再確認 Bot 程序和停止前記下的子孫程序都已結束。
- **開機自動啟動暫不提供**：用工作排程器註冊登入工作的做法，在開發環境被 Claude Code 自動模式判定為未授權的常駐設定而擋下；使用者決定改成桌面雙擊。Phase 0-7 維持未驗證。

---

## 14. 資料夾結構

```
channelcollab/                        （repo 根目錄 = marketplace 根目錄）
├─ PLAN.md
├─ package.json                       開發用；npm run build:plugin／test:plugin
├─ .claude-plugin/marketplace.json    marketplace：一個 plugin，source ./plugin
├─ scripts/
│   └─ build-plugin.mjs               src/ → plugin/runtime/
├─ src/                               Bot 本體（TypeScript）
│   ├─ main.ts                        進入點（npm start）
│   ├─ stop.ts                        npm run stop
│   ├─ config.ts、log.ts、roster.ts
│   ├─ discord/                       收發、按鈕、選單、表情、詳細
│   ├─ router/                        觸發判斷、轉手計數、排隊
│   ├─ runner/                        Agent SDK 驅動、啟動器、session 池
│   └─ store/                         本機狀態（state.json）
├─ plugin/                            plugin 根目錄
│   ├─ .claude-plugin/plugin.json     名稱 channelcollab、版本
│   ├─ README.md
│   ├─ roster.example.json            名冊格式範例（假資料）
│   ├─ runtime/                       建置產物（進 repo）：bot.mjs、stop.mjs、package.json、package-lock.json、version.json
│   ├─ scripts/channelcollab.mjs      總控：check、install-runtime、set-owner、bind、import-roster、start、stop、status、shortcut
│   └─ skills/
│       ├─ setup/                     /channelcollab:setup
│       ├─ bind/                      /channelcollab:bind
│       ├─ start/、stop/、status/     /channelcollab:start、stop、status
│       ├─ update-roster/             /channelcollab:update-roster
│       ├─ guidelines/                協作守則（給人看；與 src 的提示詞一致）
│       └─ create-bot/                管理員用：建 Bot、交付檔、名冊
├─ docs/
│   ├─ 企劃使用說明.md
│   └─ 管理員說明.md
└─ examples/                          （預定）簡易模式範例

成員電腦上的 HOME（%USERPROFILE%\.channelcollab 或 CHANNELCOLLAB_HOME）
├─ config.json                        含 token，只透過腳本修改
├─ roster.json                        名冊
├─ state.json、bot.pid
├─ bot.log、bot.err.log、bot.prev*.log
└─ runtime/                           bot.mjs、stop.mjs、ctl.mjs、node_modules、version.json
```

預定但尚未實作：`skills/takeover/`、`skills/handback/`（頂替模式，Phase 4）、`src/ipc/`、`src/external/`。

---

## 15. 分階段計畫

### Phase 0：驗證假設

spike 程式與輸出在 `spike/`（`sdk-hello.ts`、`launcher-test.ts`、`output-*.txt`），環境：Agent SDK 0.3.314、Node 22、Windows 11。

| # | 驗證項目 | 通過條件 | 結果 |
|---|---|---|---|
| 0-1 | Bun 打包含 Agent SDK 的單一 exe | 能打包，並在乾淨的電腦上執行 | 延後：改用 esbuild 打包＋成員端 `npm ci`（見第 13 節），成員需自行安裝 Node 22 |
| 0-2 | 該 exe 在本人與一位企劃的電腦上 | 沒有被防毒擋下 | 未驗證 |
| 0-3 | Agent SDK 使用每個人自己的 Claude Code 登入 | 不需要 API key 也能跑；**同時向公司確認 Team 方案的使用規範** | ✅ 技術面：init 回報 `apiKeySource=none`，環境中無 API key 仍正常完成。使用規範尚待向公司確認 |
| 0-4 | Agent SDK 載入使用者設定、skills、plugins | session 中看得到使用者的 skills 和 MCP | ✅ `settingSources: ['user','project']` 下 init 列出 37 個 skills、8 個使用者 MCP、10 個 plugins |
| 0-5 | 自訂啟動器（.cmd 包裝）透傳 | 完整串流、權限回呼都正常 | ✅ 經 `spawnClaudeCodeProcess` + `cmd.exe /d /s /c`（雙層 `^` 跳脫）：wrapper 紀錄兩次啟動、`claude.exe` 為 wrapper 的子程序、`canUseTool` 擋下 Write、resume 記得上一輪、含中文／引號／`% ^ & \| !` 的參數原樣送達。❌ 直接把 `.cmd` 設為 `pathToClaudeCodeExecutable`：Node 丟 `spawn EINVAL` |
| 0-6 | `defer` 之後程序結束，再 resume | 能從存檔接續並取得使用者的回答 | 未驗證（一般的 resume 已通過，`defer` 尚未測） |
| 0-7 | 開機自動啟動的程序呼叫 Claude | 認證正常 | 未驗證 |
| 0-8 | Agent SDK 程序內 MCP 工具（`reply` 等） | Claude 能呼叫，且在使用者自訂啟動器下也正常 | ✅ `reply` 工具狀態 connected 並被呼叫；直接啟動與 .cmd 啟動器下都正常（spike 設 `alwaysLoad: true`） |
| 0-9 | 頂替模式：Monitor 背景監聽喚醒互動式 session | listen 輸出一行時能喚醒閒置中的互動式 session，且 session 能用 reply／post 回應 | 未驗證 |
| ✅ | 串流輸入、權限回呼、session 接續 | AsyncIterable 輸入、`canUseTool` 能拒絕、同 cwd resume 記得上一輪 | ✅ 皆通過。前提：`permissionMode` 明確設 `default`；被 allow 規則放行的工具不會呼叫 `canUseTool`（見第 8 節） |
| ✅ | 同伺服器 Bot 互看訊息 | 使用者已實測確認 | ✅ |

### 目前狀態（總覽）

| Phase | 狀態 |
|---|---|
| 0 驗證假設 | 0-3、0-4、0-5、0-8 與串流／resume ✅；0-1、0-2（單一 exe）延後；0-6、0-7、0-9 未驗證 |
| 1 單人跑通 | ✅ 已完成並在 Discord 實測；另外做了常駐 session（一個討論串一個持續運作的 `query()`，不必每輪重啟 CLI） |
| 2 互動功能 | ✅ 權限按鈕、選擇題、🛑 停止、附檔、長輸出切段、排隊，都已在 Discord 實測 |
| 3 多人化 | 大部分 ✅：多 Bot、名冊、觸發規則、轉手上限、多人權限、協作守則、setup／bind／start／stop／status／update-roster、create-bot、marketplace 打包。未做：`post`／`resume` 指令、`on.task_completed`。開機自動啟動改成桌面 `.bat` 與斜線指令 |
| 4 進階體驗 | 未開始 |

### Phase 1：單人跑通 ✅

- 一個 Bot、一個**文字頻道**、`launcher` 留空（用 SDK 內建的 CLI）。
- 在主頻道被 @ → 從那則訊息開一個公開討論串 → 狀態表情 → Claude 用 `reply` 回話 → 完成；「📄 詳細」按鈕。之後在討論串裡任何人發言都會觸發。
- 討論串 ↔ session 接續（每輪一次 `query()`，以 `resume` 接續）；同一討論串執行中的新訊息排隊；基本的轉手上限。
- 權限簡化版：需要確認的工具一律拒絕，並在討論串留言提示（按鈕留到 Phase 2）。
- **論壇頻道與論壇標籤延到後面的 Phase**（`set_status` 一併延後）。
- **驗收**：在 Discord 上跟自己的 Claude 連續對話、改程式，體驗流暢。

### Phase 2：互動功能 ✅

- 權限按鈕、選擇題選單、🛑 Stop、附檔、長輸出切段、排隊。
- **驗收**：一件需要權限確認和選擇題的任務，可以完全在 Discord 上完成。

### Phase 3：多人化（大部分完成）

- ✅ 名冊、觸發規則、轉手上限、多人權限規則、協作守則。
- ✅ `/channelcollab:setup`、`/channelcollab:bind`、`start`／`stop`／`status`、`update-roster`、`create-bot`、marketplace 打包（隔離環境安裝測試通過）。
- ✅ 啟動方式：桌面 `.bat` 與斜線指令（取代原定的開機自動啟動，見第 13 節）。
- 未做：`post`、`resume` 指令（含常駐程式的本機 IPC）；`on.task_completed`。
- **驗收**：企劃照 `install.md` 在 5 分鐘內裝好；企劃 @ 你的 Bot → 你的 Bot 反問企劃 → 企劃在選單作答 → 完成並開 PR。

### Phase 4：進階體驗

- 第 7 節 Phase B 的功能；簡易模式範例。
- 頂替模式（第 10 節）：`channelcollab listen`、`/channelcollab:takeover`、`/channelcollab:handback`、心跳逾時自動交還。沿用 Phase 3 為 `post` 建好的本機 IPC。
- **頂替模式驗收**：在互動式 session 執行 takeover → Discord 上 @Bot → 該 session 被喚醒並回覆到討論串 → handback 後恢復由 Bot 處理。

---

## 16. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 公司防毒擋 exe | 無法安裝 | Phase 0-2 最先驗證；被擋就找 IT 加白名單 |
| Agent SDK 搭配訂閱登入的使用規範 | 可能不被允許 | Phase 0-3 先確認；替代方案是直接走 CLI 的 stream-json 協定 |
| Bun 打包 Agent SDK 失敗 | 企劃要自己裝 Node | 改成附帶 Node 執行環境的安裝包 |
| 多個討論串同時執行，吃光額度 | 用量爆掉 | 全域同時執行上限、`/usage` 顯示 |
| 主人不在，權限確認卡住 | 任務停滯 | `defer` 讓程序先結束；狀態表情顯示 ⏳ 並標示「等待 OOO 確認」 |
| Claude 忘了呼叫 `reply` | 使用者沒收到回應 | 一輪結束時沒有 reply，就自動貼出最後一段文字的摘要 |
| 單輪成本約 $0.2（Opus，Phase 0 實測） | 多人頻繁使用時費用或額度吃緊 | 頻道設定可指定 `model`（Haiku 單輪不到 $0.01）；搭配全域同時執行上限 |
| `.cmd` 啟動器的參數跳脫與中止 | 參數被截斷或被當成指令執行；Stop 後留下孤兒 `claude.exe` | 由 channelcollab 統一以 `cmd.exe /d /s /c` 加雙層跳脫啟動（Phase 0-5 已驗證）；中止時結束整個程序樹 |
| Discord 資料在境外雲端 | 公司政策疑慮 | Discord 層獨立成模組，必要時改接其他自架聊天平台 |
| Discord token 以明文存在 `config.json` | 檔案外流或被誤提交時 token 洩漏 | 檔案只放在使用者目錄、不進版本控制；外流時到 Developer Portal Reset Token。之後可評估改存 Windows 認證管理員 |

---

## 17. 待討論

0. **session 的綁定方式（暫緩）**：目前維持「一個討論串 = 一個 session」。替代方案是「一個頻道（repo）一個常駐 session，用 reply 指定回到哪個討論串」，**使用者初步覺得可行**，之後再詳談。
1. **`busy_policy` 預設值**：多人環境下，別人的新訊息應該打斷正在跑的工作，還是排隊？目前預設排隊。
2. **論壇標籤**有哪幾個？名稱要叫什麼？
3. **「完成」由誰標記**：提出需求的人、主人，還是 Claude 開完 PR 自動標記成「待驗收」？
4. **全域同時執行上限**：預設幾件？
5. **一般頻道被 @ 時**：一律開討論串，還是短問答直接回覆？
6. 協作守則中「小事」的定義與範例。
7. **常駐程式的本機 IPC**（頂替模式、`post`、`reply` 共用）：用 named pipe 還是 localhost HTTP？

---

## 附錄：建一個 Bot（每人約 3 分鐘）

1. Developer Portal → Team → **New Application**，名稱例如「範例Bot」。
2. **Bot** 頁籤：Reset Token 並複製；打開 **Message Content Intent**；關閉 **Public Bot**。
3. **OAuth2 → URL Generator**：Scopes 勾 `bot` 和 `applications.commands`（斜線指令需要）；權限勾 View Channels、Send Messages、Create Public Threads、Send Messages in Threads、Manage Threads（改論壇標籤需要）、Read Message History、Add Reactions、Attach Files、Embed Links。
4. 開啟產生的網址，把 Bot 拉進伺服器。
