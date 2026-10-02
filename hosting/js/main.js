/* Boot: sign-in (Google or email link), access check, then start the dashboard. */
import { auth, authApi, db, fs, isEmulator } from './firebase.js';
import { handle } from './backend.js';

const $ = (id) => document.getElementById(id);
const LINK_KEY = 'emailing.signin.email';
App.setBackend(handle);
let started = false;

function showSignin(message, { denied = false } = {}) {
  $('layout').style.display = 'none';
  $('signin').style.display = '';
  $('signin-msg').textContent = message;
  $('signin-actions').style.display = denied ? 'none' : '';
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

// Passwordless sign-in for addresses that are not Google accounts.
$('link-signin').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('link-email').value.trim().toLowerCase();
  try {
    await authApi.sendSignInLinkToEmail(auth, email, { url: `${location.origin}/`, handleCodeInApp: true });
    try { localStorage.setItem(LINK_KEY, email); } catch { /* private mode */ }
    showSignin(`We sent a sign-in link to ${email}. Open it on this device to continue.`);
  } catch (err) {
    showSignin(`Could not send the link: ${err.message}. (An admin must enable Email link sign-in in Firebase Authentication.)`);
  }
};

async function completeLinkSignin() {
  if (!authApi.isSignInWithEmailLink(auth, location.href)) return;
  let email = '';
  try { email = localStorage.getItem(LINK_KEY) || ''; } catch { /* ignore */ }
  if (!email) email = (prompt('Confirm the email address you signed in with') || '').trim().toLowerCase();
  if (!email) return;
  try {
    await authApi.signInWithEmailLink(auth, email, location.href);
    try { localStorage.removeItem(LINK_KEY); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname + '#/dashboard');
  } catch (err) {
    showSignin(`That sign-in link is invalid or expired: ${err.message}`);
  }
}
completeLinkSignin();

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

const initials = (email) => String(email || '?').split('@')[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const ROLE_LABEL = { owner: 'Owner · Connected', admin: 'Admin · Connected', member: 'Member · Connected' };

authApi.onAuthStateChanged(auth, async (user) => {
  if (!user) return showSignin('Sign in to continue.');
  const email = String(user.email || '').toLowerCase();
  let profile = null;
  try {
    const snap = await fs.getDoc(fs.doc(db, `admins/${email}`));
    profile = snap.exists() ? snap.data() : null;
  } catch {
    profile = null;
  }
  if (!profile) {
    return showSignin(`${email} doesn't have access to this portal yet. Ask an admin to add you in Settings → Team & access.`, { denied: true });
  }
  App.me.email = email;
  App.me.role = profile.role || 'owner';
  $('signin').style.display = 'none';
  $('layout').style.display = '';
  $('user-email').textContent = email;
  $('user-initials').textContent = initials(email);
  $('user-role').textContent = ROLE_LABEL[App.me.role] || 'Connected';
  if (!started) {
    started = true;
    App.start();
  } else App.navigate();
});
