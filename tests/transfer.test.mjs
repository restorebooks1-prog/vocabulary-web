import test from 'node:test';
import assert from 'node:assert/strict';
import {publicDataset, prepareImports, mergeDatasetCatalog} from '../transfer.js';
import {cleanState, normalizeFilters, visibleWords} from '../core.js';

const dataset = {
  schemaVersion:2, id:'test-vocabulary', collectionName:'測試分類', itemName:'測試詞表', summary:'測試資料',
  columns:[
    {key:'seen', label:'已看過', type:'checkbox'},
    {key:'marked', label:'標記', type:'checkbox'},
    {key:'term', label:'單字', type:'text'}
  ],
  filters:{categories:[], periods:[]},
  words:[{id:'test-word', term:'測試單字'}]
};
const catalog = mergeDatasetCatalog({schemaVersion:1, collections:[]}, [dataset]);

test('未啟用篩選時也拒絕 category 與 period 夾帶物件或非字串資料', () => {
  for (const key of ['category', 'period']) {
    for (const value of [{privateNote:'secret', seen:true}, ['secret'], null, 42, true]) {
      const raw = {...dataset, words:[{...dataset.words[0], [key]:value}]};
      assert.throws(() => publicDataset(raw), /必須是字串或省略/);
      assert.throws(() => prepareImports([raw]), /必須是字串或省略/);
    }
    const raw = {...dataset, words:[{...dataset.words[0], [key]:'文字'}]};
    assert.equal(publicDataset(raw).words[0][key], '文字');
  }
  assert.deepEqual(publicDataset(dataset).words, dataset.words);
});

test('匯出可重新匯入，保留欄位順序與全部單字並排除私人狀態', () => {
  const original = structuredClone(dataset);
  original.state = {words:{private:true}};
  original.dirty = true;
  original.words[0].privateNote = '私人備註';
  const exported = publicDataset(original);
  assert.deepEqual(exported.columns, dataset.columns);
  assert.equal(exported.words.length, dataset.words.length);
  assert.equal(exported.state, undefined);
  assert.equal(exported.dirty, undefined);
  assert.equal(exported.words[0].privateNote, undefined);
  assert.deepEqual(prepareImports([JSON.parse(JSON.stringify(exported))]), [exported]);
});

test('整批驗證拒絕重複詞表、無效版本、重複單字與私人勾選', () => {
  assert.throws(() => prepareImports([dataset, dataset]), /詞表 ID 重複/);
  assert.throws(() => prepareImports([{...dataset, schemaVersion:1}]), /版本/);
  assert.throws(() => prepareImports([{...dataset, words:[dataset.words[0], dataset.words[0]]}]), /單字 ID/);
  assert.throws(() => prepareImports([{...dataset, words:[{...dataset.words[0], seen:true}]}]), /私人勾選/);
  assert.throws(() => prepareImports([]), /1～100/);
  assert.throws(() => prepareImports(Array(101).fill(dataset)), /1～100/);
});

test('大小限制依 UTF-8 位元組計算，拒絕單份過大與整批超限', () => {
  assert.throws(() => prepareImports([{...dataset, summary:'字'.repeat(300000)}]), /900 KB/);
  const datasets = Array.from({length:11}, (_, index) => ({...dataset, id:`large-${index}`, summary:'a'.repeat(780000), words:[]}));
  assert.throws(() => prepareImports(datasets), /8 MiB/);
});

test('更新可移動分類及改名，不產生重複項目且保留其他詞表', () => {
  const added = {...dataset, id:'another', itemName:'另一份'};
  const base = mergeDatasetCatalog(catalog, [added]);
  const snapshot = structuredClone(base);
  const updated = {...dataset, collectionName:'新分類', itemName:'新版'};
  const result = mergeDatasetCatalog(base, [updated]);
  assert.deepEqual(base, snapshot);
  assert.deepEqual(result.collections.flatMap(collection => collection.items.map(item => item.id)).sort(), [dataset.id, 'another'].sort());
  assert.equal(result.collections.find(collection => collection.name === '新分類').items[0].name, '新版');
  assert.equal(result.collections.find(collection => collection.name === dataset.collectionName).items[0].id, 'another');
  assert.deepEqual(mergeDatasetCatalog(result, [updated]), result);
});

test('更新詞表沿用固定單字 ID 的勾選進度，新增單字保持未看過', () => {
  const word = dataset.words[0];
  const state = cleanState({schemaVersion:1, words:{[word.id]:{seen:{value:true, at:1}}}});
  const imported = prepareImports([{...dataset, words:[word, {...word, id:'new-word'}]}])[0];
  const filters = normalizeFilters(imported, {unseenOnly:true});
  assert.deepEqual(visibleWords(imported, filters, state).map(word => word.id), ['new-word']);
});
