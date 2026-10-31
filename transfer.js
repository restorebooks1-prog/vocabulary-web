import {assert, validateCatalog, validateDataset} from './core.js';

export const maxImportBytes = 8 * 1024 * 1024;
const maxDatasetBytes = 900000;

// Only publish schema fields; browser progress and unrelated file properties stay private.
export function publicDataset(raw) {
  validateDataset(raw);
  const {schemaVersion, id, collectionName, itemName, summary} = raw;
  const columns = raw.columns.map(({key, label, type}) => ({key, label, type}));
  const filters = {categories:[...raw.filters.categories], periods:[...raw.filters.periods]};
  const keys = new Set(['id', 'term', 'category', 'period', 'firstStartSeconds',
    ...columns.filter(column => column.type === 'text').map(column => column.key)]);
  const words = raw.words.map(word => Object.fromEntries(
    [...keys].filter(key => Object.hasOwn(word, key)).map(key => [key, word[key]])
  ));
  return {schemaVersion, id, collectionName, itemName, summary, columns, filters, words};
}

export function prepareImports(rawDatasets) {
  assert(Array.isArray(rawDatasets) && rawDatasets.length > 0 && rawDatasets.length <= 100, '每次請匯入 1～100 份詞表 JSON');
  const ids = new Set();
  let totalBytes = 0;
  return rawDatasets.map(raw => {
    const data = publicDataset(raw);
    assert(!ids.has(data.id), `匯入檔案的詞表 ID 重複：${data.id}`);
    ids.add(data.id);
    const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    assert(bytes <= maxDatasetBytes, `詞表 ${data.id} 超過 900 KB，請拆成不同詞表 ID`);
    totalBytes += bytes;
    assert(totalBytes <= maxImportBytes, '每次匯入總大小不可超過 8 MiB');
    return data;
  });
}

export function mergeDatasetCatalog(base, datasets) {
  const result = structuredClone(validateCatalog(base));
  for (const data of datasets) {
    for (const collection of result.collections) collection.items = collection.items.filter(item => item.id !== data.id);
    let collection = result.collections.find(collection => collection.name === data.collectionName);
    if (!collection) {
      let id = data.id, suffix = 0;
      while (result.collections.some(collection => collection.id === id)) id = `${data.id.slice(0, 70)}-${++suffix}`;
      collection = {id, name:data.collectionName, items:[]};
      result.collections.push(collection);
    }
    collection.items.push({id:data.id, name:data.itemName, file:`data/${data.id}.json`});
  }
  result.collections = result.collections.filter(collection => collection.items.length);
  return validateCatalog(result);
}
