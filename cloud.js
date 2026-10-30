import { mergeStates } from './core.js';
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
