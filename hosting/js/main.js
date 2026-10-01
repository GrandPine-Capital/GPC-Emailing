/* Boot: Google sign-in, admin check, then start the dashboard. */
import { auth, authApi, db, fs, isEmulator } from './firebase.js';
import { handle } from './backend.js';

const $ = (id) => document.getElementById(id);
App.setBackend(handle);
let started = false;

function showSignin(message, { denied = false } = {}) {
  $('layout').style.display = 'none';
  $('signin').style.display = '';
  $('signin-msg').textContent = message;
  $('google-signin').style.display = denied ? 'none' : '';
  $('emu-signin').style.display = isEmulator && !denied ? '' : 'none';
  $('signout-denied').style.display = denied ? '' : 'none';
}

$('google-signin').onclick = async () => {
  try {
    await authApi.signInWithPopup(auth, new authApi.GoogleAuthProvider());
  } catch (e) {
    showSignin(`Sign-in failed: ${e.message}`);
  }
};
$('emu-signin').onsubmit = async (e) => {
  e.preventDefault();
  // The Auth emulator accepts unsigned Google credentials, giving a verified Google user.
  const email = $('emu-email').value.trim().toLowerCase();
  const token = JSON.stringify({ sub: `emu-${email}`, email, email_verified: true });
  await authApi.signInWithCredential(auth, authApi.GoogleAuthProvider.credential(token));
};
const signOut = () => authApi.signOut(auth);
$('signout').onclick = signOut;
$('signout-denied').onclick = signOut;

authApi.onAuthStateChanged(auth, async (user) => {
  if (!user) return showSignin('Sign in with your Google account to continue.');
  const email = String(user.email || '').toLowerCase();
  let admin = false;
  try {
    admin = (await fs.getDoc(fs.doc(db, `admins/${email}`))).exists();
  } catch {
    admin = false;
  }
  if (!admin) {
    return showSignin(`${email} is not an admin of this portal. The project owner can add you by running addAdmin("${email}") in Apps Script, or by creating the document admins/${email} in Firestore.`, { denied: true });
  }
  $('signin').style.display = 'none';
  $('layout').style.display = '';
  $('user-email').textContent = email;
  if (!started) {
    started = true;
    App.start();
  } else App.navigate();
});
