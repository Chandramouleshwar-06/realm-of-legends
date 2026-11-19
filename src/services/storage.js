// Character persistence.
// Uses Firebase (anonymous auth + Firestore) when VITE_FIREBASE_* variables are set,
// otherwise falls back to the browser's localStorage so the game runs with no backend.

const env = import.meta.env;
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const usingFirebase = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

const LOCAL_ID_KEY = 'realm-of-legends:player-id';
const localCharacterKey = (userId) => `realm-of-legends:characters:${userId}`;

let firebase = null;
const loadFirebase = async () => {
  if (firebase) return firebase;
  const [{ initializeApp }, auth, firestore] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ]);
  const app = initializeApp(firebaseConfig);
  firebase = { auth, firestore, authInstance: auth.getAuth(app), db: firestore.getFirestore(app) };
  return firebase;
};

const characterPath = (userId) => `artifacts/${firebaseConfig.projectId}/users/${userId}/characters`;

/** Resolves to a stable player id (Firebase anonymous uid, or a local id). */
export async function connect() {
  if (!usingFirebase) {
    let id = null;
    try { id = localStorage.getItem(LOCAL_ID_KEY); } catch { /* storage unavailable */ }
    if (!id) {
      id = `local-${Math.random().toString(36).slice(2, 10)}`;
      try { localStorage.setItem(LOCAL_ID_KEY, id); } catch { /* storage unavailable */ }
    }
    return id;
  }
  const { auth, authInstance } = await loadFirebase();
  const credential = await auth.signInAnonymously(authInstance);
  return credential.user.uid;
}

const readLocal = (userId) => {
  try { return JSON.parse(localStorage.getItem(localCharacterKey(userId))) || {}; } catch { return {}; }
};

export async function loadCharacter(userId) {
  if (!usingFirebase) return readLocal(userId).mainCharacter || null;
  const { firestore, db } = await loadFirebase();
  const snap = await firestore.getDoc(firestore.doc(db, characterPath(userId), 'mainCharacter'));
  return snap.exists() ? snap.data() : null;
}

export async function saveCharacter(userId, character) {
  if (!usingFirebase) {
    const all = readLocal(userId);
    all.mainCharacter = character;
    try { localStorage.setItem(localCharacterKey(userId), JSON.stringify(all)); } catch { /* storage unavailable */ }
    return;
  }
  const { firestore, db } = await loadFirebase();
  await firestore.setDoc(firestore.doc(db, characterPath(userId), 'mainCharacter'), character);
}

export async function listCharacters(userId) {
  if (!usingFirebase) return Object.values(readLocal(userId));
  const { firestore, db } = await loadFirebase();
  const snapshot = await firestore.getDocs(firestore.query(firestore.collection(db, characterPath(userId))));
  return snapshot.docs.map(d => d.data());
}
