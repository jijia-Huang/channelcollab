---
name: status
description: 查看自己的 channelcollab Discord Bot 狀態：是否在執行、登入成哪個 Bot、主人、模式（只用私訊／團隊頻道／兩者）、綁定了哪些頻道、私訊設定、PIN 與白名單、執行環境版本、最近的錯誤。使用者說「Bot 狀態」「Bot 有沒有在跑」「Bot 不回應」「status」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# Bot 狀態

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" status
```

使用者指定了別的 HOME 時加 `--home "<資料夾>"`。需要給程式判斷時加 `--json`（最後一行 `RESULT {...}`）。

把結果用白話整理給使用者：在不在跑、登入成誰、**模式**、綁了哪些頻道、私訊有沒有開、PIN 和白名單的狀態。有問題時給下一步。

`模式：` 有四種：「只用私訊」（只有私訊設定，**沒綁頻道是正常的，不要當成問題**）、「團隊頻道協作」、「團隊頻道協作＋私訊」、「還沒設定」（沒綁頻道也沒開私訊，這時才請使用者設定）。

PIN 和鎖定的提示會指向**實際存在的捷徑檔**（檔名帶 Bot 名稱，例如「設定 小明Bot PIN.bat」，由 `shortcut` 建立）；找不到檔案時改成顯示要在終端機執行的指令，照著轉述即可。

| 狀況 | 建議 |
|---|---|
| Bot 沒有在執行 | `/channelcollab:start` |
| token 未設定 | `/channelcollab:setup` 匯入交付檔 |
| 主人 Discord ID 未設定 | `node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" set-owner <自己的 Discord 使用者 ID>`，否則沒人能按權限按鈕 |
| 模式「還沒設定」 | 要團隊協作就 `/channelcollab:bind` 綁頻道；只想私訊就 `/channelcollab:bind` 的私訊段落（`bind --dm --cwd …`，並設定 PIN），或重跑 `/channelcollab:setup` 選「只用私訊」 |
| 模式「只用私訊」，使用者想加入團隊頻道 | Bot 要先被邀進那個伺服器，再用 `/channelcollab:bind` 綁頻道就好，不用重新 setup |
| PIN 未設定 | 開了私訊時是 ❌（私訊沒有 PIN 不會開放），否則建議設定：`node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" set-pin`（會跳出視窗，由使用者自己輸入；不要叫他把 PIN 打在對話裡），或照 status 提示雙擊捷徑 |
| PIN 鎖定中 | 整隻 Bot 暫停中（斜線指令會回「已鎖定」）。確認是本人輸錯後，執行 `unlock`（或照 status 提示雙擊「解除 <Bot 名稱> 鎖定.bat」），在跳出的視窗輸入 y |
| 私訊未開啟，但使用者想用 | `/channelcollab:bind` 的私訊段落（`bind --dm --cwd …`） |
| 白名單關閉 | 伺服器裡任何人都能叫 Bot；建議 `access --roster-only on` |
| 有人 @ Bot 沒反應，但 Bot 在跑 | 白名單只讓主人和名冊上的人叫 Bot；用 `/channelcollab:roster` 把對方加進名冊 |
| 名冊是空的 | 可以用 `/channelcollab:roster` 把常合作的人和 Bot 加進來（只要 Discord ID） |
| runtime 不是最新 | 下次 `/channelcollab:start` 會自動更新（要先 stop） |
| 在跑，但在 Discord @ 它沒反應 | 確認是在綁定的頻道（或其底下的討論串）裡 @；檢查「最近的錯誤」；仍不行就 stop 再 start |
| 私訊 Bot 沒反應 | 和 Bot 要有共同的伺服器；只接受主人（主人 ID 要是自己）；🔒 時要按「解鎖」輸入 PIN |
| 打 `/` 沒看到 Bot 的指令 | 斜線指令在 Bot 啟動時註冊，剛註冊可能要幾分鐘才出現，重開 Discord 可以刷新；bot.log 有 `[commands] registered … global slash commands` 表示註冊成功（`registration failed` 則看後面的原因）。同一個伺服器有好幾隻 Bot 時，選單依 Bot 分組，要選自己這隻 |
| 想看某段對話的努力程度、單輪上限、是不是在電腦上接手中 | 在 Discord 那段對話裡打 `/status`；總控 `status` 只顯示綁定的設定（努力程度、單輪工作與步數上限） |
| 對話一直回「主人在電腦上接手中」 | 那段對話被 `/channelcollab:takeover` 接到電腦上了：在接手的視窗用 `/channelcollab:release` 交還，或 `node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" sessions` 找到標 🖥️ 的那段再 `release <編號>`；也可以在 Discord 打 `/takeback`（先關掉電腦上的視窗） |
| 「最近的錯誤」 | 已過濾掉 SDK 對 reply 工具的提醒（`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`，reply 一律放行是刻意的設計），剩下的才是真的錯誤 |

完整 log 在 `<HOME>\bot.log`、`<HOME>\bot.err.log`（上一次執行的在 `bot.prev.log`）。log 不含 token，需要時可以讀最後幾十行來判斷問題；**不要讀 `config.json`**（裡面有 token）。
