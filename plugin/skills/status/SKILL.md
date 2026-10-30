---
name: status
description: 查看自己的 channelcollab Discord Bot 狀態：是否在執行、登入成哪個 Bot、主人、綁定了哪些頻道、執行環境版本、最近的錯誤。使用者說「Bot 狀態」「Bot 有沒有在跑」「Bot 不回應」「status」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# Bot 狀態

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" status
```

使用者指定了別的 HOME 時加 `--home "<資料夾>"`。需要給程式判斷時加 `--json`（最後一行 `RESULT {...}`）。

把結果用白話整理給使用者：在不在跑、登入成誰、綁了哪些頻道。有問題時給下一步：

| 狀況 | 建議 |
|---|---|
| Bot 沒有在執行 | `/channelcollab:start` |
| token 未設定 | `/channelcollab:setup` 匯入交付檔 |
| 主人 Discord ID 未設定 | `node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" set-owner <自己的 Discord 使用者 ID>`，否則沒人能按權限按鈕 |
| 沒有綁定任何頻道 | `/channelcollab:bind` |
| 名冊不存在 | 向管理員要 `roster.json`，用 `/channelcollab:update-roster` 匯入 |
| runtime 不是最新 | 下次 `/channelcollab:start` 會自動更新（要先 stop） |
| 在跑，但在 Discord @ 它沒反應 | 確認是在綁定的頻道（或其底下的討論串）裡 @；檢查「最近的錯誤」；仍不行就 stop 再 start |

完整 log 在 `<HOME>\bot.log`、`<HOME>\bot.err.log`（上一次執行的在 `bot.prev.log`）。log 不含 token，需要時可以讀最後幾十行來判斷問題；**不要讀 `config.json`**（裡面有 token）。
