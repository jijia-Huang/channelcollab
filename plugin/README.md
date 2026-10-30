# channelcollab plugin

讓 Discord 上的人和 Bot 一起協作：每位成員有一個自己的 Discord Bot，背後是他自己電腦上的 Claude Code，使用他自己的設定、skills 和工作資料夾。在綁定的頻道 @Bot 交辦事情，Bot 會開討論串處理、用表情顯示狀態，要改檔或執行指令時由主人在 Discord 上按按鈕核准。

## 指令

| 指令 | 用途 |
|---|---|
| `/channelcollab:setup` | 設定精靈：檢查 Node、安裝執行環境、匯入管理員給的交付檔、綁定頻道、啟動 Bot |
| `/channelcollab:bind` | 新增、修改、移除頻道綁定 |
| `/channelcollab:start`、`/channelcollab:stop`、`/channelcollab:status` | 啟動、停止、查看狀態（也可以雙擊 setup 在桌面建立的 .bat） |
| `/channelcollab:update-roster` | 匯入管理員給的新名冊 |
| `/channelcollab:guidelines` | 協作守則 |
| `/channelcollab:create-bot` | 管理員用：建立 Discord Bot、產生交付檔、維護名冊 |

## 需求

- Windows、Claude Code（已登入）
- Node 22 以上（`winget install OpenJS.NodeJS.LTS`）

詳細說明見 repo 的 `docs/企劃使用說明.md` 與 `docs/管理員說明.md`。

## 資料放在哪裡

Bot 的設定（含 token）、名冊、log 和執行環境都放在 `%USERPROFILE%\.channelcollab`（或環境變數 `CHANNELCOLLAB_HOME` 指定的資料夾），不在 plugin 資料夾裡，所以更新 plugin 不會影響設定。
