import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {cleanState, mergeStates} from '../core.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const storageCode = source.slice(source.indexOf('async function persist('), source.indexOf('function timestamp('));
const syncCode = source.slice(source.indexOf('async function synchronize('), source.indexOf('function changed('));
const deleteCode = source.slice(source.indexOf("$('delete-dataset').onclick"), source.indexOf('async function loadAccountDatasets('));
const selectCode = source.slice(source.indexOf('async function selectItem('), source.indexOf('function buildCatalog('));
const storageKey = id => `vocab-library:v1:owner:${id}`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function setup() {
  const stored = new Map(), remote = new Map(), queues = new Map();
  const locks = {request(key, action) {
    const pending = (queues.get(key) || Promise.resolve()).then(action);
    queues.set(key, pending.catch(() => {}));
    return pending;
  }};
  const localStorage = {
    getItem:key => stored.get(key) ?? null,
    setItem:(key, value) => stored.set(key, value)
  };
  const makeEntry = id => ({data:{id, collectionName:'Test', itemName:id}, dirty:true,
    state:cleanState({schemaVersion:1, words:{old:{seen:{value:true, at:1}}}})});
  for (const id of ['chosen', 'other']) {
    const entry = makeEntry(id);
    localStorage.setItem(storageKey(id), JSON.stringify({state:entry.state, dirty:true}));
    remote.set(id, structuredClone(entry.state));
  }
  function tab() {
    const elements = new Map();
    const entries = new Map(['chosen', 'other'].map(id => [id, makeEntry(id)]));
    const context = {
      $:id => {
        if (!elements.has(id)) elements.set(id, {disabled:false, addEventListener() {}, showModal() {}, focus() {}});
        return elements.get(id);
      },
      entries, current:entries.get('chosen'), cloudReady:true, accountVersion:0, deleteTarget:null,
      storageKey, localStorage, navigator:{locks}, crypto:{randomUUID:() => 'reset-1'},
      structuredClone, mergeStates, clearTimeout() {}, setTimeout() {},
      warn() {}, status() {}, updateImportAccess() {}, restoreFilters() {}, render() {},
      location:{reload() { context.reloaded = true; }},
      window:{addEventListener(type, callback) { context.onStorage = callback; }},
      cloud:{
        async push(id, state) { remote.set(id, structuredClone(state)); return state; },
        async pull(id) { return remote.get(id) ?? null; },
        async deleteDataset(id) { remote.delete(id); }
      }
    };
    runInNewContext(`${storageCode}\n${syncCode}\n${deleteCode}\nthis.persist = persist; this.sync = synchronize;`, context);
    return context;
  }
  return {stored, remote, tab, localStorage};
}

test('刪除通知到達前，舊分頁也不能回寫進度；其他詞表仍可保存及同步', async () => {
  const {stored, remote, tab} = setup();
  const deletingTab = tab(), staleTab = tab();
  deletingTab.$('delete-dataset').onclick();
  await deletingTab.$('confirm-delete').onclick();
  const marker = stored.get(storageKey('chosen'));
  await staleTab.persist(staleTab.current);
  await staleTab.sync(staleTab.current);
  assert.equal(stored.get(storageKey('chosen')), marker);
  assert.equal(remote.has('chosen'), false);
  assert.equal(staleTab.current.deleting, true);

  const other = staleTab.entries.get('other');
  other.state.words.new = {marked:{value:true, at:2}};
  await staleTab.persist(other);
  await staleTab.sync(other);
  assert.equal(JSON.parse(stored.get(storageKey('other'))).state.words.new.marked.value, true);
  assert.equal(remote.get('other').words.new.marked.value, true);
});

test('刪除等待另一分頁已送出的上傳結束，避免上傳結果復活遠端進度', async () => {
  const {remote, tab} = setup();
  const deletingTab = tab(), uploadingTab = tab();
  const started = deferred(), finish = deferred();
  uploadingTab.cloud.push = async (id, state) => {
    started.resolve();
    await finish.promise;
    remote.set(id, structuredClone(state));
    return state;
  };
  const upload = uploadingTab.sync(uploadingTab.current);
  await started.promise;
  deletingTab.$('delete-dataset').onclick();
  const deletion = deletingTab.$('confirm-delete').onclick();
  assert.equal(remote.has('chosen'), true);
  finish.resolve();
  await Promise.all([upload, deletion]);
  assert.equal(remote.has('chosen'), false);
  assert.equal(deletingTab.reloaded, true);
});

test('刪除期間排隊的另一分頁上傳，在取得鎖後檢查刪除標記並停止', async () => {
  const {remote, tab} = setup();
  const deletingTab = tab(), uploadingTab = tab();
  const started = deferred(), finish = deferred();
  deletingTab.cloud.deleteDataset = async id => {
    started.resolve();
    await finish.promise;
    remote.delete(id);
  };
  deletingTab.$('delete-dataset').onclick();
  const deletion = deletingTab.$('confirm-delete').onclick();
  await started.promise;
  const upload = uploadingTab.sync(uploadingTab.current);
  finish.resolve();
  await Promise.all([deletion, upload]);
  assert.equal(remote.has('chosen'), false);
  assert.equal(uploadingTab.current.deleting, true);
});

test('刪除事件重新載入持有舊詞表的分頁，保留其他詞表的本機資料', async () => {
  const {stored, tab, localStorage} = setup();
  const deletingTab = tab(), staleTab = tab();
  const otherBefore = stored.get(storageKey('other'));
  deletingTab.$('delete-dataset').onclick();
  await deletingTab.$('confirm-delete').onclick();
  staleTab.onStorage({storageArea:localStorage, key:storageKey('chosen'), newValue:stored.get(storageKey('chosen'))});
  assert.equal(staleTab.current.deleting, true);
  assert.equal(staleTab.reloaded, true);
  assert.equal(stored.get(storageKey('other')), otherBefore);
});

test('刪除後重新載入同 ID 詞表可以保存新進度，延遲的舊事件不恢復舊進度', async () => {
  const {stored, remote, tab, localStorage} = setup();
  const oldValue = stored.get(storageKey('chosen'));
  const deletingTab = tab();
  deletingTab.$('delete-dataset').onclick();
  await deletingTab.$('confirm-delete').onclick();
  const freshTab = tab();
  freshTab.entries.clear();
  Object.assign(freshTab, {
    current:null, selectionVersion:0, cardSession:null, cleanState,
    publishedDatasets:new Map([['chosen', {id:'chosen', collectionName:'Test', itemName:'chosen', summary:'', words:[]}]]),
    renderColumns() {}, history:{replaceState() {}}
  });
  runInNewContext(`${selectCode}\nthis.select = selectItem;`, freshTab);
  await freshTab.select({id:'chosen', name:'chosen'}, {name:'Test'});
  const entry = freshTab.current;
  assert.equal(entry.resetVersion, 'reset-1');
  entry.state.words.new = {seen:{value:true, at:2}};
  entry.dirty = true;
  await freshTab.persist(entry);
  freshTab.onStorage({storageArea:localStorage, key:storageKey('chosen'), newValue:oldValue});
  await freshTab.sync(entry);
  assert.equal(entry.state.words.old, undefined);
  assert.equal(remote.get('chosen').words.new.seen.value, true);
  assert.equal(freshTab.reloaded, undefined);
});
