/*
 * Firebase initialisation. The config is served by Firebase Hosting at
 * /__/firebase/init.json, so nothing needs to be pasted into the code.
 * On localhost the app talks to the Firebase emulators.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, connectAuthEmulator,
  signInWithCredential, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  addDoc, query, where, orderBy, limit, startAfter, writeBatch, increment, arrayUnion, arrayRemove,
  getCountFromServer, documentId, deleteField,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const config = await fetch('/__/firebase/init.json').then((r) => {
  if (!r.ok) throw new Error('Firebase config not found - deploy with `firebase deploy` or run `firebase emulators:start`.');
  return r.json();
});

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
export const isEmulator = local;
if (local) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
}

export const fs = {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, query, where, orderBy, limit, startAfter,
  writeBatch, increment, arrayUnion, arrayRemove, getCountFromServer, documentId, deleteField,
};
export const authApi = {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, signInWithCredential,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
};
