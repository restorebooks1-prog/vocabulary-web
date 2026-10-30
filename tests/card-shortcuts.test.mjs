import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf("document.addEventListener('keydown', event => {"), source.indexOf('function focusCard()'));

function pressKey(overrides, completed = true) {
  let listener, clicks = [0, 0], prevented = false;
  const buttons = clicks.map((_, index) => ({click() { clicks[index]++; }}));
  runInNewContext(handler, {
    document:{addEventListener(type, callback) { listener = callback; }},
    cardSession:{index:completed ? 1 : 0, words:[{}]},
    Element:class {},
    $:() => ({querySelectorAll:() => completed ? buttons.slice(0, 1) : buttons})
  });
  listener({key:'z', code:'KeyZ', preventDefault() { prevented = true; }, ...overrides});
  return {clicks, prevented};
}

test('完成後 Z 與 X 都觸發離開按鈕，支援中文輸入法的實體按鍵', () => {
  for (const code of ['KeyZ', 'KeyX']) {
    assert.deepEqual(pressKey({code, key:'Process', isComposing:true}), {clicks:[1, 0], prevented:true});
  }
});

test('進行中 Z 和 X 分別觸發第一與第二個按鈕', () => {
  assert.deepEqual(pressKey({code:'KeyZ'}, false).clicks, [1, 0]);
  assert.deepEqual(pressKey({code:'KeyX'}, false).clicks, [0, 1]);
});

test('長按與組合鍵不觸發卡片操作', () => {
  for (const overrides of [{repeat:true}, {ctrlKey:true}, {altKey:true}, {metaKey:true}]) {
    assert.deepEqual(pressKey(overrides), {clicks:[0, 0], prevented:false});
  }
});
