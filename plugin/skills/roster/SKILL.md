---
name: roster
description: 管理自己的 channelcollab 名冊（roster.json）：決定自己的 Bot 認得哪些 Bot、哪些人。加入時只要 Discord ID，名字和是不是 Bot 會自動向 Discord 查。也可以合併別人給的 roster.json。使用者說「把某某加進名冊」「我的 Bot 要認得某個 Bot」「Bot 不認得某個人」「列出名冊」「從名冊移除某人」「更新名冊」「匯入名冊」時使用。
argument-hint: "[add <Discord ID> | remove <Discord ID> | list | import <檔案>]"
allowed-tools: Bash(node:*), PowerShell(node:*)
---

# 管理我的名冊

名冊是**每個人自己的**：存在自己的 `<HOME>\roster.json`，決定自己的 Bot 認得哪些 Bot、哪些人。Bot 用它在對話中標示發話者，並知道要找某個 Bot 或某個人時該 @ 誰。名冊**沒有** token，可以打開來看。改完從下一個新對話開始生效，不用重啟 Bot。

總控腳本：`node "${CLAUDE_PLUGIN_ROOT}/scripts/channelcollab.mjs"`（下面寫成 `<總控>`）。使用者指定了別的 HOME 時，每個指令都加 `--home "<資料夾>"`。

名冊有兩種條目：

| 種類 | 內容 | 用途 |
|---|---|---|
| Bot | Bot 的 ID、名稱，可選填主人（名稱、ID）與角色 | Bot 知道怎麼 @ 其他 Bot 交棒 |
| 成員（members） | 人的 ID、名字，可選填角色 | Bot 知道怎麼 @ 主人以外的人（例如企劃） |

角色可以填 `engineer`／`工程師` 或 `planner`／`企劃`，也可以不填。

## 列出

```
<總控> roster list
```

把 Bot 和成員清單轉述給使用者。

## 加入（只要 Discord ID）

1. 問使用者要加的人或 Bot 的 **Discord ID**（17–20 位數字）。不知道怎麼拿時這樣說明：Discord「使用者設定 → 進階」打開「開發者模式」，然後在對方的名字上按右鍵 →「複製使用者 ID」。
2. 有提到角色就帶 `--role`；加的是 Bot 而且知道主人，可以帶 `--owner-id <主人的 ID>`（主人名稱會自動查）。
   ```
   <總控> roster add <Discord ID> [--role planner] [--owner-id <主人 ID>]
   ```
   - 腳本會用自己 Bot 的 token 向 Discord 查：名字依序取伺服器暱稱、顯示名稱、username；同時判斷對方是不是 Bot。token 不會出現在輸出裡。
   - 同一個 ID 已經在名冊裡就更新那一筆（沒給的欄位保留）。
3. 查不到時（還沒設定 token、連不到 Discord、ID 不存在），腳本會要求 `--name`：問使用者對方叫什麼，再加上 `--name "<名字>"` 重試；是 Bot 的話再加 `--bot`。使用者想自己指定名字或種類時，也可以直接帶 `--name`、`--bot`／`--member`。
4. 把結果（名字、是 Bot 還是成員、名字的來源）告訴使用者。輸出提醒「不在 Bot 所在的伺服器裡」時，一併轉告。

## 移除

```
<總控> roster remove <Discord ID>
```

使用者只說名字時，先 `roster list` 找出 ID，跟使用者確認是哪一筆再移除。

## 合併別人給的名冊（選用）

別人傳來他的 `roster.json` 時，可以一次加進很多條目。這是選用的做法，平常用上面的 `add` 就好。

1. 問檔案在哪裡（常見是「下載」資料夾）。
2. 合併（會先檢查格式，有問題就不寫入）：
   ```
   <總控> roster import "<檔案路徑>"
   ```
   - 新的 ID 會加進來；**同一個 ID 預設保留自己的**，輸出裡標「保留你的」。
   - 同一個 ID 一邊是 Bot、一邊是成員時，一律保留自己的。
3. 有「保留你的」而內容不同的條目時，列給使用者看，問要不要改用對方的。要的話加 `--theirs` 再執行一次（只會取代那些衝突的條目，對方沒有的欄位保留自己的）。
