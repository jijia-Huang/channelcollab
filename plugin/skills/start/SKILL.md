---
name: start
description: 在背景啟動自己的 channelcollab Discord Bot，並回報是否上線、登入成哪個 Bot、綁了哪些頻道。效果和雙擊捷徑「啟動 <Bot 名稱>.bat」相同。使用者說「啟動 Bot」「開 Bot」「Bot 沒上線」「start」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 啟動 Bot

## 先決定要處理哪一隻 Bot

同一台電腦可以有好幾隻 Bot（每隻一個 HOME 資料夾、各自一個程序）。

1. 使用者已經指定資料夾（`--home`）或 Bot 名稱：直接處理那一隻。
2. 使用者說「兩隻」「全部」「所有 Bot」：直接加 `--all`，不用再問。
3. 都沒說時，先列出這台電腦上的 Bot：

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" homes --json
   ```

   最後一行是 `RESULT [{"home": …, "name": …, "running": …}, …]`。
   - 0 或 1 隻：照舊，不加 `--home`（只有一隻且不在預設資料夾時，加那一隻的 `--home`）。
   - 2 隻以上：用 AskUserQuestion 問「要啟動哪一隻 Bot？」，每隻 Bot 一個選項（標籤用 Bot 名稱，說明寫目前執行中或沒有執行），再加一個「全部」。選了某一隻就加 `--home "<那一隻的 home>"`，選「全部」就加 `--all`。

## 啟動

執行（指令逾時設 3 分鐘；執行環境需要更新時會先自動安裝，可能要更久；`--all` 時每隻最多再加 3 分鐘）：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" start [--home "<資料夾>" | --all]
```

`--all` 會逐一啟動每一隻，每隻前面有一行 `=== 1/2　<Bot 名稱>（<資料夾>）`，最後一行是「總結：…」。某一隻失敗（例如沒有 token）不影響其他隻；把每一隻的結果分別告訴使用者。

腳本會讓 Bot 在背景獨立執行（關掉這個 Claude Code 也不會停），等它上線後印出登入身分和綁定的頻道。把結果用白話告訴使用者：

- 「✅ Bot 已上線：登入成 …」：回報 Bot 名稱、模式（只用私訊時沒綁頻道是正常的）和綁定的頻道，告訴使用者可以到這些頻道 @ 它。
- 「✅ Bot 已經在執行中」：不會重複啟動。一樣回報登入身分和綁定的頻道。
- 沒有綁定任何頻道：提醒用 `/channelcollab:bind` 綁定，否則 Bot 不會回應任何訊息。
- 「沒有 Bot token」：還沒設定過，請使用者執行 `/channelcollab:setup`。
- 「需要 Node 22 以上」：請使用者在終端機執行 `winget install OpenJS.NodeJS.LTS`，裝完重開終端機和 Claude Code。不要自己安裝。
- 啟動失敗：把腳本印出的錯誤重點轉述給使用者。常見原因是 token 失效（向管理員要新的交付檔，再跑 `/channelcollab:setup`）、網路連不到 discord.com。

要停止用 `/channelcollab:stop`，或雙擊捷徑「停止 <Bot 名稱>.bat」（0.1.5 以前建的叫「停止 channelcollab Bot.bat」）。有好幾隻 Bot 時，也可以雙擊 `shortcut --all` 建立的「啟動全部 Bot.bat」「停止全部 Bot.bat」（在 `%USERPROFILE%\.channelcollab\launchers`）。
