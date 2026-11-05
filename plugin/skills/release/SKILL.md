---
name: release
description: 把在電腦上接手的 channelcollab 對話交還給 Bot（之前用 /channelcollab:takeover 接過來的那段）。Bot 會接回同一個 session，包含在電腦上講過的內容，並處理接手期間 Discord 上記下的訊息。使用者說「交還給 Bot」「我做完了，還給 Bot」「release」「接手結束」時使用。
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 交還給 Bot

`ctl` 代表 `node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs"`。

1. 先用一兩句話跟使用者確認這段在電腦上做了什麼（Bot 接回後會看到完整對話，不需要另外寫摘要）。
2. 交還。這個 skill 通常就在接手開的那個視窗裡執行，用這個對話自己的 session ID 找到要交還的對話：

   ```
   ctl release --home "<HOME>" --session "${CLAUDE_SESSION_ID}"
   ```

   不知道 HOME 時先 `ctl homes`：只有一隻就用它；有好幾隻就逐一試（session 不在那隻 Bot 會說「沒有接手中的 session」，換下一隻），或問使用者。
   不是在接手的視窗裡執行時，改用 `ctl sessions --home "<HOME>"` 找到標「🖥️ 電腦上接手中」的那段，再 `ctl release <編號|dm|討論串 ID> --home "<HOME>"`。

3. 成功後 Bot 會在討論串發「✅ 已交還給 Bot」，接著處理接手期間記下的訊息。告訴使用者：**請關掉這個視窗（/exit），不要再在這裡繼續**，避免兩邊同時寫入同一段對話。
