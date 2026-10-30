---
name: create-bot
description: 帶使用者建立團隊協作用的 Discord Bot，並檢查既有 Bot 的設定。流程是先收集資訊，再用瀏覽器自動化工具代為操作 Discord Developer Portal（登入、2FA、人機驗證、同意條款、按 Reset Token 與複製 token 都由使用者自己做）。token 從剪貼簿安全存檔，接著自動驗證設定、產生邀請網址、更新名冊。沒有瀏覽器自動化工具，或使用者不同意時，改成一步步引導。使用者說「建立 Bot」「建一個 Discord Bot」「幫某某建 Bot」「新增成員的 Bot」「Bot 設定檢查」「Bot 收不到訊息內容」「產生 Bot 邀請網址」「把 Bot 加進伺服器」「更新名冊」時使用。
---

# 建立 Discord Bot

每位成員各有一個 Discord Bot，由他自己電腦上的 Claude Code 驅動。Bot 原則上由管理員在 Developer Portal 的 **Team** 底下統一建立，再把 token 私下交給成員。這個 skill 主要給管理員用；成員拿到交付檔後改用 `/channelcollab:setup` 匯入。

輔助腳本是本 skill 資料夾裡的 `scripts/create-bot.mjs`，只需要 Node 22，不用安裝套件。執行方式（路徑一律加引號）：

```
node "${CLAUDE_SKILL_DIR}/scripts/create-bot.mjs" <子命令> [選項]
```

**HOME**：config.json、roster.json、`handoff\` 都放在 Bot 的資料夾（HOME）底下。HOME 依序取 `--home <路徑>`、環境變數 `CHANNELCOLLAB_HOME`，都沒有時是 `%USERPROFILE%\.channelcollab`。不帶參數執行腳本，說明文字最後一行會印出目前的 HOME。下文的 `<HOME>` 都是指它。

---

## 0. token 安全守則（一律遵守，沒有例外）

1. **token 絕不可以出現在對話中。** 不要叫使用者貼 token，不要把 token 放進命令列參數（腳本也會拒絕），不要用任何方式讀出 token 來看。
2. token 只經過剪貼簿：使用者在 Portal 按「Copy」，再由 `save-token` 從剪貼簿讀取。腳本的輸出最多只顯示末 4 碼，存好後也會自動清除剪貼簿。
3. **從按下 Reset Token 起，到 token 從頁面上消失為止**（見 3-F），不准呼叫任何會讀取頁面內容的工具，包括截圖、讀取頁面結構或文字、搜尋頁面元素、執行頁面 JavaScript、讀取 console 或網路請求，**也包括會自動回傳截圖的點擊、捲動等動作**。如果正在錄製畫面，按 Reset Token 之前就要停止錄製。
4. 整個流程都**不要讀取網路請求紀錄**，因為 Reset Token 的回應裡有 token。
5. 如果使用者不小心把 token 貼進對話，不要複述內容。請立即告訴他：這個 token 已經外洩，要回 Bot 頁籤再 Reset Token 一次，並改用剪貼簿流程。
6. 幫成員建 Bot 時，token 存成交付檔，由管理員**私下**交給本人（私訊或當面）。**不要貼在任何公開頻道或群組。**

---

## 1. 收集必要資訊

先問清楚再動手。選擇題用 AskUserQuestion（一次最多 4 題），需要自由輸入的項目直接在對話中一次列出來請使用者回答。

| 項目 | 問法／說明 |
|---|---|
| 幫誰建 | 選擇題：「幫自己建」／「管理員幫某位成員建」。**幫自己建第二個 Bot（例如測試用）時，如果 `config.json` 已經有 `discord.token`，一律當成「幫成員建」走交付檔模式**，因為 `save-token --for self` 會直接覆蓋既有 token（只印一行「取代了舊的 token」）。先用 `verify` 看一下 config.json 目前是哪個 Bot |
| 成員名稱 | 幫自己建時就是使用者本人的名字。這個名稱會寫進名冊的 `ownerName` |
| 角色 | 選擇題：「工程師」／「企劃」 |
| 成員的 Discord 使用者 ID | 17 到 20 位數字。不知道的話，教他依下方「取得 Discord ID」操作 |
| Bot 顯示名稱 | 例如「小明Bot」。建議用「名字＋Bot」，方便大家辨認 |
| 要加入的伺服器 ID | 17 到 20 位數字，取得方式同下方。**常見錯誤是貼成頻道 ID**，兩者長得一樣，請提醒使用者是對「左側伺服器圖示」按右鍵複製 |
| Developer Team | 選擇題：「建在現有的 Team 底下」／「沒有 Team，建在個人帳號底下」。選 Team 時要同時問 **Team 名稱和 Team ID**（`verify --team-id` 比對的是 ID）：到 `https://discord.com/developers/teams` 點進該 Team，網址 `/teams/<TEAM_ID>/…` 中的數字就是 ID。選個人帳號時要提醒使用者：之後可以到 General Information 頁面底部用「Transfer App to Team」轉移，轉移時需要 2FA |
| 頭像 | 選擇題：「略過」／「提供圖片」。選提供圖片時，請使用者給本機圖片的完整路徑（PNG 或 JPG，建議正方形、至少 512×512） |

**取得 Discord ID**（在 Discord 用戶端操作）
1. 打開開發者模式：使用者設定（齒輪）→ 進階 → 開啟「開發者模式」。
2. 使用者 ID：在成員列表或聊天中，對成員的頭像按右鍵 →「複製使用者 ID」。
3. 伺服器 ID：對左側伺服器圖示按右鍵 →「複製伺服器 ID」。（對頻道名稱按右鍵複製到的是**頻道 ID**，不能拿來當伺服器 ID。）

> ID 不是機密，可以直接貼在對話中。**token 才是機密。**

收齊之後，把整理好的資訊複述一次讓使用者確認。

**如果使用者只要「Bot 設定檢查」**，就不必收集這些資訊，直接跳到第 5 節。檢查前先問伺服器 ID，可以略過。

---

## 2. 選擇模式

1. 檢查目前環境是否有**瀏覽器自動化工具**（可以開分頁、點擊、填表、上傳檔案的工具）。
2. 有的話，先**簡短告知**下面這段話，並詢問是否繼續：
   > 接下來我可以用瀏覽器自動化工具，在你登入的 Discord Developer Portal 裡代為操作。請注意，Discord 的服務條款對「自動化操作使用者帳號」有限制。我只會操作建立 Bot 的設定頁，而且登入、2FA、人機驗證、同意條款、按 Reset Token 與複製 token 都由你自己完成。要用這個方式，還是改成我一步步告訴你、由你自己點？
3. 使用者同意 → 第 3 節（瀏覽器協助模式，**主要流程**）。
   使用者不同意，或者沒有瀏覽器自動化工具 → 第 4 節（純引導模式）。
4. 中途使用者隨時說「我自己來」，或瀏覽器工具連續失敗 2 到 3 次，就改走純引導模式，從同一步接著做。

---

## 3. 瀏覽器協助模式（主要流程）

每完成一步，用一句話向使用者回報（例如「✅ Application 已建立，ID 1234…」）。遇到登入、2FA、人機驗證（CAPTCHA）、同意條款的勾選框時，**停下來請使用者自己操作**，等他回覆「好了」再繼續。

Portal 的介面可能會改版。找不到按鈕時，先截圖看清楚現況，不要亂點。

**Portal 會跟著使用者的 Discord 語言顯示**，繁體中文介面的對照如下（下文以英文為主，括號內為中文介面的名稱）：

| 英文介面 | 繁體中文介面 |
|---|---|
| Applications／New Application | 應用程式／新建應用程式 |
| Name／Create | 名稱／建立 |
| General Information | 一般資訊 |
| Installation／Install Link | 安裝／安裝連結 |
| Install Link 選項：None／Discord Provided Link／Custom URL | 無／Discord 提供的連結／自訂 URL |
| Bot | 機器人 |
| Token／Reset Token | 權杖／重設權杖 |
| Authorization Flow／Public Bot | 授權流程／公開機器人 |
| Privileged Gateway Intents／Message Content Intent | 不翻譯，維持英文 |
| Save Changes／Reset（儲存列） | 儲存變更／重設 |

有未儲存的變更時，畫面底部會出現提醒「有變更尚未儲存」的儲存列（中文介面：「小心，您有變更尚未儲存！」），按其中的 Save Changes（儲存變更）。儲存成功後頁面上方會出現綠色提示（例如「機器人更新成功！」「所有的編輯內容都被記錄下來了」）。

點擊或捲動工具在對話框剛打開時可能沒有作用（例如名稱欄位沒填進去）。輸入文字前先用元素參照點欄位，打完再截圖確認。

用元素參照操作 Portal 時的已知狀況：
- 「安裝連結」下拉選單用元素參照點擊**不會展開**，要先截圖、再用座標點選單本體，選項出現後再用座標點「無」。
- 搜尋頁面元素回傳的開關名稱**不代表開關狀態**（例如 Message Content Intent 關著時也可能標成「on」）。開關目前是開或關，一律以截圖為準。
- 剛導向新頁面時元素可能還沒載入（搜尋不到開關），先等 1～2 秒再找。

### 3-A 登入
1. 開新分頁前往 `https://discord.com/developers/applications`。
2. 請使用者自己登入。如果要求 2FA 或人機驗證，也由使用者完成。
3. 使用者說已登入後，確認頁面上看得到「Applications」（應用程式）列表和右上方的「New Application」（新建應用程式）按鈕，再繼續。使用者如果已經登入，這一步會直接看到列表。
4. 如果要建在 Team 底下，可以先到 `https://discord.com/developers/teams` 確認使用者確實是該 Team 的成員。

### 3-B 建立 Application
1. 在 Applications 頁按「**New Application**」。
2. 在對話框中：
   - Name 填入 Bot 顯示名稱。
   - **Team** 下拉選單：**只有帳號屬於某個 Team 時才會出現**。要建在 Team 底下就選指定的 Team；建在個人帳號底下就維持 Personal。如果要建在 Team 底下卻看不到這個下拉選單，表示使用者不是任何 Team 的成員，先停下來處理（見第 9 節）。
   - 「同意 Developer Terms of Service 與 Developer Policy」的勾選框，**請使用者自己勾**。
3. 請使用者勾好後自己按「Create」（建立）。如果跳出人機驗證，由使用者完成。
4. 建好後網址會是 `https://discord.com/developers/applications/<APP_ID>/information`。記下 `APP_ID`，後面的網址都會用到。

### 3-C 頭像（選用）
1. 前往 `https://discord.com/developers/applications/<APP_ID>/bot`。
2. 用瀏覽器自動化工具的檔案上傳功能，把使用者指定的圖片傳到 Bot 的 **Icon** 欄位。如果上傳不成功，就請使用者自己點 Icon 選檔。
3. 如果需要，也可以在 `…/information` 的 **App Icon** 傳同一張圖。
4. 畫面下方出現「Save Changes」就按下。

### 3-D 關掉預設邀請連結（關 Public Bot 之前一定要先做）
1. 前往 `https://discord.com/developers/applications/<APP_ID>/installation`。
2. 「**Install Link**」區塊的下拉選單預設是「Discord Provided Link」，改成「**None**」（無）→ 按儲存列的 Save Changes。上方的 Installation Contexts（User Install／Guild Install）不用動。
   > 如果跳過這一步，關閉 Public Bot 時會出現「Private application cannot have a default authorization link」錯誤。

### 3-E Bot 頁籤設定
1. 前往 `https://discord.com/developers/applications/<APP_ID>/bot`。
2. Authorization Flow 區塊（在 Token 區塊下方，要往下捲）：關閉「**Public Bot**」（新建的 Application 預設是開的）。
3. Privileged Gateway Intents 區塊：打開「**Message Content Intent**」（Presence、Server Members 兩個 intent 不用開）。
4. 兩個開關可以一起改，再按儲存列的「**Save Changes**」一次存。儲存後頁面會捲回頂端並顯示成功提示；往下捲截圖確認兩個開關的狀態都正確，且儲存列已消失。

### 3-F Reset Token（注意第 0 節的守則）
1. 如果正在錄製畫面，先停止錄製。
2. 先把 Bot 頁籤捲到看得到「**Reset Token**」按鈕的位置（在 Token 區塊，Username 欄位下方），然後告訴使用者接下來要做什麼：
   > 接下來請你自己操作，這段時間我不會看畫面：在 Bot 頁按「Reset Token」→ 在確認對話框按確認，如果要求 2FA 也請完成 → 新 token 出現後按旁邊的「Copy」。複製好之後，請回覆「複製好了」，**不要把 token 貼到對話裡**。
3. **Reset Token 預設由使用者自己按。** 多數瀏覽器自動化工具的點擊、捲動等動作都會自動回傳截圖，從按下 Reset Token 起，任何一個這類動作都會把 token 帶回對話。**從這一刻開始，不要截圖、不要捲動或點擊頁面、也不要讀取頁面。** 只有確定點擊工具不會回傳畫面時，才可以代按。
4. 等使用者回覆「複製好了」，接著跑第 5 節的 `save-token`。
5. `save-token` 成功後，用瀏覽器工具把該分頁**導向其他頁面**，例如 `https://discord.com/developers/applications/<APP_ID>/information`。Portal 只會顯示 token 一次，換頁之後 token 就從頁面上消失了。**完成這一步才可以恢復截圖和讀取頁面。**
6. 如果 `save-token` 失敗（剪貼簿是空的、複製到別的東西），請使用者**回到原本的頁面再按一次 Copy**（token 還在畫面上的話）。如果已經離開頁面，就由使用者自己再按一次 Reset Token，然後回到步驟 4。

### 3-G 驗證 → 邀請 → 再驗證 → 名冊
> 幫成員建（或幫自己建第二個 Bot）時，token 不在 config.json，所以 `verify` 要加 `--handoff "<交付檔路徑>"`。不加的話，腳本會讀到 config.json 裡原本的 Bot。`invite` 和 `roster` 則直接用 `save-token --json` 回傳的 `RESULT` 帶 `--app-id`／`--bot-id`／`--bot-name`，不需要再讀 token。
>
> 交付檔模式**不會寫入 config.json**（只寫 `handoff\<名稱>-bot.json`）。存檔前後可以比對 config.json 的 `discord.token` 末 4 碼確認；但修改時間不一定能當證據，同一台電腦上的其他程式可能同時在改 config.json 的其他欄位。

1. 跑第 5 節的 `verify`。有 ❌ 的項目就用瀏覽器修正，再重跑一次。
2. 用 `invite` 產生邀請網址（第 6 節），然後用瀏覽器開啟。授權頁面要載入幾秒，等對話框出現再截圖。
3. 截圖確認「Add to Server」（新增至伺服器）欄位已經預先選好伺服器名稱。如果欄位是空白且無法點選、下方按鈕變成提示漏填欄位的灰色按鈕（中文介面：「您漏填了某些欄位」），表示伺服器 ID 錯了（最常見是貼成頻道 ID），或登入的帳號在該伺服器沒有「管理伺服器」權限；先向使用者確認，修正後重新產生網址。
4. 接下來「Continue」（繼續）→ 確認權限 →「Authorize」（授權）→ 人機驗證，**都請使用者自己確認並操作**。
5. 使用者說授權好了，再跑一次 `verify --guild-id`，確認伺服器那一項是 ✅。
6. 寫名冊（第 7 節），關閉自己開的分頁，然後收尾（第 8 節）。

---

## 4. 純引導模式（備案）

步驟和第 3 節相同，只是每一步都由使用者自己操作。每一步請給：

- **要開的網址**（完整網址，`<APP_ID>` 確定之後就代入實際值）。
- **要點的地方**：按鈕或開關的名稱要和畫面上一致，例如「New Application」「Reset Token」「Public Bot」「Message Content Intent」「Save Changes」。使用者的 Discord 是中文介面時，請一併給第 3 節對照表中的中文名稱。
- **完成時應該看到什麼**。

一次只給一步，等使用者回覆「好了」再給下一步。建立 Application 之後，請使用者從網址列複製 `APP_ID` 給你。順序一樣是 3-B → 3-C（選用）→ **3-D（先改 Install Link）** → 3-E → 3-F。Reset Token 那一步仍然遵守「按 Copy、回覆複製好了、不要貼 token」。

---

## 5. 存 token 與驗證（腳本）

### 幫自己建

```
node "${CLAUDE_SKILL_DIR}/scripts/create-bot.mjs" save-token --for self --json
```

- 從剪貼簿讀取 token，向 Discord 驗證（`GET /users/@me`、`GET /applications/@me`）後，合併寫入 `<HOME>\config.json` 的 `discord.token`。檔案中的其他欄位都會保留。檔案原本不是合法 JSON 時，腳本會停下來，不會覆蓋。
- 最後一行的 `RESULT {...}` 有 `botId`、`botName`、`applicationId`（不含 token），可以拿來接下一步。

### 管理員幫成員建

```
node "${CLAUDE_SKILL_DIR}/scripts/create-bot.mjs" save-token --for member --member "成員名稱" --owner-id <成員的 Discord 使用者 ID> --json
```

- 存成交付檔 `<HOME>\handoff\<成員名稱>-bot.json`，**不會寫進管理員自己的 config.json**。`--owner-id` 會寫進交付檔，成員匯入時自動設成 Bot 的主人（`discord.owner_id`，權限按鈕只有主人能按）。
- 接著寫名冊時帶 `--handoff "<交付檔路徑>"`（第 7 節），目前的整份名冊會附進交付檔，成員匯入時一起裝好。
- 請明確告訴管理員：
  > 交付檔裡是**明文 token**。請私下（Discord 私訊或當面）把這個檔案交給本人，**不要貼在公開頻道或群組**。對方匯入後，兩邊都要刪掉這個檔案（用私訊傳的話，也刪掉那則訊息）。
- 成員收到後，在自己的 Claude Code 執行 `/channelcollab:setup`，精靈會匯入交付檔（token、主人 ID、名冊），並提醒刪除檔案。

### 驗證設定

```
node "${CLAUDE_SKILL_DIR}/scripts/create-bot.mjs" verify --guild-id <伺服器ID> [--team-id <TeamID>] [--json]
```

- 預設讀取 `config.json`。幫成員建時加 `--handoff "<交付檔路徑>"`，也可以用 `--from-clipboard`。
- 檢查項目（每一項都會輸出 ✅、❌ 或 ⚠️，❌ 會附上修正方法）：
  | 檢查 | 依據 |
  |---|---|
  | token 是否有效、Bot 名稱與 ID | `GET /users/@me` |
  | Message Content Intent | `GET /applications/@me` 的 `flags` 含 `GATEWAY_MESSAGE_CONTENT_LIMITED`（1<<19）或 `GATEWAY_MESSAGE_CONTENT`（1<<18） |
  | Public Bot 已關閉 | `bot_public === false` |
  | 建在哪個 Team | `team`（有指定 `--team-id` 時會比對；建在個人帳號底下會出現 ⚠️ 提醒） |
  | 是否已在指定伺服器 | `GET /users/@me/guilds`（沒找到時會附上邀請網址） |
- 結束代碼：0 表示全部通過，1 表示有需要修正的項目，2 表示無法執行（token 無效、找不到檔案等）。
- 常見錯誤：
  - 401：token 無效或之後又被 Reset 過，請重新 Reset Token。
  - 連不到 API：檢查網路，或公司網路是否擋了 discord.com。

---

## 6. 邀請網址

```
node "${CLAUDE_SKILL_DIR}/scripts/create-bot.mjs" invite --guild-id <伺服器ID> --lock-guild
```

- 腳本會從 token 取得 application ID。幫成員建時要加 `--handoff "<交付檔路徑>"`，否則會讀到管理員自己 config.json 裡的 Bot。最簡單的做法是直接用 `save-token --json` 回傳的 `applicationId`，改成 `--app-id <ID>`，這樣不需要 token。
- scopes：`bot applications.commands`。
- 權限整數 **326417632320** 由腳本計算，各 bit 依據 Discord 官方的 Bitwise Permission Flags 表：
  | 權限 | bit |
  |---|---|
  | Add Reactions | 1<<6 |
  | View Channels | 1<<10 |
  | Send Messages | 1<<11 |
  | Embed Links | 1<<14 |
  | Attach Files | 1<<15 |
  | Read Message History | 1<<16 |
  | Manage Threads（改論壇標籤需要） | 1<<34 |
  | Create Public Threads | 1<<35 |
  | Send Messages in Threads | 1<<38 |
- 帶 `--guild-id` 時會預先選好伺服器，加上 `--lock-guild` 之後就不能改選其他伺服器。
- 把 Bot 加進伺服器的人，需要在該伺服器有「管理伺服器」權限。Public Bot 關閉後，只有 Application 的擁有者或 Team 成員能用這個網址。如果授權頁面說沒有權限，請改由有權限的管理員開啟網址。

---

## 7. 名冊

名冊用來在提示詞中標示發話者，也讓 Bot 知道怎麼找其他 Bot。每個人的名冊放在自己的 `<HOME>\roster.json`，**不放在 plugin 裡**（plugin 的 repo 是公開的，名冊有真實的 Discord ID）。plugin 只附一份假資料的 `roster.example.json` 當格式範例。

管理員的 `<HOME>\roster.json` 就是正本：

```
node "${CLAUDE_SKILL_DIR}/scripts/create-bot.mjs" roster --owner-name "成員名稱" --owner-id <成員Discord ID> --role engineer|planner [--handoff "<交付檔>"]
```

- 帶 `--handoff` 時，Bot 身分從交付檔的 token 取得，寫完名冊後會把**整份名冊**和主人 ID 附進那個交付檔。新成員匯入交付檔時，名冊就一起裝好了。
- 名冊有異動（新增成員、改名）時，其他成員要更新：管理員把自己的 `<HOME>\roster.json` 傳給大家（名冊沒有 token，可以放在團隊頻道），成員用 `/channelcollab:update-roster` 匯入。

- Bot ID 和名稱會從 token 自動取得。也可以用 `--bot-id <ID> --bot-name <名稱> --app-id <Application ID>` 直接指定，這樣不需要 token。**用這個方式時記得帶 `--app-id`**，否則名冊那一筆不會有 `applicationId`。
- 同一位主人有兩個 Bot（例如自己的正式 Bot 加一個測試 Bot）時，腳本會印出「已經有另一個 Bot」的 ⚠️，這是提醒，不是錯誤。測試用的 Bot 建議把 `--owner-name` 寫成看得出是測試的名稱（例如「測試企劃」）。
- `--role` 可以填 `engineer`／`工程師` 或 `planner`／`企劃`。
- 預設寫入 `<HOME>\roster.json`（`--roster <路徑>` 可以改）。檔案不存在就建立，已有同一個 `botId` 就更新那一筆。同一位主人已經有別的 Bot 時，會顯示警告。
- 成員自己建 Bot 時，用 `--print` 輸出一筆資料，請使用者交給管理員合併進正本。
- **不要把名冊寫進 plugin 資料夾或 repo**：安裝目錄在 plugin 更新時會被覆蓋，repo 又是公開的。

**格式**

```json
{
  "version": 1,
  "bots": [
    {
      "botId": "Bot 的使用者 ID",
      "botName": "Bot 顯示名稱",
      "ownerName": "主人名稱",
      "ownerDiscordId": "主人的 Discord 使用者 ID",
      "role": "engineer | planner",
      "applicationId": "Application ID",
      "updatedAt": "ISO 8601 時間"
    }
  ]
}
```

---

## 8. 收尾回報

用簡短的清單告訴使用者：

- Bot 名稱、Bot ID、Application ID，以及建在哪個 Team 或個人帳號底下。
- token 存在哪裡：自己的 config.json，或是交付檔路徑加上「請私下交付」的提醒。
- `verify` 的最終結果，並列出仍是 ❌ 的項目。
- 是否已經加入伺服器。名冊是新增、更新，還是只輸出了一筆要交給管理員的資料。
- 建在個人帳號底下時，再提醒一次之後可以轉移到 Team。

---

## 9. 疑難排解

| 狀況 | 處理 |
|---|---|
| 關 Public Bot 時出現「Private application cannot have a default authorization link」 | 先到 `…/installation` 把 Install Link 改成 None 並儲存 |
| Bot 收得到 @ 但看不到訊息內容 | Message Content Intent 沒開或沒按儲存，請跑 `verify` 確認 |
| `save-token` 說剪貼簿是空的或不像 token | 請使用者在 Bot 頁籤再按一次 Copy。如果複製到的是 OAuth2 頁面的 Client Secret，腳本會提示 |
| `save-token` 回應 401 | 複製到舊的 token，或之後又按了 Reset。請重新 Reset Token 並複製 |
| 授權頁面的伺服器欄位空白、無法選擇 | 伺服器 ID 錯了（常把頻道 ID 當成伺服器 ID），或開啟網址的人在該伺服器沒有「管理伺服器」權限。先確認 ID，仍不行就改由伺服器管理員開啟 |
| New Application 對話框沒有 Team 下拉選單，或選單裡沒有想要的 Team | 使用者不屬於任何 Team／不是該 Team 的成員，或權限不足。請 Team 擁有者到 `https://discord.com/developers/teams` 邀請他 |
| 公司網路連不到 Discord API | 腳本無法驗證。請改在可以連上 Discord 的網路中執行 |
