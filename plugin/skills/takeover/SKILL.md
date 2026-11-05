---
name: takeover
description: 在電腦上接手自己的 channelcollab Bot 正在 Discord（討論串或私訊）進行的對話：Bot 先放開那段對話，再開一個新的終端機視窗，用同一個 session 接著做；做完用 /channelcollab:release 交還。使用者說「我在電腦上接手」「把 Bot 那段對話接過來」「在終端機繼續 Bot 的對話」「takeover」時使用。
argument-hint: "[討論串名稱或編號]"
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 在電腦上接手 Bot 的對話

channelcollab 的每段對話就是一個 Claude Code session。接手 = Bot 結束它在背景的程序並標記「主人在電腦上接手中」，然後在新視窗用 `--resume <session ID>`（在那段對話自己的工作資料夾、用綁定的啟動器）接著做。session ID 不會變，所以交還後 Bot 會接著電腦上講過的內容。

`ctl` 代表 `node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs"`。

## 1. 選 Bot

`ctl homes`。有好幾隻時用 AskUserQuestion 列出 Bot 名稱請使用者選；沒在執行的要先 `/channelcollab:start`。

## 2. 選對話

```
ctl sessions --home "<HOME>"
```

列出這隻 Bot 最近的對話（編號、時間、討論串或私訊、摘要、session ID、工作資料夾）。把清單整理給使用者，問要接手哪一段（可以用 AskUserQuestion 列最近幾段，或請他說編號）。標「⚙️ 正在工作」的要等 Claude 做完，或先在 Discord 按 🛑。

## 3. 接手

```
ctl takeover <編號|dm|討論串 ID> --home "<HOME>"
```

腳本會：請 Bot 放開這段對話（Bot 的程序結束後才回應）、在討論串發「🖥️ 主人在電腦上接手了這段對話」、開一個**新的終端機視窗**（有 Windows Terminal 就用它，否則用命令提示字元）在正確的資料夾 resume。

告訴使用者：

- 到新視窗繼續；**這個對話不要再碰那段內容**。
- 接手期間 Discord 上有人 @ Bot，Bot 會回「主人在電腦上接手中，結束後會接回」，並把訊息記下來。
- 做完後在新視窗打 `/channelcollab:release` 交還（或 `/exit` 後執行 `ctl release --home "<HOME>"`）。
- 忘了交還時，主人可以在 Discord 的那個討論串打 `/takeback` 強制接回，但要先關掉電腦上的視窗，不然兩邊會同時寫入同一段對話（實測：兩邊都會成功，但之後只看得到其中一邊）。

視窗沒開成功時，把腳本印的「要自己接的話，在 … 執行：…」指令給使用者。
