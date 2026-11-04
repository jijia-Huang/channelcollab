---
name: status
description: 查看自己的 channelcollab Discord Bot 狀態：是否在執行、登入成哪個 Bot、主人、綁定了哪些頻道、私訊設定、PIN 與白名單、執行環境版本、最近的錯誤。使用者說「Bot 狀態」「Bot 有沒有在跑」「Bot 不回應」「status」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# Bot 狀態

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" status
```

使用者指定了別的 HOME 時加 `--home "<資料夾>"`。需要給程式判斷時加 `--json`（最後一行 `RESULT {...}`）。

把結果用白話整理給使用者：在不在跑、登入成誰、綁了哪些頻道、私訊有沒有開、PIN 和白名單的狀態。有問題時給下一步：

| 狀況 | 建議 |
|---|---|
| Bot 沒有在執行 | `/channelcollab:start` |
| token 未設定 | `/channelcollab:setup` 匯入交付檔 |
| 主人 Discord ID 未設定 | `node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" set-owner <自己的 Discord 使用者 ID>`，否則沒人能按權限按鈕 |
| 沒有綁定任何頻道 | `/channelcollab:bind` |
| PIN 未設定 | 建議設定：`node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" set-pin`（會跳出視窗，由使用者自己輸入；不要叫他把 PIN 打在對話裡）。私訊沒有 PIN 不會開放 |
| PIN 鎖定中 | 整隻 Bot 暫停中。確認是本人輸錯後，執行 `unlock`（或雙擊桌面的「解除 channelcollab 鎖定」），在跳出的視窗輸入 y |
| 私訊未開啟，但使用者想用 | `/channelcollab:bind` 的私訊段落（`bind --dm --cwd …`） |
| 白名單關閉 | 伺服器裡任何人都能叫 Bot；建議 `access --roster-only on` |
| 有人 @ Bot 沒反應，但 Bot 在跑 | 白名單只讓主人和名冊上的人叫 Bot；用 `/channelcollab:roster` 把對方加進名冊 |
| 名冊是空的 | 可以用 `/channelcollab:roster` 把常合作的人和 Bot 加進來（只要 Discord ID） |
| runtime 不是最新 | 下次 `/channelcollab:start` 會自動更新（要先 stop） |
| 在跑，但在 Discord @ 它沒反應 | 確認是在綁定的頻道（或其底下的討論串）裡 @；檢查「最近的錯誤」；仍不行就 stop 再 start |

完整 log 在 `<HOME>\bot.log`、`<HOME>\bot.err.log`（上一次執行的在 `bot.prev.log`）。log 不含 token，需要時可以讀最後幾十行來判斷問題；**不要讀 `config.json`**（裡面有 token）。
