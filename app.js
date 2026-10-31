import {config} from './config.js';
import {idPattern, validateCatalog, validateDataset, cleanState, mergeStates, normalizeFilters, visibleWords, cardWords, clearWordField} from './core.js';
import {maxImportBytes, publicDataset, prepareImports, mergeDatasetCatalog} from './transfer.js';
const $ = id => document.getElementById(id);
const entries = new Map();
const publishedDatasets = new Map();
let pendingImports = [], importing = false, datasetsReady = false;
let deleteTarget = null, deleting = false;
let cardSession = null;
// Automatic built-in selections may replace the hash before cloud lists are available.
let pendingDatasetId = location.hash.slice(1);
let catalog, builtInCatalog, current, cloud, user, selectionVersion = 0, accountVersion = 0, resetTargets = [], cloudReady = false;
const warnings = new Map();
const warn = (message, source = 'general') => {
  if (message) warnings.set(source, message);
  else warnings.delete(source);
  $('warning').textContent = [...warnings.values()].join('\n');
};
const status = message => { $('status').textContent = message; };
function storageKey(id) { return `vocab-library:v1:${config.ownerUid || 'local'}:${id}`; }
async function persist(entry) {
  const key = storageKey(entry.data.id);
  const save = () => {
    if (entry.deleting) return;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { warn('部分本機進度損壞，將保存目前仍可讀取的進度。', 'pending-storage'); }
    // Only an explicit different marker proves deletion; missing/unreadable storage does not.
    if (typeof saved?.resetVersion === 'string' && saved.resetVersion !== entry.resetVersion) { entry.deleting = true; return; }
    const merged = mergeStates(entry.state, saved?.state);
    // A different tab may have saved edits while this tab was syncing.
    const addedChanges = JSON.stringify(merged) !== JSON.stringify(entry.state);
    entry.dirty ||= addedChanges;
    if (addedChanges && entry.syncing) entry.retryAfterChange = true;
    entry.state = merged;
    localStorage.setItem(key, JSON.stringify({state:entry.state, dirty:entry.dirty, resetVersion:entry.resetVersion}));
  };
  try {
    // Serialize read/merge/write across tabs on HTTPS and localhost.
    if (globalThis.navigator?.locks) await navigator.locks.request(key, save);
    else save();
  }
  catch { warn('瀏覽器無法保存；本次仍可操作，但尚未同步的修改可能在關閉頁面後遺失；請確認雲端同步成功。'); }
}
window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || !event.key?.startsWith(storageKey('')) || !event.newValue) return;
  const id = event.key.slice(storageKey('').length), entry = entries.get(id);
  if (!entry) return;
  try {
    const saved = JSON.parse(event.newValue);
    // Ignore delayed events from before this entry's reset, rather than restoring stale progress.
    if (saved?.resetVersion !== entry.resetVersion && typeof saved?.resetVersion !== 'string') return;
    if (typeof saved?.resetVersion === 'string' && saved.resetVersion !== entry.resetVersion) {
      const latest = JSON.parse(localStorage.getItem(event.key) || 'null');
      if (latest?.resetVersion === entry.resetVersion) return;
      entry.deleting = true;
      clearTimeout(entry.timer);
      // Reload this tab's catalog and discard only the deleted list's stale state.
      location.reload();
      return;
    }
    entry.state = mergeStates(entry.state, saved?.state);
    entry.dirty ||= saved?.dirty === true;
    if (entry.dirty) {
      if (entry.syncing) entry.retryAfterChange = true;
      clearTimeout(entry.timer); entry.timer = setTimeout(() => synchronize(entry), 700);
    }
    if (current === entry) { restoreFilters(); render(); }
  } catch { warn('其他分頁的本機進度無法讀取；目前進度仍保留。', 'pending-storage'); }
});
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
  if (!entry || !cloudReady || entry.syncing || entry.deleting) return;
  const version = accountVersion;
  entry.syncing = true;
  let finishSync;
  entry.syncFinished = new Promise(resolve => { finishSync = resolve; });
  try {
    await withCloudProgressLock(entry.data.id, async () => {
      if (entry.deleting || version !== accountVersion || !cloudReady) return;
      let saved;
      try { saved = JSON.parse(globalThis.localStorage?.getItem(storageKey(entry.data.id)) || 'null'); }
      catch { /* A storage failure must not prevent cloud recovery. */ }
      if (typeof saved?.resetVersion === 'string' && saved.resetVersion !== entry.resetVersion) { entry.deleting = true; return; }
      const sent = structuredClone(entry.state);
      const remote = entry.dirty ? await cloud.push(entry.data.id, sent) : await cloud.pull(entry.data.id);
      if (version !== accountVersion || !cloudReady || entry.deleting) return;
      const changedDuringRequest = JSON.stringify(entry.state) !== JSON.stringify(sent);
      entry.state = mergeStates(entry.state, remote);
      entry.dirty = changedDuringRequest;
      await persist(entry);
      if (version !== accountVersion || !cloudReady || entry.deleting) return;
      if (current === entry) { restoreFilters(); render(); warn('', 'sync'); status(entry.dirty ? '有新修改，等待上傳…' : '已與雲端同步'); }
    });
  } catch (error) {
    if (version === accountVersion && current === entry) { status('雲端同步失敗，本機進度已保留；可按「同步進度」重試。'); warn(error.message, 'sync'); }
  } finally { entry.syncing = false; finishSync(); }
  // 修改發生在請求期間才接著保存；失敗時不無限重試。
  if (version === accountVersion && entry.dirty && cloudReady && entry.retryAfterChange) { entry.retryAfterChange = false; synchronize(entry); }
}
async function withCloudProgressLock(id, action) {
  // Order uploads and deletion across tabs, including requests already in flight.
  if (globalThis.navigator?.locks) return navigator.locks.request(`${storageKey(id)}:cloud`, action);
  return action();
}
function changed(entry) {
  if (entry.syncing) entry.retryAfterChange = true;
  markChanged(entry);
}
async function synchronizeAll() {
  if (!cloudReady) return;
  const version = accountVersion;
  // Restore progress without loading or publishing vocabulary from localStorage.
  try {
    const prefix = storageKey('');
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!idPattern.test(id) || entries.has(id)) continue;
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved?.dirty === true) entries.set(id, {data:{id}, progressOnly:true, state:cleanState(saved.state), dirty:true, resetVersion:saved.resetVersion});
      } catch { warn('部分本機進度無法讀取，其他詞表仍會繼續同步。', 'pending-storage'); }
    }
  } catch { warn('無法讀取本機待同步進度；已載入的詞表仍會繼續同步。', 'pending-storage'); }
  const targets = [...entries.values()].filter(entry => entry === current || entry.dirty);
  for (const entry of targets) {
    if (!cloudReady || version !== accountVersion) return;
    await synchronize(entry);
  }
  if (!cloudReady || version !== accountVersion) return;
  const remaining = [...entries.values()].filter(entry => entry.dirty).length;
  warn(remaining ? `仍有 ${remaining} 份詞表進度等待上傳；請按「同步進度」重試。` : '', 'pending-sync');
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
async function selectItem(item, collection, preservePendingSelection = false) {
  if (!preservePendingSelection) pendingDatasetId = '';
  const version = ++selectionVersion;
  try {
    if (!entries.has(item.id) || entries.get(item.id).progressOnly) {
      let data = publishedDatasets.get(item.id);
      if (!data) {
        const response = await fetch(item.file, {cache:'no-cache'}); if (!response.ok) throw new Error(`無法載入 ${item.file}`);
        data = validateDataset(await response.json());
      }
      if (data.id !== item.id || data.collectionName !== collection.name || data.itemName !== item.name) throw new Error('目錄與詞表的 ID 或名稱不一致');
      if (version !== selectionVersion) return;
      if (entries.has(item.id)) {
        const entry = entries.get(item.id);
        entry.data = data; entry.progressOnly = false;
      } else {
        let saved;
        try { saved = JSON.parse(localStorage.getItem(storageKey(item.id)) || 'null'); }
        catch { warn('本機進度損壞或無法讀取，未覆寫雲端資料。'); }
        entries.set(item.id, {data, state:cleanState(saved?.state), dirty:saved?.dirty === true, resetVersion:saved?.resetVersion});
      }
    }
    if (version !== selectionVersion) return;
    if (cardSession) showLibraryPage();
    current = entries.get(item.id); restoreFilters(); renderColumns(); render();
    for (const id of ['reset', 'search', 'unseen', 'marked']) $(id).disabled = false;
    $('export-dataset').disabled = false;
    updateImportAccess();
    $('title').textContent = `${collection.name} · ${item.name}`; $('summary').textContent = `${current.data.summary} 共 ${current.data.words.length} 項。`;
    $('library').open = false;
    history.replaceState(null, '', `#${item.id}`); status('已載入本機進度');
    await synchronize(current);
  } catch (error) { if (version === selectionVersion) warn(error.message); }
}
function buildCatalog() {
  $('catalog').replaceChildren();
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
$('search').addEventListener('input', () => { if (current) { current.filters.search = $('search').value; saveFilters(); } });
for (const [id,key] of [['unseen','unseenOnly'],['marked','markedOnly']]) $(id).addEventListener('change', () => { if (current) { current.filters[key] = $(id).checked; saveFilters(); } });
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
$('sync').onclick = () => synchronizeAll();
window.addEventListener('online', () => synchronizeAll());
function updateImportAccess() {
  const allowed = cloudReady && user.providerData.some(provider => provider.providerId === 'google.com');
  $('import-dataset').disabled = !allowed || !datasetsReady || importing || deleting;
  $('confirm-import').disabled = !allowed || importing || deleting || !pendingImports.length;
  $('delete-dataset').disabled = !allowed || !datasetsReady || importing || deleting || !publishedDatasets.has(current?.data.id);
  $('confirm-delete').disabled = !allowed || !datasetsReady || importing || deleting || !deleteTarget;
}
async function applyPublishedDatasets(datasets, preferredId = current?.data.id || location.hash.slice(1)) {
  catalog = mergeDatasetCatalog(catalog, datasets);
  for (const data of datasets) {
    publishedDatasets.set(data.id, data);
    if (entries.has(data.id)) entries.get(data.id).data = data;
  }
  buildCatalog();
  for (const collection of catalog.collections) {
    const item = collection.items.find(item => item.id === preferredId);
    if (item) { await selectItem(item, collection); return; }
  }
  const collection = catalog.collections[0];
  if (collection?.items.length) await selectItem(collection.items[0], collection);
}
$('export-dataset').onclick = () => {
  if (!current) return;
  const data = publicDataset(current.data);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], {type:'application/json;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = `${data.id}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('已匯出目前詞表的全部單字（不含私人進度）。');
};
$('import-dataset').onclick = () => { if (!$('import-dataset').disabled) $('import-files').click(); };
$('import-files').onchange = async () => {
  const files = [...$('import-files').files];
  const version = accountVersion;
  $('import-files').value = '';
  if (!files.length || !cloudReady || !datasetsReady || importing) return;
  try {
    if (files.length > 100 || files.reduce((total, file) => total + file.size, 0) > maxImportBytes) {
      throw new Error('每次最多 100 份 JSON，總大小不可超過 8 MiB');
    }
    const rawDatasets = [];
    for (const file of files) {
      try { rawDatasets.push(JSON.parse((await file.text()).replace(/^\uFEFF/, ''))); }
      catch { throw new Error(`${file.name} 不是有效的 JSON`); }
    }
    if (version !== accountVersion || !cloudReady) return;
    pendingImports = prepareImports(rawDatasets);
    const knownIds = new Set(catalog.collections.flatMap(collection => collection.items.map(item => item.id)));
    $('import-preview').replaceChildren(...pendingImports.map(data => {
      const item = document.createElement('li');
      item.textContent = `${knownIds.has(data.id) ? '更新' : '新增'}：${data.collectionName} · ${data.itemName}（${data.id}，${data.words.length} 項）`;
      return item;
    }));
    $('import-result').textContent = '';
    warn('', 'import'); updateImportAccess(); $('import-dialog').showModal();
  } catch (error) { if (version === accountVersion) { pendingImports = []; warn(`匯入未執行：${error.message}`, 'import'); } }
};
$('confirm-import').onclick = async () => {
  if ($('confirm-import').disabled) return;
  const version = accountVersion;
  const datasets = pendingImports;
  importing = true; updateImportAccess(); $('cancel-import').disabled = true;
  $('import-result').textContent = '正在儲存到雲端…';
  try {
    await cloud.importDatasets(datasets);
    if (version !== accountVersion || !cloudReady) return;
    await applyPublishedDatasets(datasets, datasets[0].id);
    if (version !== accountVersion || !cloudReady) return;
    $('import-dialog').close();
    warn('', 'import'); status('詞表已匯入雲端；其他裝置重新整理即可讀取。');
  } catch (error) {
    if (version !== accountVersion) return;
    $('import-result').textContent = `匯入失敗：${error.message}。請確認網路，以及 Firebase 已發布最新版 firestore.rules，再重試。`;
  } finally {
    if (version === accountVersion) { importing = false; $('cancel-import').disabled = false; updateImportAccess(); }
  }
};
$('cancel-import').onclick = () => $('import-dialog').close();
$('import-dialog').addEventListener('cancel', event => { if (importing) event.preventDefault(); });
$('import-dialog').addEventListener('close', () => { pendingImports = []; $('import-dataset').focus(); });
$('delete-dataset').onclick = () => {
  if ($('delete-dataset').disabled) return;
  deleteTarget = current.data.id;
  $('delete-description').textContent = `確定刪除「${current.data.collectionName} · ${current.data.itemName}」（${deleteTarget}）的雲端詞表？將一併清除其雲端進度及此瀏覽器的勾選進度與篩選設定，此操作無法復原。若有同 ID 的內建詞表，刪除後會顯示內建版本，進度重新開始。`;
  $('delete-result').textContent = '';
  updateImportAccess();
  $('delete-dialog').showModal();
};
$('confirm-delete').onclick = async () => {
  if ($('confirm-delete').disabled) return;
  const version = accountVersion;
  const targetId = deleteTarget, entry = entries.get(targetId);
  deleting = true; updateImportAccess(); $('cancel-delete').disabled = true;
  if (entry) { entry.deleting = true; clearTimeout(entry.timer); }
  $('delete-result').textContent = '正在刪除雲端詞表…';
  let remoteDeleted = false;
  try {
    // Let an existing upload finish before deleting its remote progress.
    await entry?.syncFinished;
    if (version !== accountVersion || !cloudReady) return;
    await withCloudProgressLock(targetId, async () => {
      if (version !== accountVersion || !cloudReady) return;
      await cloud.deleteDataset(targetId);
      remoteDeleted = true;
      const key = storageKey(targetId);
      // Keep a reset marker so delayed saves/events cannot resurrect old progress.
      const remove = () => localStorage.setItem(key, JSON.stringify({resetVersion:crypto.randomUUID()}));
      if (globalThis.navigator?.locks) await navigator.locks.request(key, remove);
      else remove();
    });
  } catch (error) {
    if (version !== accountVersion) return;
    if (entry && !remoteDeleted) entry.deleting = false;
    $('delete-result').textContent = remoteDeleted
      ? '雲端詞表與進度已刪除，但此瀏覽器的進度無法清除。請允許網站儲存空間存取後重試。'
      : `刪除失敗：${error.message}。請確認網路及最新版 firestore.rules 已發布，再重試。`;
    deleting = false; $('cancel-delete').disabled = false; updateImportAccess();
    return;
  }
  if (version !== accountVersion || !cloudReady) return;
  // Reload the built-in catalog and remaining cloud datasets after a successful deletion.
  location.reload();
};
$('cancel-delete').onclick = () => $('delete-dialog').close();
$('delete-dialog').addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
$('delete-dialog').addEventListener('close', () => { deleteTarget = null; updateImportAccess(); $('delete-dataset').focus(); });
async function loadAccountDatasets(account) {
  if (!cloudReady || user !== account) return;
  const sessionVersion = accountVersion;
  try {
    const version = selectionVersion;
    const datasets = await cloud.loadDatasets();
    if (!cloudReady || user !== account || sessionVersion !== accountVersion) return;
    // Respect a list selected while the dataset request was in flight.
    const preferredId = version === selectionVersion ? pendingDatasetId || location.hash.slice(1) || current?.data.id : current?.data.id;
    await applyPublishedDatasets(datasets, preferredId);
    if (!cloudReady || user !== account || sessionVersion !== accountVersion) return;
    datasetsReady = true; updateImportAccess();
    warn('', 'datasets');
  } catch (error) {
    if (!cloudReady || user !== account || sessionVersion !== accountVersion) return;
    warn(`無法讀取雲端詞表，暫時顯示內建資料；匯入暫停。請確認 Firebase 已發布最新版 firestore.rules，再重新整理。${error.message}`, 'datasets');
  }
}
function handleAccountChange(account) {
  accountVersion++;
  if (cloudReady && (!account || account.uid !== config.ownerUid)) pendingDatasetId = '';
  user = account; cloudReady = !!user && user.uid === config.ownerUid;
  datasetsReady = false;
  if (!cloudReady) { clearAccountData(); warn('', 'import'); }
  updateImportAccess();
  warn('', 'datasets'); warn('', 'sync'); warn('', 'pending-sync'); warn('', 'pending-storage');
  $('login').hidden = !!user; $('logout').hidden = !user; $('sync').disabled = !cloudReady;
  if (user && !cloudReady) warn(`此帳號未獲授權。帳號 UID：${user.uid}。請在設定及資料庫規則填入你的 UID。`);
  else warn('');
  status(cloudReady ? '已登入，正在載入雲端進度…' : '本機模式；請登入已授權帳號。');
  if (cloudReady) { synchronizeAll(); loadAccountDatasets(account); }
}
function clearAccountData() {
  const preferredId = current?.data.id;
  selectionVersion++;
  // Progress is already persisted on each edit; discard account data and pending UI work.
  for (const entry of entries.values()) clearTimeout(entry.timer);
  entries.clear(); publishedDatasets.clear();
  current = null; cardSession = null; pendingImports = []; resetTargets = []; deleteTarget = null;
  importing = false; deleting = false;
  for (const id of ['reset-dialog', 'import-dialog', 'delete-dialog']) $(id).close();
  for (const id of ['words', 'columns', 'card-content', 'card-actions', 'import-preview']) $(id).replaceChildren();
  for (const id of ['title', 'summary', 'card-progress', 'delete-description', 'import-result', 'delete-result', 'reset-description']) $(id).textContent = '';
  $('card-page').hidden = true; $('library-page').hidden = false;
  $('card-mode').disabled = true; $('export-dataset').disabled = true;
  $('cancel-import').disabled = false; $('cancel-delete').disabled = false;
  $('search').value = ''; $('unseen').checked = false; $('marked').checked = false;
  for (const id of ['category-filter', 'period-filter']) { $(id).hidden = true; $(id).querySelectorAll('label').forEach(label => label.remove()); }
  $('progress-title').textContent = 'Progress'; $('progress-value').textContent = ''; $('progress').value = 0;
  catalog = structuredClone(builtInCatalog); buildCatalog();
  history.replaceState(null, '', location.pathname + location.search);
  const collection = catalog.collections.find(group => group.items.some(item => item.id === preferredId)) || catalog.collections[0];
  const item = collection?.items.find(item => item.id === preferredId) || collection?.items[0];
  if (item) selectItem(item, collection, true);
  else $('title').textContent = '尚無詞表';
}
async function initialize() {
  const response = await fetch('data/catalog.json',{cache:'no-cache'}); if (!response.ok) throw new Error('無法載入詞表目錄');
  builtInCatalog = validateCatalog(await response.json());
  catalog = structuredClone(builtInCatalog); buildCatalog();
  let selected;
  for (const collection of catalog.collections) for (const item of collection.items) if (!selected || item.id === location.hash.slice(1)) selected = {item,collection};
  if (selected) await selectItem(selected.item,selected.collection, true);
  else {
    $('title').textContent = '尚無詞表';
    $('summary').textContent = '登入指定 Google 帳號後，可在頁尾匯入詞表 JSON。';
  }
  $('login').disabled = !config.firebase; $('sync').disabled = true;
  if (!config.firebase) return;
  const {connectCloud} = await import('./cloud.js');
  cloud = await connectCloud(config, account => {
    // 回呼在 connectCloud 回傳後執行，確保 cloud 已設定。
    setTimeout(() => handleAccountChange(account), 0);
  });
  $('login').onclick = () => cloud.login().catch(error => warn(`登入失敗：${error.message}`));
  $('logout').onclick = async () => {
    try {
      handleAccountChange(null);
      await cloud.logout();
    } catch(error) { warn(error.message); }
  };

}
initialize().catch(error => { warn(error.message); $('title').textContent = '載入失敗'; });
