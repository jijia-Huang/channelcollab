---
name: report
description: 用自己的 channelcollab Bot，把在電腦上 Claude Code 做完的工作整理成摘要，貼到 Bot 綁定的團隊頻道（可以開新討論串、附檔）。這是對外發文，送出前一定先給使用者確認。使用者說「用 Bot 回報到群組」「貼到頻道」「跟團隊報告一下」「發到 Discord」「回報給大家」時使用。
argument-hint: "[頻道名稱] [要回報的重點]"
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 用 Bot 回報到群組

把這個 Claude Code 對話裡做完的事，經**執行中的 Bot** 貼到它綁定的頻道。腳本不讀 token，只透過 Bot 的 named pipe 請 Bot 發文；Bot 沒在跑時會提示先啟動。

以下指令的 `ctl` 代表：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs"
```

## 1. 選 Bot

```
ctl homes
```

- 只有一隻：直接用它的 `--home`。
- 有好幾隻：用 AskUserQuestion 列出各 Bot 的名稱（選項 label 用 Bot 名稱，description 寫 HOME 路徑），請使用者選。
- 選到的 Bot 是「⏹ 沒有執行」：請使用者先用 `/channelcollab:start` 啟動（或 `ctl start --home "<HOME>"`），不要自己改用別的方法發文。

## 2. 選頻道

```
ctl targets --home "<HOME>"
```

列出這隻 Bot 可以貼的頻道（名稱和 ID）。**只能貼到這些頻道**（或它們底下的討論串），不在清單上的不能貼。使用者沒指定時用 AskUserQuestion 問：貼在哪個頻道、要不要開新討論串（建議開，標題用一句話講主題）。

## 3. 整理摘要，給使用者確認（必要）

照這個對話的內容寫一份給團隊看的摘要：做了什麼、結果（PR、分支、檔案）、還沒做完或需要別人做的事。簡短、條列，像在 Discord 上跟同事報告。可以 `<@ID>` 提到要通知的人（Bot 自己會標明是誰的工作回報，不用寫「我是誰的 Bot」）。

**送出前一定要給使用者看完整的內容**，並用 AskUserQuestion 確認：「送出」「修改」「取消」。這是對外發文，使用者沒選「送出」就不要送。附檔也要列出來確認。

## 4. 送出

把確認過的文字用 Write 存成暫存檔（例如系統暫存資料夾裡的 `channelcollab-report.md`，UTF-8），**不要**把內容放在命令列（跳脫容易出錯）：

```
ctl post --home "<HOME>" --channel "<頻道 ID 或名稱>" [--new-thread "<討論串標題>"] [--file "<檔案>"]... --text-file "<暫存檔>" --session "${CLAUDE_SESSION_ID}" --cwd "<這個對話的工作資料夾>"
```

- `--thread <討論串 ID>`：改貼到那個頻道底下既有的討論串。
- `--file` 可以給好幾次，一則最多 10 個；channelcollab 的資料夾、`.ssh`、`.env` 之類的禁區檔案不能附。
- `--session`：開新討論串時，之後在那個討論串 @ Bot，Bot 會從這個對話**複製一份**接著做（這個對話本身不受影響）。

送出後把腳本印的「連結：…」給使用者，然後刪掉暫存檔。失敗時照錯誤訊息說明（例如頻道沒綁定、Bot 沒在執行、Bot 是舊版要重啟）。
