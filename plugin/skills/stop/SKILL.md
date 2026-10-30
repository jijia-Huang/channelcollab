---
name: stop
description: 正常停止自己的 channelcollab Discord Bot，並確認沒有殘留程序。效果和桌面的「停止 channelcollab Bot.bat」相同。使用者說「停止 Bot」「關掉 Bot」「Bot 先停一下」「stop」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 停止 Bot

執行（指令逾時設 2 分鐘）：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" stop
```

使用者指定了別的 HOME 時加 `--home "<資料夾>"`。

- Bot 會先結束所有進行中的對話（執行到一半的那一輪會標成 ❌），再自己退出；60 秒內沒退出才強制結束。
- 「✅ Bot 已停止 … 沒有殘留程序」：完成。
- 「Bot 沒有在執行」：本來就停了。
- 有殘留程序：把腳本列出的 PID 告訴使用者，建議的 `taskkill` 指令先讓使用者確認再執行。

**不要用 `taskkill`、`Stop-Process` 直接殺 node**：那樣不會正常收尾，而且可能殺到同一台電腦上的其他 Bot 或程式。

