---
name: stop
description: 正常停止自己的 channelcollab Discord Bot，並確認沒有殘留程序。效果和雙擊捷徑「停止 <Bot 名稱>.bat」相同。使用者說「停止 Bot」「關掉 Bot」「Bot 先停一下」「stop」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 停止 Bot

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
   - 2 隻以上：用 AskUserQuestion 問「要停止哪一隻 Bot？」，每隻 Bot 一個選項（標籤用 Bot 名稱，說明寫目前執行中或沒有執行），再加一個「全部」。選了某一隻就加 `--home "<那一隻的 home>"`，選「全部」就加 `--all`。

## 停止

執行（指令逾時設 2 分鐘；`--all` 時每隻 2 分鐘）：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" stop [--home "<資料夾>" | --all]
```

- 停止前腳本會先問 Bot 是不是正在工作：「⚙️ Bot 正在工作：私訊、討論串「…」」表示有進行中的工作，「Bot 目前閒置」表示沒有，「無法確認」表示 Bot 還沒登入完成或是舊版。**有工作時要清楚告訴使用者是哪一隻、在哪個對話裡**；停止的方式和平常一樣，不會另外等待。
- 使用者在停止**之前**就問「有沒有在工作」時，先跑 `status`（同樣可以加 `--all`），看「正在工作」那一行，讓使用者決定要不要現在停。
- Bot 會先結束所有進行中的對話（執行到一半的那一輪會標成 ❌），再自己退出；60 秒內沒退出才強制結束。
- `--all` 會逐一停止每一隻，最後一行「總結：…」列出停止了哪些、本來就沒在執行的、失敗的，以及停止時正在工作的 Bot。某一隻失敗不影響其他隻。
- 「✅ Bot 已停止 … 沒有殘留程序」：完成。
- 「Bot 沒有在執行」：本來就停了。
- 有殘留程序：把腳本列出的 PID 告訴使用者，建議的 `taskkill` 指令先讓使用者確認再執行。

**不要用 `taskkill`、`Stop-Process` 直接殺 node**：那樣不會正常收尾，而且可能殺到同一台電腦上的其他 Bot 或程式。

