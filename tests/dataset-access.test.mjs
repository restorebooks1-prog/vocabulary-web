import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function loadAccountDatasets('), source.indexOf('async function initialize('));

function setup() {
  const account = {uid:'owner'};
  const context = {
    user:account, cloudReady:true, datasetsReady:false, selectionVersion:0, accountVersion:0, pendingDatasetId:'',
    location:{hash:'#test'}, current:{data:{id:'test'}},
    updateImportAccess() {}, warn() {},
    async applyPublishedDatasets() { context.applied = true; }
  };
  runInNewContext(`${code}\nthis.load = loadAccountDatasets;`, context);
  return {context, account};
}

test('未授權時不讀取雲端詞表，指定帳號登入後才載入', async () => {
  const {context, account} = setup();
  let reads = 0;
  context.cloud = {async loadDatasets() { reads++; return []; }};
  context.cloudReady = false;
  await context.load(account);
  assert.equal(reads, 0);
  context.cloudReady = true;
  await context.load(account);
  assert.equal(reads, 1);
  assert.equal(context.applied, true);
  assert.equal(context.datasetsReady, true);
});

test('讀取期間登出後不套用雲端詞表或開放匯入', async () => {
  const {context, account} = setup();
  let finish;
  context.cloud = {loadDatasets:() => new Promise(resolve => { finish = resolve; })};
  const loading = context.load(account);
  context.cloudReady = false;
  context.user = null;
  finish([]);
  await loading;
  assert.equal(context.applied, undefined);
  assert.equal(context.datasetsReady, false);
});

test('登出後重新登入同一帳號也不接受前一次登入的讀取結果', async () => {
  const {context, account} = setup();
  let finish;
  context.cloud = {loadDatasets:() => new Promise(resolve => { finish = resolve; })};
  const loading = context.load(account);
  context.accountVersion += 2;
  finish([]);
  await loading;
  assert.equal(context.applied, undefined);
  assert.equal(context.datasetsReady, false);
});

test('登入後優先載入待選取的書籤，即使網址已顯示內建詞表', async () => {
  const {context, account} = setup();
  context.pendingDatasetId = 'bookmarked-cloud';
  context.location.hash = '#built-in';
  context.cloud = {async loadDatasets() { return []; }};
  context.applyPublishedDatasets = async (datasets, preferredId) => { context.preferredId = preferredId; };
  await context.load(account);
  assert.equal(context.preferredId, 'bookmarked-cloud');
});

test('雲端讀取期間手動切換詞表，優先保留新的選擇', async () => {
  const {context, account} = setup();
  context.pendingDatasetId = 'bookmarked-cloud';
  let finish;
  context.cloud = {loadDatasets:() => new Promise(resolve => { finish = resolve; })};
  context.applyPublishedDatasets = async (datasets, preferredId) => { context.preferredId = preferredId; };
  const loading = context.load(account);
  context.selectionVersion++;
  context.current = {data:{id:'manually-selected'}};
  finish([]);
  await loading;
  assert.equal(context.preferredId, 'manually-selected');
});

test('手動選取詞表會取消待選書籤，自動顯示內建詞表時則保留', async () => {
  for (const preservePendingSelection of [false, true]) {
    const {context} = setup();
    const entry = {data:{id:'test', filters:{categories:[], periods:[]}}};
    Object.assign(context, {
      pendingDatasetId:'bookmarked-cloud', entries:new Map([['test', entry]]),
      $:() => ({}), restoreFilters() {}, renderColumns() {}, render() {}, status() {},
      history:{replaceState() {}}, async synchronize() {}
    });
    const start = source.indexOf('async function selectItem(');
    runInNewContext(`${source.slice(start, source.indexOf('function buildCatalog(', start))}\nthis.select = selectItem;`, context);
    await context.select({id:'test', name:'Test'}, {name:'Built in'}, preservePendingSelection);
    assert.equal(context.pendingDatasetId, preservePendingSelection ? 'bookmarked-cloud' : '');
  }
});
