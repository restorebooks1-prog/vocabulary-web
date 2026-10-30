import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {validateCatalog,validateDataset,assert,timePeriod} from '../core.js';
const root = new URL('../',import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path,root),'utf8'));
const catalog = validateCatalog(await read('data/catalog.json'));
let total = 0;
for (const collection of catalog.collections) for (const item of collection.items) {
  const data = validateDataset(await read(item.file));
  assert(data.id === item.id && data.collectionName === collection.name && data.itemName === item.name, `${item.file} 目錄對應錯誤`);
  for (const word of data.words) {
    if (!Object.hasOwn(word,'firstStartSeconds')) continue;
    const expected = timePeriod(word.firstStartSeconds);
    assert(word.period === expected || (word.firstStartSeconds !== null && word.period.endsWith(` · ${expected}`)), `${item.file}: ${word.id} 時段錯誤`);
  }
  total += data.words.length;
}
console.log(`驗證通過：${catalog.collections.length} 分類，${total} 個單字。${fileURLToPath(root)}`);
