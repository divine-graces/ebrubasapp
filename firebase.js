// firebase.js: the only place Firebase is initialised.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// >>> PASTE YOUR firebaseConfig HERE (Firebase console > Project settings > Your apps > Web app) <<<
export const firebaseConfig = {
  apiKey: "AIzaSyBOAN8EdibgHy4yKVW1cS3GlJeblrMFQ9M",
  authDomain: "ebrubasapp.firebaseapp.com",
  projectId: "ebrubasapp",
  storageBucket: "ebrubasapp.firebasestorage.app",
  messagingSenderId: "346920672295",
  appId: "1:346920672295:web:8d04548a18285fe4058202"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Offline cache: reads work without a connection, writes queue up and sync later.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
