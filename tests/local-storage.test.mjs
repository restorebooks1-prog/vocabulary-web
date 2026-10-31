import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {cleanState, mergeStates} from '../core.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function persist('), source.indexOf('function timestamp('));
const storageKey = id => `vocab-library:v1:owner:${id}`;
const makeEntry = () => ({data:{id:'test'}, state:cleanState(null), dirty:false});

function setup() {
  const stored = new Map(), tabs = [];
  let queue = Promise.resolve();
  const locks = {request(key, callback) {
    assert.equal(key, storageKey('test'));
    const pending = queue.then(callback);
    queue = pending.catch(() => {});
    return pending;
  }};
  const localStorage = {
    getItem:key => stored.get(key) ?? null,
    setItem:(key, value) => stored.set(key, value)
  };
  function tab(entry = makeEntry()) {
    const context = {
      localStorage, navigator:{locks}, storageKey, mergeStates, current:entry,
      entries:new Map([['test', entry]]), warnings:[], timers:[], renders:0,
      warn(message) { context.warnings.push(message); },
      window:{addEventListener(type, callback) { assert.equal(type, 'storage'); context.onStorage = callback; }},
      setTimeout(callback) { context.timers.push(callback); return context.timers.length; }, clearTimeout() {},
      synchronize() {}, restoreFilters() {}, render() { context.renders++; }
    };
    runInNewContext(`${code}\nthis.persist = persist;`, context);
    tabs.push(context);
    return context;
  }
  return {stored, tab, localStorage};
}

test('離線分頁使用過期快取保存不同單字時，重新開啟仍保留雙方修改', async () => {
  const {stored, tab} = setup();
  const first = tab(), second = tab();
  first.current.state.words.alpha = {seen:{value:true, at:1}};
  first.current.dirty = true;
  second.current.state.words.beta = {marked:{value:true, at:2}};
  second.current.dirty = true;
  await Promise.all([first.persist(first.current), second.persist(second.current)]);
  const restored = JSON.parse(stored.get(storageKey('test')));
  assert.equal(restored.state.words.alpha.seen.value, true);
  assert.equal(restored.state.words.beta.marked.value, true);
  assert.equal(restored.dirty, true);
});

test('同步完成不能覆蓋另一分頁的新修改或清除其待同步狀態', async () => {
  const {stored, tab} = setup();
  const first = tab(), second = tab();
  second.current.state.words.word = {seen:{value:false, at:2}};
  second.current.dirty = true;
  await second.persist(second.current);
  first.current.state.words.word = {seen:{value:true, at:1}};
  first.current.syncing = true;
  await first.persist(first.current);
  const restored = JSON.parse(stored.get(storageKey('test')));
  assert.equal(restored.state.words.word.seen.value, false);
  assert.equal(restored.dirty, true);
  assert.equal(first.current.retryAfterChange, true);
  // Once this merged state has reached the server it can be marked clean.
  first.current.dirty = false;
  await first.persist(first.current);
  assert.equal(JSON.parse(stored.get(storageKey('test'))).dirty, false);
});

test('跨分頁事件合併進度與篩選、更新畫面並安排同步，不立即回寫造成循環', () => {
  const {stored, tab, localStorage} = setup();
  const context = tab();
  context.current.state.words.local = {seen:{value:true, at:1}};
  context.current.syncing = true;
  context.onStorage({storageArea:localStorage, key:storageKey('test'), newValue:JSON.stringify({
    state:{schemaVersion:1, words:{remote:{marked:{value:true, at:2}}}, filters:{value:{search:'新'}, at:2}}, dirty:true
  })});
  assert.equal(context.current.state.words.local.seen.value, true);
  assert.equal(context.current.state.words.remote.marked.value, true);
  assert.equal(context.current.state.filters.value.search, '新');
  assert.equal(context.current.dirty, true);
  assert.equal(context.current.retryAfterChange, true);
  assert.equal(context.renders, 1);
  assert.equal(context.timers.length, 1);
  assert.equal(stored.size, 0);
});

test('其他帳號、未載入詞表、其他儲存區與刪除事件不更動畫面', () => {
  const {tab, localStorage} = setup();
  const context = tab();
  const event = {storageArea:localStorage, key:storageKey('test'), newValue:'{}'};
  for (const change of [
    {key:'vocab-library:v1:other:test'}, {key:storageKey('unopened')},
    {storageArea:{}}, {newValue:null}, {key:null}
  ]) context.onStorage({...event, ...change});
  assert.equal(context.renders, 0);
  assert.equal(context.timers.length, 0);
});

test('損壞的本機資料可重新保存，保存失敗保留記憶體中的修改並顯示警告', async () => {
  const {stored, tab, localStorage} = setup();
  const context = tab();
  context.current.state.words.word = {seen:{value:true, at:1}};
  context.current.dirty = true;
  stored.set(storageKey('test'), '{');
  await context.persist(context.current);
  assert.equal(JSON.parse(stored.get(storageKey('test'))).state.words.word.seen.value, true);
  localStorage.setItem = () => { throw new Error('quota exceeded'); };
  await context.persist(context.current);
  assert.equal(context.current.dirty, true);
  assert.equal(context.current.state.words.word.seen.value, true);
  assert.match(context.warnings.at(-1), /瀏覽器無法保存/);
});

for (const failure of ['missing', 'invalid-json', 'blocked']) {
  test(`帶有刪除版本的詞表在本機資料 ${failure} 時仍可保存及同步雲端`, async () => {
    const {stored, tab, localStorage} = setup();
    const entry = {...makeEntry(), resetVersion:'previous-reset', dirty:true};
    entry.state.words.word = {seen:{value:true, at:1}};
    const context = tab(entry);
    if (failure === 'invalid-json') stored.set(storageKey('test'), '{');
    if (failure === 'blocked') {
      localStorage.getItem = () => { throw new Error('storage blocked'); };
      localStorage.setItem = () => { throw new Error('storage blocked'); };
    }
    await context.persist(entry);
    assert.notEqual(entry.deleting, true);
    assert.equal(entry.dirty, true);
    if (failure !== 'blocked') {
      assert.equal(JSON.parse(stored.get(storageKey('test'))).resetVersion, entry.resetVersion);
    }
    let pushes = 0;
    Object.assign(context, {
      cloudReady:true, accountVersion:0, structuredClone, status() {},
      cloud:{async push(id, sent) { pushes++; return sent; }}
    });
    context.navigator.locks.request = (key, callback) => Promise.resolve().then(callback);
    const syncCode = source.slice(source.indexOf('async function synchronize('), source.indexOf('function changed('));
    runInNewContext(`${syncCode}\nthis.synchronize = synchronize;`, context);
    // Exercise the synchronization read independently from the preceding save.
    stored.clear();
    if (failure === 'invalid-json') stored.set(storageKey('test'), '{');
    await context.synchronize(entry);
    assert.equal(pushes, 1);
    assert.notEqual(entry.deleting, true);
    assert.equal(entry.dirty, false);
    assert.equal(entry.state.words.word.seen.value, true);
    if (failure === 'blocked') assert.ok(context.warnings.some(message => /瀏覽器無法保存/.test(message)));
  });
}
