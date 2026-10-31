import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {cleanState, mergeStates, idPattern, validateDataset} from '../core.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const syncCode = source.slice(source.indexOf('async function synchronize('), source.indexOf('function changed('));
const allCode = source.slice(source.indexOf('async function synchronizeAll('), source.indexOf('function buildFilter('));
const selectCode = source.slice(source.indexOf('async function selectItem('), source.indexOf('function buildCatalog('));
const state = () => cleanState({schemaVersion:1, words:{word:{seen:{value:true, at:1}}}});
const dataset = id => ({schemaVersion:2, id, collectionName:'Collection', itemName:id, summary:'',
  columns:[{key:'seen', label:'Seen', type:'checkbox'}, {key:'marked', label:'Marked', type:'checkbox'},
    {key:'term', label:'Term', type:'text'}], filters:{categories:[], periods:[]}, words:[{id:'word', term:id}]});

function setup() {
  const stored = new Map(), elements = new Map(), pushed = [], warnings = new Map();
  const context = {
    entries:new Map(), publishedDatasets:new Map(), current:null, cloudReady:true, accountVersion:0,
    selectionVersion:0, cardSession:null, pendingDatasetId:'', structuredClone, cleanState, mergeStates, idPattern, validateDataset,
    storageKey:id => `vocab-library:v1:owner:${id}`,
    localStorage:{get length() { return stored.size; }, key:index => [...stored.keys()][index], getItem:key => stored.get(key) ?? null},
    persist(entry) { stored.set(context.storageKey(entry.data.id), JSON.stringify({state:entry.state, dirty:entry.dirty})); },
    cloud:{async push(id, sent) { pushed.push(id); return sent; }, async pull() { return null; }},
    warn(message, key) { if (message) warnings.set(key, message); else warnings.delete(key); },
    $:id => { if (!elements.has(id)) elements.set(id, {focus() {}}); return elements.get(id); },
    history:{replaceState(value, title, hash) { context.hash = hash; }},
    window:{scrollTo() {}}, restoreFilters() {}, renderColumns() {}, render() {}, status() {}, updateImportAccess() {}
  };
  const pageCode = source.slice(source.indexOf('function showLibraryPage('), source.indexOf('function leaveCardPage('));
  runInNewContext(`${syncCode}\n${allCode}\n${pageCode}\n${selectCode}\nthis.syncAll = synchronizeAll; this.select = selectItem;`, context);
  const save = (id, dirty = true) => stored.set(context.storageKey(id), JSON.stringify({state:state(), dirty}));
  return {context, stored, pushed, warnings, save};
}

test('登入補同步尚未開啟的本機進度，只處理指定帳號有效 ID 的待上傳資料', async () => {
  const {context, stored, pushed, save} = setup();
  context.current = {data:dataset('current'), state:state(), dirty:true};
  context.entries.set('current', context.current);
  save('unopened'); save('already-synced', false); save('../invalid');
  stored.set('vocab-library:v1:other:private', JSON.stringify({state:state(), dirty:true}));
  await context.syncAll();
  assert.deepEqual(pushed, ['current', 'unopened']);
  assert.equal(JSON.parse(stored.get(context.storageKey('unopened'))).dirty, false);
  assert.equal(context.current.data.id, 'current');
});

test('單份資料損壞或上傳失敗不阻止其他詞表，失敗保持 dirty 並可重試', async () => {
  const {context, stored, pushed, warnings, save} = setup();
  stored.set(context.storageKey('broken'), '{');
  save('failed'); save('success');
  context.cloud.push = async (id, sent) => { if (id === 'failed') throw new Error('offline'); pushed.push(id); return sent; };
  await context.syncAll();
  assert.deepEqual(pushed, ['success']);
  assert.equal(JSON.parse(stored.get(context.storageKey('failed'))).dirty, true);
  assert.match(warnings.get('pending-sync'), /1 份/);
  context.cloud.push = async (id, sent) => { pushed.push(id); return sent; };
  await context.syncAll();
  assert.deepEqual(pushed, ['success', 'failed']);
  assert.equal(warnings.has('pending-sync'), false);
});

test('登出中止待同步佇列，舊請求結果不改寫本機資料', async () => {
  const {context, stored, pushed, save} = setup();
  save('first'); save('second');
  let finish;
  context.cloud.push = id => { pushed.push(id); return new Promise(resolve => { finish = resolve; }); };
  const syncing = context.syncAll();
  context.cloudReady = false; context.accountVersion++;
  finish(state()); await syncing;
  assert.deepEqual(pushed, ['first']);
  assert.equal(JSON.parse(stored.get(context.storageKey('first'))).dirty, true);
  assert.equal(JSON.parse(stored.get(context.storageKey('second'))).dirty, true);
});

test('未授權時不還原或上傳本機進度', async () => {
  const {context, pushed, save} = setup();
  save('private'); context.cloudReady = false;
  await context.syncAll();
  assert.equal(context.entries.size, 0);
  assert.deepEqual(pushed, []);
});

test('開啟正在背景同步的詞表會保留同一進度物件與請求狀態', async () => {
  const {context, save} = setup();
  save('pending');
  let finish;
  context.cloud.push = () => new Promise(resolve => { finish = resolve; });
  const syncing = context.syncAll();
  const entry = context.entries.get('pending');
  context.publishedDatasets.set('pending', dataset('pending'));
  await context.select({id:'pending', name:'pending'}, {name:'Collection'});
  assert.equal(context.current, entry);
  assert.equal(entry.progressOnly, false);
  assert.equal(entry.syncing, true);
  assert.equal(entry.data.words[0].term, 'pending');
  entry.state.words.word.marked = {value:true, at:2};
  finish(state()); await syncing;
  assert.equal(entry.state.words.word.marked.value, true);
  assert.equal(entry.dirty, true);
});

test('切換詞表及重新選取同 ID 更新版本均會退出舊卡片並更新網址', async () => {
  for (const id of ['new', 'old']) {
    const {context} = setup();
    const entry = {data:dataset(id), state:state(), dirty:false};
    context.entries.set(id, entry);
    context.cardSession = {entry:{data:dataset('old')}, words:[{id:'old-word'}], listScroll:50};
    await context.select({id, name:id}, {name:'Collection'});
    assert.equal(context.cardSession, null);
    assert.equal(context.$('card-page').hidden, true);
    assert.equal(context.$('library-page').hidden, false);
    assert.equal(context.current, entry);
    assert.equal(context.hash, `#${id}`);
  }
});

test('指定帳號登入會啟動所有待同步進度的處理', () => {
  const {context} = setup();
  context.config = {ownerUid:'owner'};
  context.loadAccountDatasets = () => {};
  let calls = 0;
  context.synchronizeAll = () => { calls++; };
  const code = source.slice(source.indexOf('function handleAccountChange('), source.indexOf('function clearAccountData('));
  runInNewContext(`${code}\nhandleAccountChange({uid:'owner'});`, context);
  assert.equal(calls, 1);
});
