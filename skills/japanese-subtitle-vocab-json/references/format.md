# 日文字幕單字格式 v2（目錄 v1、私人進度 v1）

網站以 data/catalog.json 發現詞表，不掃描資料夾。

```json
{
  "schemaVersion": 1,
  "collections": [{
    "id": "series-a",
    "name": "作品名或分類名",
    "items": [{"id":"series-a-01","name":"01集或任意子項目","file":"data/series-a-01.json"}]
  }]
}
```

每份詞表格式如下。示範詞只解釋格式，不得加入使用者的正式詞表。

```json
{
  "schemaVersion": 2,
  "id": "series-a-01",
  "columns": [
    {
      "key": "seen",
      "label": "已看過",
      "type": "checkbox"
    },
    {
      "key": "marked",
      "label": "標記",
      "type": "checkbox"
    },
    {
      "key": "category",
      "label": "分類",
      "type": "text"
    },
    {
      "key": "term",
      "label": "單字／固定說法",
      "type": "text"
    },
    {
      "key": "reading",
      "label": "假名讀音",
      "type": "text"
    },
    {
      "key": "meaning",
      "label": "本段意思",
      "type": "text"
    },
    {
      "key": "hint",
      "label": "字幕形式／提示",
      "type": "text"
    },
    {
      "key": "period",
      "label": "首次出現時段",
      "type": "text"
    }
  ],
  "collectionName": "作品名或分類名",
  "itemName": "01集或任意子項目",
  "summary": "來源與涵蓋範圍",
  "filters": {"categories":["日常"],"periods":["1～3分鐘"]},
  "words": [{
    "id":"iku-go",
    "category":"日常",
    "term":"行く",
    "reading":"いく",
    "meaning":"去",
    "hint":"行った（いった）：去了",
    "firstStartSeconds":12.5,
    "period":"1～3分鐘"
  }]
}
```

所有顯示欄位皆為純文字；firstStartSeconds 是非負秒數或 null，未知時間的 period 必須為「時間未知」。不要加入 seen、marked、私人姓名、登入資訊或個人進度。多集合併時，period 可為「S01E01 · 1～3分鐘」，firstStartSeconds 為各集從零開始的時間。

以下僅說明私人進度的內部結構，並非可上傳或匯入的檔案。網站不提供匯入／匯出；正式詞表只能經由 Git 發布。Firebase 文件位於 users/<ownerUid>/lists/<datasetId>，文件內容與詞表分開：

```json
{
  "schemaVersion":1,
  "words":{"iku-go":{"seen":{"value":true,"at":1793400000000},"marked":{"value":false,"at":1793400000001}}},
  "filters":{"value":{"search":"","unseenOnly":false,"markedOnly":false,"categories":["日常"],"periods":["1～3分鐘"]},"at":1793400000002}
}
```

at 是修改時間的毫秒數。每個勾選欄位獨立合併，時間較新者優先；false 也必須保存，代表取消勾選。篩選整組作為一個記錄合併。雲端合併時，比現有進度舊的欄位不會覆蓋較新修改。

columns 的 key 對應 words 內文字欄位，label 決定表頭，陣列順序決定顯示順序。checkbox 欄只可為 seen、marked，其值由私人進度取得，不寫入 words。term 為每詞必要顯示識別文字；任意英文詞表可自行定義其他 text 欄，不必有 reading／meaning／hint。categories 或 periods 選項為空陣列時，該篩選器不顯示，也不限制結果；日文字幕資料仍按本 skill 完整產生兩組篩選。
