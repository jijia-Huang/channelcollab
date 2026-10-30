---
name: bind
description: 新增、修改、移除或列出 channelcollab 的頻道綁定（哪個 Discord 頻道對應哪個工作資料夾、用什麼模型、權限模式、啟動器）。使用者說「綁定頻道」「把這個頻道綁到某資料夾」「改頻道的模型」「Bot 在某頻道不回應」「列出綁定」「解除綁定」時使用。
argument-hint: "[頻道ID] [工作資料夾]"
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 頻道綁定

Bot 只回應綁定過的頻道（以及這些頻道底下的討論串、論壇貼文）。綁定存在 `<HOME>\config.json` 的 `channels`，**只透過下面的總控腳本修改**。config.json 裡有 Bot token：**不要用 Read、cat、Get-Content 等任何方式打開它，也不要手動編輯。**

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" bind <選項>
```

使用者指定了別的 HOME 時，所有指令加 `--home "<資料夾>"`。

## 先看現況

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" bind --list
```

## 新增或修改

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" bind --channel <頻道ID> --cwd "<工作資料夾>" [--model <模型>] [--permission-mode <模式>] [--launcher "<啟動器>"] [--tools Read,Grep,Glob]
```

修改既有綁定時只給要改的欄位，其他欄位保留。

| 欄位 | 說明 |
|---|---|
| `--channel` | 頻道 ID（17～20 位數字）。Discord 開啟開發者模式後，對頻道按右鍵 →「複製頻道 ID」 |
| `--cwd` | 工作資料夾，新增時必填，必須已經存在 |
| `--model` | `sonnet`（建議）、`haiku`（便宜，適合簡單問答）、`opus`（最強、最貴），或完整的模型名稱。給 `none` 表示用 Claude Code 的預設 |
| `--permission-mode` | 預設 `default`，見下表。**不允許 `bypassPermissions`** |
| `--launcher` | 進階：用自訂的 `.cmd` 啟動 Claude（例如先套用某些設定）。啟動器必須最後執行 `claude` 並原封不動轉交參數，自己不能輸出任何東西到 stdout。給 `claude` 表示用內建 |
| `--tools` | 進階：限縮這個頻道可用的工具，逗號分隔。給 `all` 表示不限 |

權限模式：

| 模式 | 意思 |
|---|---|
| `default`（建議） | 讀工作資料夾裡的檔案直接放行；改檔、執行指令、讀工作資料夾以外的檔案，都會在 Discord 出現按鈕，由主人確認 |
| `acceptEdits` | 改工作資料夾裡的檔案不用問；執行指令等其他動作仍要主人確認 |
| `plan` | 只規劃、不動手：改檔和執行指令一律拒絕 |
| `dontAsk` | 改檔和執行指令一律拒絕，不跳按鈕 |
| `auto` | 交給 Claude Code 自己的自動判斷，Bot 不介入，通常不會出現權限按鈕 |

主人在 `defaults.permission_timeout_minutes`（預設 10 分鐘）內沒按，會自動拒絕。主人是 `config.json` 的 `discord.owner_id`，本指令不會動到它。

使用者沒有特別要求就用 `default`，並簡短說明主人會在 Discord 上看到確認按鈕。

## 移除

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" bind --remove --channel <頻道ID>
```

## 生效時間

設定檔會自動重新載入，不用重啟 Bot。已經在進行中的討論串，下一次啟動 session 時才會用到新的工作資料夾或模型。Bot 沒在執行時，提醒使用者用 `/channelcollab:start` 啟動。
