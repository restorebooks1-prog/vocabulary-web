import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeStates,normalizeFilters,visibleWords,cardWords,timePeriod,validateDataset,validateCatalog,clearWordField,cleanState} from '../core.js';
const columns = [{"key":"seen","label":"已看過","type":"checkbox"},{"key":"marked","label":"標記","type":"checkbox"},{"key":"category","label":"分類","type":"text"},{"key":"term","label":"單字／固定說法","type":"text"},{"key":"reading","label":"假名讀音","type":"text"},{"key":"meaning","label":"本段意思","type":"text"},{"key":"hint","label":"字幕形式／提示","type":"text"},{"key":"period","label":"首次出現時段","type":"text"}];
const data = {schemaVersion:2,columns,id:'test',collectionName:'分類',itemName:'子項目',summary:'',filters:{categories:['A','B'],periods:['1～3分鐘']},words:[{id:'w1',category:'A',term:'行く',reading:'いく',meaning:'去',hint:'',period:'1～3分鐘',firstStartSeconds:0},{id:'w2',category:'B',term:'帰る',reading:'かえる',meaning:'回家',hint:'',period:'1～3分鐘',firstStartSeconds:0}]};
test('跨裝置合併保留不同詞與欄位，取消勾選不被舊值蓋回',()=>{
  const left = {schemaVersion:1,words:{w1:{seen:{value:false,at:3}}}};
  const right = {schemaVersion:1,words:{w1:{seen:{value:true,at:2},marked:{value:true,at:4}},w2:{seen:{value:true,at:5}}}};
  const state = mergeStates(left,right);
  assert.equal(state.words.w1.seen.value,false); assert.equal(state.words.w1.marked.value,true); assert.equal(state.words.w2.seen.value,true);
});

test('相同時間的勾選與篩選衝突不受合併順序影響，重複同步後收斂', () => {
  const states = ['a', 'b', 'c'].map((search, index) => ({
    schemaVersion:1,
    words:{w1:{seen:{value:index === 1, at:1000}, marked:{value:index === 2, at:1000}}},
    filters:{value:{search, categories:['A'], periods:[], unseenOnly:false, markedOnly:false}, at:1000}
  }));
  for (const left of states) for (const right of states) {
    const merged = mergeStates(left, right);
    assert.deepEqual(merged, mergeStates(right, left));
    assert.deepEqual(mergeStates(merged, left), merged);
    assert.deepEqual(mergeStates(merged, right), merged);
    for (const third of states) {
      assert.deepEqual(mergeStates(merged, third), mergeStates(left, mergeStates(right, third)));
    }
  }
  const merged = mergeStates(mergeStates(states[0], states[1]), states[2]);
  assert.equal(merged.words.w1.seen.value, true);
  assert.equal(merged.words.w1.marked.value, true);
  assert.equal(merged.filters.value.search, 'c');
  assert.equal(mergeStates(merged, {schemaVersion:1, words:{w1:{seen:{value:false, at:1001}}}}).words.w1.seen.value, false);
});

test('同時間篩選衝突的判定忽略物件欄位排列，仍保留陣列順序', () => {
  const state = value => ({schemaVersion:1, words:{}, filters:{value, at:1}});
  const left = state({search:'z', categories:['A', 'B']});
  const reordered = state({categories:['A', 'B'], search:'z'});
  const other = state({search:'a', categories:['A', 'B']});
  assert.deepEqual(mergeStates(left, other).filters.value, mergeStates(reordered, other).filters.value);
  assert.deepEqual(mergeStates(left, reordered), mergeStates(reordered, left));
  const differentOrder = state({search:'z', categories:['B', 'A']});
  assert.deepEqual(mergeStates(left, differentOrder), mergeStates(differentOrder, left));
});
test('空選取與空搜尋恢復，未知選項移除',()=>{
  assert.deepEqual(normalizeFilters(data,{search:'',categories:[],periods:['old']}),{search:'',categories:[],periods:[],unseenOnly:false,markedOnly:false});
});
test('搜尋分類時段與勾選條件以 AND 篩選，零選取為零項',()=>{
  const state = {words:{w1:{seen:{value:true},marked:{value:true}}}};
  const filters = normalizeFilters(data,{search:'いく',markedOnly:true});
  assert.equal(visibleWords(data,filters,state).length,1);
  filters.unseenOnly=true; assert.equal(visibleWords(data,filters,state).length,0);
  filters.unseenOnly=false; filters.categories=[]; assert.equal(visibleWords(data,filters,state).length,0);
});
test('卡片只取目前篩選中的未看過單字，每輪固定清單並在重開時重新篩選',()=>{
  const state = cleanState(null), filters = normalizeFilters(data,{});
  const round = cardWords(data,filters,state);
  assert.deepEqual(round.map(word=>word.id),['w1','w2']);
  state.words.w1 = {seen:{value:true,at:1},marked:{value:true,at:1}};
  assert.deepEqual(round.map(word=>word.id),['w1','w2']);
  assert.deepEqual(cardWords(data,filters,state).map(word=>word.id),['w2']);
  assert.equal(filters.unseenOnly,false);
  filters.markedOnly = true;
  assert.deepEqual(cardWords(data,filters,state),[]);
  state.words.w2 = {marked:{value:true,at:2}};
  assert.deepEqual(cardWords(data,filters,state).map(word=>word.id),['w2']);
  filters.search = '行く';
  assert.deepEqual(cardWords(data,filters,state),[]);
  filters.search = ''; filters.categories = ['A'];
  assert.deepEqual(cardWords(data,filters,state),[]);
});
test('三分鐘邊界',()=>assert.deepEqual([0,179.999,180,359.999,360,null].map(timePeriod),['1～3分鐘','1～3分鐘','4～6分鐘','4～6分鐘','7～9分鐘','時間未知']));
test('拒絕重複 ID 與外部資料路徑',()=>{
  assert.doesNotThrow(()=>validateDataset(data));
  assert.throws(()=>validateDataset({...data,words:[data.words[0],data.words[0]]}));
  assert.throws(()=>validateCatalog({schemaVersion:1,collections:[{id:'a',name:'A',items:[{id:'b',name:'B',file:'https://evil.test/a.json'}]}]}));
});
test('詞表、單字及目錄 ID 必須是字串，不接受隱式轉型', () => {
  for (const id of [undefined, null, 123, true, ['valid'], {toString:() => 'valid'}]) {
    assert.throws(() => validateDataset({...data, id}), /版本／ID/);
    assert.throws(() => validateDataset({...data, words:[{...data.words[0], id}]}), /單字 ID/);
    const item = {id:'valid', name:'詞表', file:'data/valid.json'};
    assert.throws(() => validateCatalog({schemaVersion:1, collections:[{id, name:'分類', items:[item]}]}), /分類 ID/);
    assert.throws(() => validateCatalog({schemaVersion:1, collections:[{id:'valid', name:'分類', items:[{...item, id}]}]}), /詞表 ID/);
  }
  assert.throws(() => validateDataset({...data, words:[{...data.words[0], id:undefined}, {...data.words[1], id:'undefined'}]}), /單字 ID/);
  for (const id of ['123', 'null', 'undefined', 'constructor', 'a'.repeat(80)]) {
    assert.doesNotThrow(() => validateDataset({...data, id, words:[{...data.words[0], id}]}));
  }
});
test('批次清除使用凍結的篩選目標，保留隱藏列與另一欄',()=>{
  const state = cleanState({schemaVersion:1,words:{w1:{seen:{value:true,at:1},marked:{value:true,at:1}},w2:{seen:{value:true,at:1},marked:{value:true,at:1}}}});
  const filters = normalizeFilters(data,{categories:['A'],markedOnly:true});
  const ids = visibleWords(data,filters,state).map(word=>word.id);
  clearWordField(state,ids,'marked',2);
  assert.equal(visibleWords(data,filters,state).length,0);
  assert.equal(state.words.w1.seen.value,true); assert.equal(state.words.w2.marked.value,true);
});
test('單字 ID 與物件內建名稱相同仍能安全合併',()=>{
  const result = cleanState(JSON.parse('{"schemaVersion":1,"words":{"constructor":{"seen":{"value":true,"at":1}}}}'));
  assert.equal(result.words.constructor.seen.value,true);
  assert.equal(Object.prototype.seen,undefined);
});
test('英文詞表使用自訂欄位，不需要日文讀音或字幕時間',()=>{
  const english = {...data, columns:[
    {key:'marked',label:'待複習',type:'checkbox'},
    {key:'term',label:'英文單字',type:'text'},
    {key:'seen',label:'已讀',type:'checkbox'},
    {key:'ipa',label:'音標',type:'text'},
    {key:'example',label:'英文例句',type:'text'}
  ],filters:{categories:[],periods:[]},words:[{id:'apple',term:'apple',ipa:'/ˈæpəl/',example:'A delicious fruit.'}]};
  assert.doesNotThrow(()=>validateDataset(english));
  const filters = normalizeFilters(english,{search:'delicious'});
  assert.equal(visibleWords(english,filters,cleanState(null)).length,1);
  filters.search='æpəl'; assert.equal(visibleWords(english,filters,cleanState(null)).length,1);
  assert.deepEqual(english.columns.map(column=>column.label),['待複習','英文單字','已讀','音標','英文例句']);
});
test('欄位設定拒絕重複 key、不支援類型、缺值與公開進度',()=>{
  assert.throws(()=>validateDataset({...data,columns:[...columns,columns[0]]}));
  assert.throws(()=>validateDataset({...data,columns:[...columns,{key:'html',label:'HTML',type:'html'}]}));
  assert.throws(()=>validateDataset({...data,columns:[...columns,{key:'example',label:'例句',type:'text'}]}));
  assert.throws(()=>validateDataset({...data,words:[{...data.words[0],seen:true}]}));
  assert.throws(()=>validateDataset({...data,columns:columns.filter(column=>column.key!=='seen')}));
});
