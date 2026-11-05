---
name: handoff
description: 把電腦上目前這個 Claude Code 對話交給自己的 channelcollab Bot，改在手機（Discord）上繼續：預設交到私訊，也可以開在 Bot 綁定頻道的新討論串。之後在那裡傳訊息，Bot 就接著這個 session 做。使用者說「交給 Bot」「我要出門，改在手機上繼續」「交棒到 Discord」「handoff」時使用。
argument-hint: "[私訊|頻道名稱]"
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 交給手機（Discord）

把**這個對話本身**（session ID `${CLAUDE_SESSION_ID}`）交給 Bot。Bot 之後在 Discord 上用 `--resume` 接著做，看得到這裡到目前為止的全部內容。

`ctl` 代表 `node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs"`。

## 1. 選 Bot 和地點

- `ctl homes`：有好幾隻 Bot 時用 AskUserQuestion 列出名稱請使用者選；沒在執行的要先 `/channelcollab:start`。
- 預設交到**私訊**（只有主人看得到）。使用者要給團隊看時，`ctl targets --home "<HOME>"` 列出綁定的頻道，用 AskUserQuestion 選頻道，會開一個新討論串（標題用一句話講主題）。

## 2. 寫交棒摘要

照這個對話寫一份簡短摘要：目前在做什麼、做到哪、下一步、注意事項（例如還沒 commit 的檔案）。手機上看，條列、短句。交到團隊頻道時先給使用者看過再送。

把摘要用 Write 存成暫存檔（UTF-8），不要放在命令列。

## 3. 交棒

```
ctl handoff --home "<HOME>" --session "${CLAUDE_SESSION_ID}" --cwd "<這個對話的工作資料夾>" [--channel "<頻道>" --title "<討論串標題>"] --summary-file "<暫存檔>"
```

- 工作資料夾以這個 session 自己的為準（Bot 會照 session 紀錄裡的資料夾跑）。和私訊平常設定的資料夾不同時，Bot 會說明，這次照 session 的資料夾跑；在私訊打 `/clear` 之後回到平常的資料夾。
- Bot 用私訊（或那個頻道）設定的啟動器接這個 session。這裡用的設定（例如另外載入的 skill、MCP）和 Bot 的不同時，對話內容照樣接得上，但 Bot 那邊只有它自己的工具；之前用過、Bot 那邊沒有的工具，Claude 會改用別的方法。
- 私訊的 PIN 規則照舊：超過免輸入時間時，手機上要先輸入 PIN 解鎖。

## 4. 收尾（必要）

把腳本印的結果告訴使用者（交到哪裡、連結），刪掉暫存檔，並**明確提醒：關掉這個對話（/exit），不要再在電腦上繼續**。兩邊同時寫同一個 session，之後只會保留其中一邊的內容。
