---
name: start
description: 在背景啟動自己的 channelcollab Discord Bot，並回報是否上線、登入成哪個 Bot、綁了哪些頻道。效果和桌面的「啟動 channelcollab Bot.bat」相同。使用者說「啟動 Bot」「開 Bot」「Bot 沒上線」「start」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 啟動 Bot

執行（指令逾時設 3 分鐘；執行環境需要更新時會先自動安裝，可能要更久）：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" start
```

使用者指定了別的 HOME 時加 `--home "<資料夾>"`。

腳本會讓 Bot 在背景獨立執行（關掉這個 Claude Code 也不會停），等它上線後印出登入身分和綁定的頻道。把結果用白話告訴使用者：

- 「✅ Bot 已上線：登入成 …」：回報 Bot 名稱和綁定的頻道，告訴使用者可以到這些頻道 @ 它。
- 「✅ Bot 已經在執行中」：不會重複啟動。一樣回報登入身分和綁定的頻道。
- 沒有綁定任何頻道：提醒用 `/channelcollab:bind` 綁定，否則 Bot 不會回應任何訊息。
- 「沒有 Bot token」：還沒設定過，請使用者執行 `/channelcollab:setup`。
- 「需要 Node 22 以上」：請使用者在終端機執行 `winget install OpenJS.NodeJS.LTS`，裝完重開終端機和 Claude Code。不要自己安裝。
- 啟動失敗：把腳本印出的錯誤重點轉述給使用者。常見原因是 token 失效（向管理員要新的交付檔，再跑 `/channelcollab:setup`）、網路連不到 discord.com。

要停止用 `/channelcollab:stop`，或雙擊桌面的「停止 channelcollab Bot.bat」。
