# channelcollab plugin

讓 Discord 上的人和 Bot 一起協作：每位成員有一個自己的 Discord Bot，背後是他自己電腦上的 Claude Code，使用他自己的設定、skills 和工作資料夾。在綁定的頻道 @Bot 交辦事情，Bot 會開討論串處理、用表情顯示狀態，要改檔或執行指令時由主人在 Discord 上按按鈕核准。

也可以**只用私訊**：不綁任何頻道，把 Bot 當成手機上的私人 Claude（只有主人能用、要設 PIN；和 Bot 要有共同的伺服器，自己建的私人伺服器也可以）。

在 Discord 打 `/` 會跳出 Bot 的斜線指令（`/help`、`/status`、`/model`、`/effort`、`/plan`、`/stop`、`/compact`、`/retry`、`/skill`、`/takeback`，私訊另有 `/clear`、`/resume`）；`!help` 等 `!` 寫法也能用。`/skill` 可以執行 Claude Code 的 skill 和自訂指令。

Bot 可以把做完的事**回報到團隊頻道**（在 Discord 上請它回報，或在電腦的 Claude Code 用 `/channelcollab:report`）；對話也可以在電腦和手機之間**換手**（`/channelcollab:takeover`、`release`、`handoff`）。

## 指令

| 指令 | 用途 |
|---|---|
| `/channelcollab:setup` | 設定精靈：先選用途（只用私訊／團隊頻道協作／兩者都要），再檢查 Node、安裝執行環境、匯入交付檔、設定 PIN、綁定頻道或開私訊、啟動 Bot、建立捷徑 |
| `/channelcollab:bind` | 新增、修改、移除頻道綁定；開關私訊（主人私訊 Bot）；設定核准用 PIN、白名單 |
| `/channelcollab:start`、`/channelcollab:stop`、`/channelcollab:status` | 啟動、停止、查看狀態（也可以雙擊 setup 建立的「啟動 <Bot 名稱>.bat」等） |
| `/channelcollab:roster` | 管理自己的名冊（Bot 認得哪些 Bot、哪些人）；加入只要 Discord ID |
| `/channelcollab:guidelines` | 協作守則 |
| `/channelcollab:report` | 把電腦上做完的事整理成摘要，經執行中的 Bot 貼到綁定的頻道（送出前先確認） |
| `/channelcollab:takeover`、`/channelcollab:release` | 在電腦上接手 Bot 在 Discord 上的對話（開新視窗 resume），做完交還 |
| `/channelcollab:handoff` | 把電腦上目前的對話交給 Bot（私訊或綁定頻道的新討論串），改在手機上繼續 |
| `/channelcollab:create-bot` | 管理員用：建立 Discord Bot、產生交付檔；也可以選「只給自己私訊用」自己建一隻 |

## 需求

- Windows、Claude Code（已登入）
- Node 22 以上（`winget install OpenJS.NodeJS.LTS`）

詳細說明見 repo 的 `docs/企劃使用說明.md` 與 `docs/管理員說明.md`。

## 資料放在哪裡

Bot 的設定（含 token）、名冊、log 和執行環境都放在 `%USERPROFILE%\.channelcollab`（或環境變數 `CHANNELCOLLAB_HOME` 指定的資料夾），不在 plugin 資料夾裡，所以更新 plugin 不會影響設定。
