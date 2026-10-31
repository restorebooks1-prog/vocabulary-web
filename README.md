# 我的單字庫

目前不附預設詞表，初次開啟顯示「尚無詞表」。登入指定 Google 帳號後，可從頁尾匯入詞表 JSON。

原生 HTML / CSS / JavaScript，無建置步驟；可發布到 GitHub Pages。data/ 是內建公開詞表，Firebase 的 publicDatasets 儲存僅限指定帳號讀取的詞表；個人進度另外保存在瀏覽器與 Firebase。指定 Google 帳號可直接在網站匯入 JSON 更新詞表，所有訪客都能匯出目前詞表，不需要 GitHub Actions 或自動 build。

## 匯入與匯出

表格下方的頁尾提供「匯出目前詞表 JSON」及「匯入詞表 JSON」。匯出不需要登入，包含目前詞表的全部單字及欄位定義，不受搜尋或篩選影響，也不包含個人勾選與篩選狀態。匯出的檔案可再次匯入。

匯入只限 config.js 設定的 ownerUid 所對應的 Google 帳號；Firestore 規則同時檢查 UID 與 Google 登入，其他帳號即使繞過按鈕也無法寫入。每個檔案是一份 schemaVersion 2 詞表，可一次選取多份，不需另外準備 catalog.json。分類及子項目由 collectionName、itemName 自動建立。所有檔案驗證通過後先顯示新增／更新預覽，再由「確認匯入」整批儲存；任一寫入被拒絕時整批不會發布。

相同詞表 ID 會整份取代內容，保留其他詞表；詞表／單字 ID 不變時沿用原本的勾選紀錄。未包含在新版詞表的舊單字不再顯示，私人進度仍保留。匯入的雲端詞表僅限指定帳號登入後讀取。單份詞表壓縮後的 JSON 上限為 900,000 UTF-8 bytes，每次最多 100 份、檔案總大小上限 8 MiB。

指定帳號登入後讀取雲端詞表，相同 ID 優先使用雲端版本；內建的 data/ 不會被修改。雲端讀取失敗時會顯示警告並使用內建詞表，匯入暫停，排除問題後重新整理即可。其他已開啟的裝置也需重新整理才能讀取新版詞表。

卡片模式中匯入或切換詞表會回到列表，避免舊卡片與目前詞表的管理操作指向不同資料。登入、恢復連線或按「同步進度」時，會補同步該帳號留在本機的所有待上傳詞表進度，包括尚未開啟的詞表；失敗的進度保留並顯示待上傳數量，可再次重試。

**啟用前需將本次 firestore.rules 全文發布到 Firebase Console → Firestore Database → Rules。** 舊規則沒有 publicDatasets 權限，未更新前無法匯入或讀取雲端詞表。網站程式與規則只需部署這次變更，之後更新詞表直接匯入即可。

## 本機開啟

頁尾「刪除目前雲端詞表」只限指定 Google 帳號，且須先成功載入雲端詞表。確認後以同一批次刪除詞表與其雲端進度，清除此瀏覽器的進度與篩選設定，再重新載入網站；失敗可重試。同一網站來源的其他分頁若已載入這份詞表，也會重新載入，避免舊進度再次上傳；其他詞表的進度保留。同 ID 若有內建詞表，會回到內建版本，進度重新開始；純內建詞表需透過 Git 移除。其他瀏覽器或裝置既有的本機進度不會遠端清除。此功能需發布最新版 firestore.rules 的詞表及進度刪除權限。

在本資料夾執行 `node scripts/serve.mjs`，瀏覽 http://127.0.0.1:8765 。不要直接雙擊 index.html，瀏覽器會限制讀取 JSON 模組。本機 Firebase 登入若使用此網址，Authorized domains 也需加入 127.0.0.1，或改用 localhost 開啟。

`npm test` 測試進度合併、篩選、格式和時間邊界；`npm run validate` 核對目錄與資料。

## 新增資料與 skill

skills/japanese-subtitle-vocab-json 是可安裝的完整 skill。將整個 japanese-subtitle-vocab-json 資料夾放到你的 Codex skills 目錄後，使用 `$japanese-subtitle-vocab-json` 並提供字幕或既有詞表及本專案路徑。它產出 data/<固定id>.json 並更新 data/catalog.json。

目前三份檔案僅為示範，不是海賊王或任何作品的真實字幕整理。刪除示範檔和目錄項目後再加入正式詞表。

collectionName / itemName 是通用分類／子項目；可寫作品／集數，也可寫課程／章節。詞彙內 category 與上層作品分類獨立。每份詞表 JSON（schemaVersion 2）透過 columns 定義欄位名稱、順序與類型；日文 skill 固定輸出八欄，其他語言可用不同文字欄位。已看過／標記兩欄的值來自私人進度，避免 push 公開。

## Firebase 設定（一次）

1. Firebase Console 建立 Spark 免費專案，新增 Web 應用程式，取得 firebaseConfig。不要提供管理員私鑰。
2. Authentication → Sign-in method 啟用 Google；Authorized domains 加入你的 `<帳號>.github.io` 與本機測試用 localhost。
3. Firestore Database 建立資料庫，選 production／鎖定模式。先保留預設拒絕規則。
4. config.js 填 firebase 網頁設定，ownerUid 暫時空白。開本機網站登入 Google；畫面會顯示你的 UID，同樣也能在 Authentication → Users 查看。
5. 把 UID 填到 config.js 的 ownerUid，並同步替換 firestore.rules 中的擁有者 UID（isOwner 函式和 publicDatasets 寫入條件）。把 rules 全文貼到 Firestore → Rules 並發布。
6. 重新整理登入，確認「已與雲端同步」。在一台勾選後等待已保存，另一台開啟同詞表確認；已開啟頁面可按「同步進度」。請同時測試非本人帳號得到拒絕。

官方參考：[Web SDK](https://firebase.google.com/docs/web/setup)、[Google 登入](https://firebase.google.com/docs/auth/web/google-signin)、[權限規則](https://firebase.google.com/docs/firestore/security/rules-conditions)。

網站開啟／切換詞表時讀雲端，操作後延遲 700ms 合併保存，不訂閱即時更新。不同單字與不同欄位分開合併，同一欄以裝置修改時間較新者優先；請開啟裝置的自動校時。儲存採交易合併，避免兩台同時整份覆蓋。斷線先留本機，上線或手動同步再重試。首次登入會合併本站本機進度；舊的每頁 HTML localStorage 尚無自動遷移，需依原檔鍵名另外轉換。

若同一欄位的修改時間完全相同，勾選狀態以已勾選優先；篩選狀態則依物件欄位排序後的 JSON 字串比較，固定採較大者，確保合併順序不影響結果。較新的修改仍優先。更新網站後，其他裝置已開啟的分頁也需重新整理，才能套用相同的衝突規則。

Firestore 每份進度文件上限 1 MiB；超大型詞表若接近上限需改分片。雲端失敗顯示警告並保留本機，恢復連線後可按「同步進度」重試。不要只靠關閉頁面觸發保存，切換裝置前確認同步成功。

## GitHub Pages

將此資料夾內容放入你選定的 Git 儲存庫（或指定 docs/），設定 Pages 的發布分支與資料夾，再由你本機 commit / push。根目錄的 .nojekyll 需保留。每次新增詞表 push data/ 和 catalog.json 即可；進度檔不 push。

網站和詞彙 JSON 在一般 GitHub Pages 為公開；Firebase 詞表讀取只限指定 UID，寫入另須 Google 登入。私人進度規則只允許指定 UID。瀏覽器本機資料同一設定下仍可被使用該裝置的人看到。

## 自訂欄位

columns 是 `{key,label,type}` 陣列；type 僅接受 text 或 checkbox。text 的 key 對應每筆 words 的字串欄位，label 與文字均安全地以純文字顯示，搜尋涵蓋所有 text 欄。seen 與 marked 兩個 checkbox 欄必須存在，順序和標題可自訂；勾選值繼續用原詞表／單字 ID 保存，欄位改名或排序不會重設進度。term 仍為必要的詞彙識別文字。

例如英文詞表的 columns 可使用以下設定（僅示範欄位設定，完整詞表仍需保留 schemaVersion、id、filters、words 等欄位）：

```json
{
  "columns": [
    {"key":"seen","label":"已看過","type":"checkbox"},
    {"key":"marked","label":"待複習","type":"checkbox"},
    {"key":"term","label":"英文單字","type":"text"},
    {"key":"ipa","label":"音標","type":"text"},
    {"key":"definition","label":"中文解釋","type":"text"},
    {"key":"example","label":"英文例句","type":"text"}
  ]
}
```

對應 words 每筆包含 id、term、ipa、definition、example。不需要時將 filters 設成 `{ "categories": [], "periods": [] }`，網站會隱藏這兩個篩選器。category／period 有篩選選項時仍須提供對應值；沒有字幕時間可省略 firstStartSeconds。修改現有詞表時將 schemaVersion 由 1 升為 2 並加入 columns，保留詞表與單字 ID；目錄與私人進度格式仍為 1。
