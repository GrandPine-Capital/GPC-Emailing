/* Boot: staff single sign-on (GrandPine staff realm), then start the dashboard. */
import * as session from './session.js';
import { handle } from './backend.js';

const $ = (id) => document.getElementById(id);
App.setBackend(handle);

function showSignin(message, { button = true, dev = false } = {}) {
  $('layout').style.display = 'none';
  $('signin').style.display = '';
  $('signin-msg').textContent = message;
  $('sso-signin').style.display = button && !dev ? '' : 'none';
  $('dev-signin').style.display = dev ? '' : 'none';
}

$('sso-signin').onclick = () => session.startSignIn().catch((e) => showSignin(e.message));
$('dev-signin').onsubmit = (e) => {
  e.preventDefault();
  session.useDevToken($('dev-token').value);
  boot();
};
$('signout').onclick = () => session.signOut();
session.onSignedOut(() => {
  session.clearSession();
  showSignin('Your session has ended. Please sign in again.');
});

const initials = (s) => String(s || '?').split('@')[0].split(/[._\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const ROLE_LABEL = { admin: 'Admin · Connected', member: 'Member · Connected', viewer: 'Viewer · Read-only' };
let started = false;

async function boot() {
  if (location.pathname.startsWith(session.CALLBACK_PATH)) {
    try {
      const back = await session.completeSignIn();
      history.replaceState(null, '', back.startsWith('/') ? back : '/');
    } catch (e) {
      session.markSignInFailed();
      history.replaceState(null, '', '/');
      return showSignin(e.message);
    }
  }
  if (!session.hasSession()) {
    let cfg;
    try {
      cfg = await session.signInConfig();
    } catch (e) {
      return showSignin(e.message, { button: false });
    }
    if (cfg.mode === 'dev') return showSignin('Development mode: sign in with a dev token.', { dev: true });
    if (session.mayAutoSignIn()) {
      showSignin('Signing you in…', { button: false });
      return session.startSignIn().catch((e) => showSignin(e.message));
    }
    return showSignin('You are signed out.');
  }
  let me;
  try {
    me = await handle('GET', '/me');
  } catch (e) {
    if (e.status === 403) {
      session.clearSession();
      return showSignin(e.message, { button: true });
    }
    if (e.status === 401) return showSignin('Your session has ended. Please sign in again.');
    return showSignin(e.message);
  }
  App.me.email = me.email;
  App.me.role = me.role;
  $('signin').style.display = 'none';
  $('layout').style.display = '';
  $('user-email').textContent = me.email || me.name;
  $('user-initials').textContent = initials(me.name || me.email);
  $('user-role').textContent = ROLE_LABEL[me.role] || 'Connected';
  if (!started) {
    started = true;
    App.start();
  } else App.navigate();
}

boot();
