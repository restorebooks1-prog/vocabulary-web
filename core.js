export const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function validateCatalog(catalog) {
  assert(catalog?.schemaVersion === 1 && Array.isArray(catalog.collections), '目錄格式錯誤');
  const collectionIds = new Set(), itemIds = new Set();
  for (const collection of catalog.collections) {
    assert(idPattern.test(collection.id) && !collectionIds.has(collection.id), '分類 ID 無效或重複');
    collectionIds.add(collection.id);
    assert(typeof collection.name === 'string' && collection.name.trim() && Array.isArray(collection.items), '分類名稱／項目無效');
    for (const item of collection.items) {
      assert(idPattern.test(item.id) && !itemIds.has(item.id), '詞表 ID 無效或重複'); itemIds.add(item.id);
      assert(typeof item.name === 'string' && item.name.trim(), '子項目名稱無效');
      assert(/^data\/[a-z0-9_-]+\.json$/.test(item.file), '詞表必須位於 data/，不可使用外部網址或相對跳脫路徑');
    }
  }
  return catalog;
}
export function validateDataset(data) {
  assert(data?.schemaVersion === 2 && idPattern.test(data.id), '詞表版本／ID 無效（需要 schemaVersion 2）');
  for (const key of ['collectionName', 'itemName', 'summary']) assert(typeof data[key] === 'string', `${key} 必須是字串`);
  assert(data.collectionName.trim() && data.itemName.trim(), '分類與子項目不可空白');
  assert(Array.isArray(data.columns) && data.columns.length > 0, '缺少 columns 欄位定義');
  const columnKeys = new Set();
  for (const column of data.columns) {
    assert(column && typeof column.key === 'string' && /^[a-z][a-zA-Z0-9_]{0,79}$/.test(column.key)
      && !['id','__proto__','constructor','prototype'].includes(column.key) && !columnKeys.has(column.key), '欄位 key 無效或重複');
    assert(typeof column.label === 'string' && column.label.trim(), '欄位名稱不可空白');
    assert(['text','checkbox'].includes(column.type), '只支援 text／checkbox 欄位，不允許 HTML 或程式碼');
    assert((column.type === 'checkbox') === ['seen','marked'].includes(column.key), '勾選欄位只支援 seen／marked');
    columnKeys.add(column.key);
  }
  assert(columnKeys.has('seen') && columnKeys.has('marked'), '需要 seen 與 marked 進度欄位');
  assert(data.filters && Array.isArray(data.filters.categories) && Array.isArray(data.filters.periods), '缺少篩選選項');
  for (const options of Object.values(data.filters)) {
    assert(Array.isArray(options) && options.every(x => typeof x === 'string') && new Set(options).size === options.length, '篩選選項無效或重複');
  }
  assert(Array.isArray(data.words), '缺少單字資料'); const ids = new Set();
  for (const word of data.words) {
    assert(idPattern.test(word.id) && !ids.has(word.id), '單字 ID 無效或重複'); ids.add(word.id);
    assert(typeof word.term === 'string' && word.term.trim(), '單字需要 term 作為識別用的顯示文字');
    for (const column of data.columns) if (column.type === 'text') {
      assert(Object.hasOwn(word,column.key) && typeof word[column.key] === 'string', `單字 ${word.id} 缺少文字欄位 ${column.key}`);
    }
    assert(!Object.hasOwn(word,'seen') && !Object.hasOwn(word,'marked'), '公開詞表不能包含私人勾選進度');
    assert((!data.filters.categories.length || data.filters.categories.includes(word.category))
      && (!data.filters.periods.length || data.filters.periods.includes(word.period)), '篩選對應無效');
    assert(word.firstStartSeconds === undefined || word.firstStartSeconds === null || (Number.isFinite(word.firstStartSeconds) && word.firstStartSeconds >= 0), '首次時間無效');
  }
  return data;
}
export function defaultFilters(data) {
  return { search: '', unseenOnly: false, markedOnly: false, categories: [...data.filters.categories], periods: [...data.filters.periods] };
}
export function normalizeFilters(data, saved) {
  const filters = defaultFilters(data);
  if (!saved || typeof saved !== 'object') return filters;
  if (typeof saved.search === 'string') filters.search = saved.search;
  for (const key of ['unseenOnly', 'markedOnly']) if (typeof saved[key] === 'boolean') filters[key] = saved[key];
  for (const key of ['categories', 'periods']) if (Array.isArray(saved[key])) filters[key] = data.filters[key].filter(x => saved[key].includes(x));
  return filters;
}
export function validateRecord(record) {
  return record && typeof record === 'object' && Number.isSafeInteger(record.at) && record.at >= 0;
}
export function cleanState(raw) {
  const state = { schemaVersion: 1, words: Object.create(null), filters: null };
  if (!raw || raw.schemaVersion !== 1) return state;
  for (const [id, fields] of Object.entries(raw.words || {})) {
    if (!idPattern.test(id)) continue;
    for (const key of ['seen', 'marked']) {
      const record = fields?.[key];
      if (validateRecord(record) && typeof record.value === 'boolean') (state.words[id] ??= {})[key] = {value: record.value, at: record.at};
    }
  }
  if (validateRecord(raw.filters) && raw.filters.value && typeof raw.filters.value === 'object') state.filters = raw.filters;
  return state;
}
// 每個欄位獨立合併，避免手機的標記覆蓋電腦的已看過狀態；同時修改同一欄以時間較新者為準。
export function mergeStates(left, right) {
  const result = cleanState(left), incoming = cleanState(right);
  for (const [id, fields] of Object.entries(incoming.words)) {
    for (const [key, record] of Object.entries(fields)) {
      const current = result.words[id]?.[key];
      if (!current || record.at > current.at) (result.words[id] ??= {})[key] = record;
    }
  }
  if (incoming.filters && (!result.filters || incoming.filters.at > result.filters.at)) result.filters = incoming.filters;
  return result;
}
export function visibleWords(data, filters, state) {
  const query = filters.search.trim().toLocaleLowerCase();
  const categories = new Set(filters.categories), periods = new Set(filters.periods);
  const searchColumns = data.columns.filter(column => column.type === 'text');
  return data.words.filter(word => (!data.filters.categories.length || categories.has(word.category))
    && (!data.filters.periods.length || periods.has(word.period))
    && (!filters.unseenOnly || !state.words[word.id]?.seen?.value)
    && (!filters.markedOnly || state.words[word.id]?.marked?.value)
    && (!query || searchColumns.some(column => word[column.key].toLocaleLowerCase().includes(query))));
}
export function cardWords(data, filters, state) {
  return visibleWords(data, {...filters, unseenOnly:true}, state);
}
export function clearWordField(state, ids, field, at) {
  assert(field === 'seen' || field === 'marked', '未知的勾選欄位');
  for (const id of ids) (state.words[id] ??= {})[field] = {value:false, at};
}
export function timePeriod(seconds) {
  if (seconds === null) return '時間未知';
  const start = Math.floor(seconds / 180) * 3 + 1;
  return `${start}～${start + 2}分鐘`;
}
