import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {cleanState, mergeStates} from '../core.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const accountCode = source.slice(source.indexOf('function handleAccountChange('), source.indexOf('async function initialize('));
const syncCode = source.slice(source.indexOf('async function synchronize('), source.indexOf('function changed('));
const logoutStart = source.indexOf("  $('logout').onclick = async");
const logoutCode = source.slice(logoutStart, source.indexOf('\n  };', logoutStart) + 5);

function setup() {
  const elements = new Map();
  const entry = {data:{id:'private-cloud'}, state:cleanState(null), dirty:true, timer:42};
  const context = {
    $:id => {
      if (!elements.has(id)) elements.set(id, {
        textContent:'private data', value:'private search', disabled:false, hidden:false, checked:true,
        close() { this.closed = true; },
        replaceChildren() { this.cleared = true; },
        querySelectorAll() { return []; }
      });
      return elements.get(id);
    },
    config:{ownerUid:'owner'}, user:{uid:'owner'}, cloudReady:true, datasetsReady:true,
    accountVersion:0, selectionVersion:0, pendingDatasetId:'', current:entry, cardSession:{entry},
    entries:new Map([[entry.data.id, entry]]), publishedDatasets:new Map([[entry.data.id, entry.data]]),
    pendingImports:[entry.data], resetTargets:['secret'], deleteTarget:entry.data.id, importing:true, deleting:true,
    builtInCatalog:{schemaVersion:1, collections:[{id:'builtin', name:'Built in', items:[{id:'public'}]}]},
    catalog:{collections:[{items:[{id:entry.data.id}]}]},
    location:{pathname:'/', search:''}, history:{replaceState() {}},
    clearTimeout(timer) { context.cancelledTimer = timer; },
    structuredClone, mergeStates, warn() {}, status() {}, updateImportAccess() {},
    buildCatalog() { context.menuIds = context.catalog.collections.flatMap(group => group.items.map(item => item.id)); },
    selectItem(item) { context.selectedId = item.id; },
    persist() { context.persisted = true; }, restoreFilters() {}, render() {}, loadAccountDatasets() {},
    cloud:{async logout() { context.signedOut = true; }}
  };
  runInNewContext(`${syncCode}\n${accountCode}\n${logoutCode}\nthis.changeAccount = handleAccountChange; this.sync = synchronize;`, context);
  return {context, entry};
}

test('登出立即清除雲端畫面、目錄、匯出與卡片資料，保留本機待同步進度', async () => {
  const {context, entry} = setup();
  await context.$('logout').onclick();
  assert.equal(context.signedOut, true);
  assert.equal(context.cloudReady, false);
  assert.equal(context.current, null);
  assert.equal(context.cardSession, null);
  assert.equal(context.entries.size, 0);
  assert.equal(context.publishedDatasets.size, 0);
  assert.deepEqual(context.menuIds, ['public']);
  assert.equal(context.selectedId, 'public');
  assert.equal(context.$('export-dataset').disabled, true);
  assert.equal(context.$('card-mode').disabled, true);
  assert.equal(context.$('words').cleared, true);
  assert.equal(context.$('card-content').cleared, true);
  assert.equal(context.$('card-actions').cleared, true);
  assert.equal(context.$('summary').textContent, '');
  assert.equal(context.$('delete-description').textContent, '');
  assert.equal(context.$('import-dialog').closed, true);
  assert.equal(context.pendingImports.length, 0);
  assert.equal(context.deleteTarget, null);
  assert.equal(context.cancelledTimer, 42);
  assert.equal(entry.dirty, true);
});

test('同步仍在等待時就呼叫 signOut，稍後收到的舊結果不寫回本機或標記為已同步', async () => {
  const {context, entry} = setup();
  let finish;
  context.cloud.push = () => new Promise(resolve => { finish = resolve; });
  const syncing = context.sync(entry);
  await context.$('logout').onclick();
  assert.equal(context.signedOut, true);
  finish({schemaVersion:1, words:{secret:{seen:{value:true, at:1}}}});
  await syncing;
  assert.equal(context.persisted, undefined);
  assert.equal(entry.dirty, true);
  assert.equal(entry.state.words.secret, undefined);
  assert.equal(context.current, null);
});

test('其他帳號登入或其他分頁登出時，也會清除已載入的受限資料', () => {
  for (const account of [null, {uid:'other'}]) {
    const {context} = setup();
    context.changeAccount(account);
    assert.equal(context.publishedDatasets.size, 0);
    assert.equal(context.cardSession, null);
    assert.equal(context.$('export-dataset').disabled, true);
    assert.equal(context.selectedId, 'public');
  }
});

test('沒有內建詞表時，登出後保持空白且不能匯出受限詞表', async () => {
  const {context} = setup();
  context.builtInCatalog.collections = [];
  await context.$('logout').onclick();
  assert.equal(context.$('title').textContent, '尚無詞表');
  assert.equal(context.$('export-dataset').disabled, true);
  assert.equal(context.selectedId, undefined);
  assert.equal(context.current, null);
});

test('雲端覆蓋內建詞表後，登出會重新載入同 ID 的內建版本', async () => {
  const {context} = setup();
  context.builtInCatalog.collections[0].items[0].id = 'private-cloud';
  await context.$('logout').onclick();
  assert.equal(context.selectedId, 'private-cloud');
  assert.equal(context.entries.size, 0);
  assert.equal(context.publishedDatasets.size, 0);
});

test('首次未登入的回呼保留待選書籤，實際登出則清除待選書籤', () => {
  const {context} = setup();
  context.cloudReady = false;
  context.user = null;
  context.pendingDatasetId = 'bookmarked-cloud';
  context.selectItem = (item, collection, preservePendingSelection) => {
    if (!preservePendingSelection) context.pendingDatasetId = '';
  };
  context.changeAccount(null);
  assert.equal(context.pendingDatasetId, 'bookmarked-cloud');
  context.cloudReady = true;
  context.changeAccount(null);
  assert.equal(context.pendingDatasetId, '');
});

test('登出前啟動的詞表載入不會把舊選取放回快取', async () => {
  const {context} = setup();
  const data = {id:'old-selection', collectionName:'Built in', itemName:'Old'};
  let finish;
  context.fetch = () => new Promise(resolve => { finish = resolve; });
  context.validateDataset = data => data;
  const start = source.indexOf('async function selectItem(');
  runInNewContext(`${source.slice(start, source.indexOf('function buildCatalog(', start))}\nthis.selectOld = selectItem;`, context);
  context.selectItem = item => { context.selectedId = item.id; };
  const loading = context.selectOld({id:data.id, name:data.itemName, file:'data/old-selection.json'}, {name:data.collectionName});
  await context.$('logout').onclick();
  finish({ok:true, json:async () => data});
  await loading;
  assert.equal(context.entries.size, 0);
  assert.equal(context.current, null);
});

test('登出後才完成的匯入不會重新套用雲端詞表', async () => {
  const {context} = setup();
  let finish;
  context.cloud.importDatasets = () => new Promise(resolve => { finish = resolve; });
  context.applyPublishedDatasets = async () => { context.applied = true; };
  const start = source.indexOf("$('confirm-import').onclick");
  runInNewContext(source.slice(start, source.indexOf("$('cancel-import').onclick", start)), context);
  const importing = context.$('confirm-import').onclick();
  await context.$('logout').onclick();
  finish(); await importing;
  assert.equal(context.applied, undefined);
  assert.equal(context.publishedDatasets.size, 0);
});
