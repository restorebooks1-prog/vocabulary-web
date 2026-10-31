import {config} from './config.js';
import {validateCatalog, validateDataset, cleanState, mergeStates, normalizeFilters, visibleWords, cardWords, clearWordField} from './core.js';
const $ = id => document.getElementById(id);
const entries = new Map();
let cardSession = null;
let catalog, current, cloud, user, selectionVersion = 0, resetTargets = [], cloudReady = false;
const warn = message => { $('warning').textContent = message; };
const status = message => { $('status').textContent = message; };
function storageKey(id) { return `vocab-library:v1:${config.ownerUid || 'local'}:${id}`; }
function persist(entry) {
  try { localStorage.setItem(storageKey(entry.data.id), JSON.stringify({state:entry.state, dirty:entry.dirty})); }
  catch { warn('瀏覽器無法保存；本次仍可操作，但尚未同步的修改可能在關閉頁面後遺失；請確認雲端同步成功。'); }
}
function timestamp(entry) {
  const records = Object.values(entry.state.words).flatMap(fields => Object.values(fields));
  return Math.max(Date.now(), (entry.state.filters?.at || 0) + 1, ...records.map(record => record.at + 1));
}
function markChanged(entry) {
  entry.dirty = true; persist(entry);
  status(cloudReady ? '已保存在本機，等待上傳…' : '已保存在本機；尚未連接你的雲端帳號。');
  clearTimeout(entry.timer); entry.timer = setTimeout(() => synchronize(entry), 700);
}
async function synchronize(entry) {
  if (!entry || !cloudReady || entry.syncing) return;
  entry.syncing = true;
  try {
    const sent = structuredClone(entry.state);
    const remote = entry.dirty ? await cloud.push(entry.data.id, sent) : await cloud.pull(entry.data.id);
    const changedDuringRequest = JSON.stringify(entry.state) !== JSON.stringify(sent);
    entry.state = mergeStates(entry.state, remote);
    entry.dirty = changedDuringRequest;
    persist(entry);
    if (current === entry) { restoreFilters(); render(); status(entry.dirty ? '有新修改，等待上傳…' : '已與雲端同步'); }
  } catch (error) {
    if (current === entry) { status('雲端同步失敗，本機進度已保留；可按「同步進度」重試。'); warn(error.message); }
  } finally { entry.syncing = false; }
  // 修改發生在請求期間才接著保存；失敗時不無限重試。
  if (entry.dirty && cloudReady && entry.retryAfterChange) { entry.retryAfterChange = false; synchronize(entry); }
}
function changed(entry) {
  if (entry.syncing) entry.retryAfterChange = true;
  markChanged(entry);
}
function buildFilter(id, key, title) {
  const details = $(id), fieldset = details.querySelector('fieldset');
  details.hidden = current.data.filters[key].length === 0;
  const focusIndex = [...fieldset.querySelectorAll('input')].indexOf(document.activeElement);
  fieldset.querySelectorAll('label').forEach(node => node.remove());
  const options = current.data.filters[key], selected = new Set(current.filters[key]);
  const add = (text, checked, callback) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = checked; label.append(input, document.createTextNode(text));
    input.addEventListener('change', () => callback(input.checked)); fieldset.append(label); return input;
  };
  const all = add('All', selected.size === options.length, checked => {
    current.filters[key] = checked ? [...options] : []; saveFilters();
  });
  all.indeterminate = selected.size > 0 && selected.size < options.length;
  for (const option of options) add(option, selected.has(option), checked => {
    current.filters[key] = checked ? [...current.filters[key], option] : current.filters[key].filter(x => x !== option);
    saveFilters();
  });
  details.querySelector('summary').textContent = `${title}（${selected.size} / ${options.length}）`;
  if (focusIndex >= 0) fieldset.querySelectorAll('input')[focusIndex]?.focus();
}
function restoreFilters() {
  current.filters = normalizeFilters(current.data, current.state.filters?.value);
  $('search').value = current.filters.search; $('unseen').checked = current.filters.unseenOnly; $('marked').checked = current.filters.markedOnly;
}
function saveFilters() {
  current.state.filters = {value:structuredClone(current.filters), at:timestamp(current)};
  changed(current); render();
}
function render() {
  if (!current) return;
  buildFilter('category-filter', 'categories', '只看哪些分類'); buildFilter('period-filter', 'periods', '只看哪些首次出現時段');
  const words = visibleWords(current.data, current.filters, current.state), fragment = document.createDocumentFragment();
  for (const word of words) {
    const row = document.createElement('tr');
    row.classList.toggle('seen', !!current.state.words[word.id]?.seen?.value);
    row.classList.toggle('marked', !!current.state.words[word.id]?.marked?.value);
    for (const column of current.data.columns) {
      if (column.type === 'text') {
        const cell = row.insertCell(); cell.textContent = word[column.key];
        if (column.key === 'term') cell.classList.add('term-cell');
        continue;
      }
      const field = column.key;
      const cell = row.insertCell(), checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = !!current.state.words[word.id]?.[field]?.value;
      checkbox.setAttribute('aria-label', `${column.label}：${word.term}`);
      checkbox.addEventListener('change', () => {
        (current.state.words[word.id] ??= {})[field] = {value:checkbox.checked, at:timestamp(current)};
        const nextFocus = {wordId:word.id, field}; changed(current); render();
        document.querySelector(`input[data-word-id="${nextFocus.wordId}"][data-field="${nextFocus.field}"]`)?.focus();
      });
      checkbox.dataset.wordId = word.id; checkbox.dataset.field = field; cell.append(checkbox);
    }
    fragment.append(row);
  }
  $('words').replaceChildren(fragment);
  const seen = words.filter(word => current.state.words[word.id]?.seen?.value).length;
  $('progress-title').textContent = `Progress ·（${(words.length ? seen / words.length * 100 : 0).toFixed(1)}%）`;
  $('progress-value').textContent = `已看過 ${seen} / ${words.length}${words.length ? '' : ' · 無符合條件項目'}`;
  $('progress').max = words.length || 1; $('progress').value = seen;
  $('card-mode').disabled = false;
  if (cardSession) renderCard();
}
function renderCard() {
  const {entry, words, index} = cardSession;
  const word = words[index], content = $('card-content'), actions = $('card-actions');
  content.replaceChildren();
  actions.replaceChildren();
  $('card-progress').textContent = word ? `${index + 1} / ${words.length}`
    : words.length ? `已完成本輪 ${words.length} 張卡片。` : '目前篩選結果沒有尚未勾選 seen 的單字。';
  if (!word) {
    const button = document.createElement('button');
    button.className = 'card-check';
    button.textContent = '離開 Card Mode';
    button.setAttribute('aria-keyshortcuts', 'z x');
    button.title = '快捷鍵：Z 或 X';
    button.addEventListener('click', leaveCardPage);
    actions.append(button);
    return;
  }
  for (const column of entry.data.columns) {
    if (column.key === 'period' || column.key === 'category') continue;
    if (column.type === 'text') {
      const heading = document.createElement('span'), value = document.createElement('div');
      heading.className = 'card-label'; heading.textContent = column.label;
      value.textContent = word[column.key];
      if (column.key === 'term') value.className = 'card-term';
      const field = document.createElement('div'); field.className = 'card-field';
      field.dataset.key = column.key;
      if (column.key !== 'term') field.append(heading);
      field.append(value); content.append(field);
      continue;
    }
    const button = document.createElement('button');
    button.className = 'card-check'; button.dataset.key = column.key;
    button.textContent = column.label;
    button.setAttribute('aria-pressed', String(!!entry.state.words[word.id]?.[column.key]?.value));
    button.addEventListener('click', () => {
      const value = !entry.state.words[word.id]?.[column.key]?.value;
      (entry.state.words[word.id] ??= {})[column.key] = {value, at:timestamp(entry)};
      cardSession.index++;
      changed(entry); render(); focusCard();
    });
    actions.append(button);
  }
  [...actions.children].forEach((button, index) => {
    const shortcut = ['z', 'x'][index];
    button.setAttribute('aria-keyshortcuts', shortcut);
    button.title = `快捷鍵：${shortcut.toUpperCase()}`;
  });
}
document.addEventListener('keydown', event => {
  if (!cardSession || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  const shortcut = {KeyZ:'z', KeyX:'x'}[event.code] || event.key.toLowerCase();
  const index = ['z', 'x'].indexOf(shortcut);
  if (index < 0) return;
  const completed = cardSession.index >= cardSession.words.length;
  const button = $('card-actions').querySelectorAll('button')[completed ? 0 : index];
  if (!button || button.disabled) return;
  event.preventDefault();
  button.click();
});
function focusCard() {
  $('card-title').focus({preventScroll:true});
}
$('card-mode').onclick = () => {
  if (!current) return;
  history.pushState({cardMode:true}, '', location.href);
  showCardPage();
};
function showCardPage() {
  if (!current) return;
  cardSession = {entry:current, words:cardWords(current.data, current.filters, current.state), index:0, listScroll:window.scrollY};
  $('library-page').hidden = true;
  $('card-page').hidden = false;
  renderCard(); focusCard(); window.scrollTo(0, 0);
}
function showLibraryPage() {
  const listScroll = cardSession?.listScroll || 0;
  cardSession = null;
  $('card-page').hidden = true;
  $('library-page').hidden = false;
  $('card-mode').focus({preventScroll:true});
  window.scrollTo(0, listScroll);
}
function leaveCardPage() {
  if (!cardSession) return;
  showLibraryPage();
  if (history.state?.cardMode) history.back();
}
$('close-cards').onclick = leaveCardPage;
window.addEventListener('popstate', () => {
  if (history.state?.cardMode) showCardPage();
  else if (cardSession) showLibraryPage();
});
function renderColumns() {
  const fragment = document.createDocumentFragment();
  for (const column of current.data.columns) {
    const heading = document.createElement('th'); heading.scope = 'col'; heading.textContent = column.label; fragment.append(heading);
  }
  $('columns').replaceChildren(fragment);
}
async function selectItem(item, collection) {
  const version = ++selectionVersion;
  try {
    if (!entries.has(item.id)) {
      const response = await fetch(item.file, {cache:'no-cache'}); if (!response.ok) throw new Error(`無法載入 ${item.file}`);
      const data = validateDataset(await response.json());
      if (data.id !== item.id || data.collectionName !== collection.name || data.itemName !== item.name) throw new Error('目錄與詞表的 ID 或名稱不一致');
      let saved;
      try { saved = JSON.parse(localStorage.getItem(storageKey(item.id)) || 'null'); }
      catch { warn('本機進度損壞或無法讀取，未覆寫雲端資料。'); }
      entries.set(item.id, {data, state:cleanState(saved?.state), dirty:saved?.dirty === true});
    }
    if (version !== selectionVersion) return;
    current = entries.get(item.id); restoreFilters(); renderColumns(); render();
    $('title').textContent = `${collection.name} · ${item.name}`; $('summary').textContent = `${current.data.summary} 共 ${current.data.words.length} 項。`;
    $('library').open = false;
    history.replaceState(null, '', `#${item.id}`); status('已載入本機進度');
    await synchronize(current);
  } catch (error) { warn(error.message); }
}
function buildCatalog() {
  for (const collection of catalog.collections) {
    const container = document.createElement('div'); container.className = 'collection';
    const button = document.createElement('button'); button.textContent = `${collection.name} ›`; button.setAttribute('aria-expanded','false');
    const submenu = document.createElement('div'); submenu.className = 'submenu';
    button.addEventListener('click', () => {
      const expanded = container.classList.toggle('expanded'); button.setAttribute('aria-expanded',String(expanded));
    });
    for (const item of collection.items) {
      const link = document.createElement('button'); link.textContent = item.name;
      link.addEventListener('click', () => selectItem(item, collection)); submenu.append(link);
    }
    container.append(button, submenu); $('catalog').append(container);
  }
}
for (const details of document.querySelectorAll('details')) {
  document.addEventListener('click', event => { if (!details.contains(event.target)) details.open = false; });
  details.addEventListener('keydown', event => { if (event.key === 'Escape') { details.open = false; details.querySelector('summary').focus(); } });
}
$('search').addEventListener('input', () => { current.filters.search = $('search').value; saveFilters(); });
for (const [id,key] of [['unseen','unseenOnly'],['marked','markedOnly']]) $(id).addEventListener('change', () => { current.filters[key] = $(id).checked; saveFilters(); });
$('reset').onclick = () => {
  if (!current) return; resetTargets = visibleWords(current.data,current.filters,current.state).map(word => word.id);
  $('reset-description').textContent = `僅清除目前所有篩選條件符合的 ${resetTargets.length} 項；另一欄、隱藏列及篩選條件會保留。`;
  $('clear-seen').disabled = $('clear-marked').disabled = !resetTargets.length; $('reset-dialog').showModal();
};
for (const field of ['seen','marked']) $(`clear-${field}`).onclick = () => {
  const at = timestamp(current);
  clearWordField(current.state, resetTargets, field, at);
  changed(current); render(); $('reset-dialog').close();
};
$('cancel-reset').onclick = () => $('reset-dialog').close();
$('reset-dialog').addEventListener('close', () => { resetTargets = []; $('reset').focus(); });
$('sync').onclick = () => current && synchronize(current);
window.addEventListener('online', () => { for (const entry of entries.values()) if (entry.dirty) synchronize(entry); });
async function initialize() {
  const response = await fetch('data/catalog.json',{cache:'no-cache'}); if (!response.ok) throw new Error('無法載入詞表目錄');
  catalog = validateCatalog(await response.json()); buildCatalog();
  let selected;
  for (const collection of catalog.collections) for (const item of collection.items) if (!selected || item.id === location.hash.slice(1)) selected = {item,collection};
  if (selected) await selectItem(selected.item,selected.collection); else $('title').textContent = '尚無詞表';
  $('login').disabled = !config.firebase; $('sync').disabled = true;
  if (!config.firebase) return;
  const {connectCloud} = await import('./cloud.js');
  cloud = await connectCloud(config, account => {
    // 回呼在 connectCloud 回傳後執行，確保 cloud 已設定。
    setTimeout(() => {
      user = account; cloudReady = !!user && user.uid === config.ownerUid;
      $('login').hidden = !!user; $('logout').hidden = !user; $('sync').disabled = !cloudReady;
      if (user && !cloudReady) warn(`此帳號未獲授權。帳號 UID：${user.uid}。請在設定及資料庫規則填入你的 UID。`);
      else warn('');
      status(cloudReady ? '已登入，正在載入雲端進度…' : '本機模式；請登入已授權帳號。');
      if (cloudReady) synchronize(current);
    },0);
  });
  $('login').onclick = () => cloud.login().catch(error => warn(`登入失敗：${error.message}`));
  $('logout').onclick = async () => {
    try {
      for (const entry of entries.values()) if (entry.dirty) await synchronize(entry);
      await cloud.logout();
    } catch(error) { warn(error.message); }
  };
}
initialize().catch(error => { warn(error.message); $('title').textContent = '載入失敗'; });
