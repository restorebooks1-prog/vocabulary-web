import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {mergeStates} from '../core.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const warningCode = source.slice(source.indexOf('const warnings ='), source.indexOf('function storageKey'));
const syncCode = source.slice(source.indexOf('async function synchronize('), source.indexOf('function changed('));

test('同步失敗後重試成功會移除舊錯誤，保留其他保存警告', async () => {
  const elements = {warning:{textContent:''}, status:{textContent:''}};
  const entry = {data:{id:'test'}, state:{schemaVersion:1, words:{}}, dirty:true};
  let failure = new Error('Cloud Firestore API is disabled');
  const context = {
    $:id => elements[id], current:entry, cloudReady:true, accountVersion:0, structuredClone, mergeStates,
    persist() {}, restoreFilters() {}, render() {},
    cloud:{async push(id, state) { if (failure) throw failure; return state; }}
  };
  runInNewContext(`${warningCode}\n${syncCode}\nthis.synchronize = synchronize; this.warn = warn;`, context);
  context.warn('瀏覽器無法保存');
  await context.synchronize(entry);
  assert.match(elements.status.textContent, /雲端同步失敗/);
  assert.match(elements.warning.textContent, /Cloud Firestore API is disabled/);
  assert.equal(entry.dirty, true);

  failure = null;
  await context.synchronize(entry);
  assert.equal(elements.status.textContent, '已與雲端同步');
  assert.equal(elements.warning.textContent, '瀏覽器無法保存');
  assert.equal(entry.dirty, false);
});
