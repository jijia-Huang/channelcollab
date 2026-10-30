---
name: update-roster
description: 匯入管理員傳來的新名冊（roster.json），讓自己的 Bot 認得團隊裡其他的 Bot 和主人。使用者說「更新名冊」「匯入名冊」「管理員給了新的 roster」「Bot 不認得某個 Bot」時使用。
argument-hint: "[名冊檔案路徑]"
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 更新名冊

名冊記錄團隊裡每個 Bot 的 ID、名稱、主人和角色。Bot 用它在對話中標示發話者、知道怎麼找其他 Bot。名冊由管理員維護，有異動時會把新的 `roster.json` 傳給大家。名冊**沒有** token，可以打開來看。

1. 有帶參數就當成檔案路徑；沒有就問使用者檔案在哪裡（常見是「下載」資料夾）。
2. 匯入（會先檢查格式，有問題就不寫入）：
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs" import-roster "<檔案路徑>"
   ```
   使用者指定了別的 HOME 時加 `--home "<資料夾>"`。
3. 把腳本列出的 Bot 清單轉述給使用者。新的名冊從下一個新對話開始生效，不用重啟 Bot。

名冊存在 `<HOME>\roster.json`，會覆蓋舊的那份。
