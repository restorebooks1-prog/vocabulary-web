import { mergeStates } from './core.js';
import {prepareImports, publicDataset} from './transfer.js';
export async function connectCloud(config, onUser) {
  const base = 'https://www.gstatic.com/firebasejs/12.19.0/';
  const [appSDK, authSDK, dbSDK] = await Promise.all([
    import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')
  ]);
  const app = appSDK.initializeApp(config.firebase), auth = authSDK.getAuth(app), db = dbSDK.getFirestore(app);
  authSDK.onAuthStateChanged(auth, user => onUser(user));
  function reference(id) {
    if (!auth.currentUser || auth.currentUser.uid !== config.ownerUid) throw new Error('此帳號沒有同步權限');
    return dbSDK.doc(db, 'users', config.ownerUid, 'lists', id);
  }
  return {
    login: () => authSDK.signInWithPopup(auth, new authSDK.GoogleAuthProvider()),
    logout: () => authSDK.signOut(auth),
    async loadDatasets() {
      if (!auth.currentUser || auth.currentUser.uid !== config.ownerUid) throw new Error('此帳號沒有雲端詞表讀取權限');
      const snapshot = await dbSDK.getDocsFromServer(dbSDK.collection(db, 'publicDatasets'));
      return snapshot.docs.map(document => {
        const record = document.data();
        if (record.schemaVersion !== 1 || typeof record.json !== 'string') throw new Error('雲端詞表格式錯誤');
        const data = publicDataset(JSON.parse(record.json));
        if (data.id !== document.id) throw new Error('雲端詞表 ID 不一致');
        return data;
      });
    },
    async importDatasets(datasets) {
      if (!auth.currentUser || auth.currentUser.uid !== config.ownerUid
        || !auth.currentUser.providerData.some(provider => provider.providerId === 'google.com')) {
        throw new Error('只有指定的 Google 帳號可以匯入詞表');
      }
      const validated = prepareImports(datasets);
      const batch = dbSDK.writeBatch(db);
      for (const data of validated) {
        batch.set(dbSDK.doc(db, 'publicDatasets', data.id), {schemaVersion:1, json:JSON.stringify(data)});
      }
      await batch.commit();
    },
    async deleteDataset(id) {
      if (!auth.currentUser || auth.currentUser.uid !== config.ownerUid
        || !auth.currentUser.providerData.some(provider => provider.providerId === 'google.com')) {
        throw new Error('只有指定的 Google 帳號可以刪除詞表');
      }
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error('詞表 ID 無效');
      const batch = dbSDK.writeBatch(db);
      batch.delete(dbSDK.doc(db, 'publicDatasets', id));
      batch.delete(reference(id));
      await batch.commit();
    },
    async pull(id) { const snapshot = await dbSDK.getDocFromServer(reference(id)); return snapshot.exists() ? snapshot.data() : null; },
    async push(id, state) {
      const ref = reference(id);
      return dbSDK.runTransaction(db, async transaction => {
        const snapshot = await transaction.get(ref);
        const merged = mergeStates(state, snapshot.exists() ? snapshot.data() : null);
        transaction.set(ref, merged); return merged;
      });
    }
  };
}
