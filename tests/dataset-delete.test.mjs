import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf("$('delete-dataset').onclick"), source.indexOf('async function loadAccountDatasets('));
const lockCode = source.slice(source.indexOf('async function withCloudProgressLock('), source.indexOf('function changed('));

function setup(failure) {
  const elements = new Map();
  const context = {
    $:id => {
      if (!elements.has(id)) elements.set(id, {disabled:false, addEventListener() {}, showModal() {}, focus() {}});
      return elements.get(id);
    },
    deleteTarget:null, deleting:false, cloudReady:true, accountVersion:0, current:{data:{id:'chosen', collectionName:'作品', itemName:'第 1 集'}},
    entries:new Map(), clearTimeout() {}, storageKey:id => `owner:${id}`,
    crypto:{randomUUID:() => 'reset-1'},
    localStorage:{setItem(key, value) { context.removedKey = key; context.resetMarker = JSON.parse(value); }},
    updateImportAccess() {}, location:{reload() { context.reloaded = true; }},
    cloud:{async deleteDataset(id) { context.deletedId = id; if (failure) throw failure; }}
  };
  runInNewContext(lockCode + code, context);
  return context;
}

test('刪除前顯示確認並固定目標，成功後重新載入目錄', async () => {
  const context = setup();
  context.$('delete-dataset').onclick();
  assert.equal(context.deletedId, undefined);
  assert.match(context.$('delete-description').textContent, /chosen/);
  context.current = {data:{id:'another'}};
  await context.$('confirm-delete').onclick();
  assert.equal(context.deletedId, 'chosen');
  assert.equal(context.removedKey, 'owner:chosen');
  assert.equal(context.resetMarker.resetVersion, 'reset-1');
  assert.equal(context.resetMarker.state, undefined);
  assert.equal(context.reloaded, true);
});

test('刪除失敗保留頁面並顯示可重試錯誤', async () => {
  const context = setup(new Error('Missing permissions'));
  context.$('delete-dataset').onclick();
  await context.$('confirm-delete').onclick();
  assert.equal(context.reloaded, undefined);
  assert.equal(context.removedKey, undefined);
  assert.equal(context.deleting, false);
  assert.equal(context.$('cancel-delete').disabled, false);
  assert.match(context.$('delete-result').textContent, /Missing permissions/);
});

test('先等候進行中的同步，再刪除詞表與進度；等待時阻止新的同步', async () => {
  const context = setup();
  let finish;
  const entry = {syncFinished:new Promise(resolve => { finish = resolve; })};
  context.entries.set('chosen', entry);
  context.$('delete-dataset').onclick();
  assert.match(context.$('delete-description').textContent, /一併清除/);
  const deleting = context.$('confirm-delete').onclick();
  assert.equal(entry.deleting, true);
  assert.equal(context.deletedId, undefined);
  finish(); await deleting;
  assert.equal(context.deletedId, 'chosen');
  assert.equal(context.removedKey, 'owner:chosen');
});

test('停用的刪除按鈕不會送出請求', async () => {
  const context = setup();
  context.$('confirm-delete').disabled = true;
  await context.$('confirm-delete').onclick();
  assert.equal(context.deletedId, undefined);
});

test('本機清除失敗明確告知雲端已刪除，重試可完成清除', async () => {
  const context = setup();
  context.localStorage.setItem = () => { throw new Error('storage blocked'); };
  context.$('delete-dataset').onclick();
  await context.$('confirm-delete').onclick();
  assert.equal(context.deletedId, 'chosen');
  assert.equal(context.reloaded, undefined);
  assert.match(context.$('delete-result').textContent, /雲端詞表與進度已刪除/);
  context.localStorage.setItem = () => {};
  await context.$('confirm-delete').onclick();
  assert.equal(context.reloaded, true);
});

const cloudSource = readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');
const deleteCode = cloudSource.slice(cloudSource.indexOf('    async deleteDataset('), cloudSource.indexOf('    async pull('));

test('雲端詞表與私人進度使用同一批次提交，提交錯誤會傳回呼叫端', async () => {
  const deleted = [];
  let commits = 0;
  const context = {
    auth:{currentUser:{uid:'owner', providerData:[{providerId:'google.com'}]}}, config:{ownerUid:'owner'}, db:{},
    reference:id => `users/owner/lists/${id}`,
    dbSDK:{doc:(db, ...path) => path.join('/'), writeBatch:() => ({
      delete(ref) { deleted.push(ref); },
      async commit() { commits++; throw new Error('permission denied'); }
    })}
  };
  runInNewContext(`this.api = {${deleteCode}};`, context);
  await assert.rejects(context.api.deleteDataset('chosen'), /permission denied/);
  assert.deepEqual(deleted, ['publicDatasets/chosen', 'users/owner/lists/chosen']);
  assert.equal(commits, 1);
  await assert.rejects(context.api.deleteDataset('../bad'), /詞表 ID 無效/);
  context.auth.currentUser.uid = 'other';
  await assert.rejects(context.api.deleteDataset('chosen'), /只有指定/);
  assert.equal(commits, 1);
});
