/*
 * Boot: staff single sign-on through the GrandPine staff realm, then the dashboard. The sign-in
 * page is the Helpdesk's (and the CRM's): it goes straight on to GrandPine SSO, and waits for a
 * click only after a failed attempt, after signing out, or when the person has no Emailing role.
 */
import * as session from './session.js';
import { handle } from './backend.js';

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
App.setBackend(handle);

/** state: 'auto' (redirecting), 'button' (waits for a click), 'noaccess', 'dev'. */
function showSignin(state, error = '') {
  document.title = 'Sign in — GrandPine Emailing';
  $('layout').style.display = 'none';
  $('signin').style.display = '';
  const auto = state === 'auto';
  show('sso-noaccess', state === 'noaccess');
  show('sso-workspace', state === 'noaccess');
  show('sso-signin', state === 'auto' || state === 'button');
  show('sso-status', auto && !error);
  show('sso-spinner', auto && !error);
  $('sso-signin').disabled = auto && !error;
  show('dev-signin', state === 'dev');
  $('sso-error').textContent = error;
  show('sso-error', !!error);
}

async function signIn() {
  showSignin('auto');
  try {
    await session.startSignIn();
  } catch (e) {
    showSignin('button', e.message || 'Could not start the sign-in.');
  }
}

$('sso-signin').onclick = signIn;
$('dev-signin').onsubmit = (e) => {
  e.preventDefault();
  session.useDevToken($('dev-token').value);
  boot();
};
$('signout').onclick = () => session.signOut();
session.onSignedOut(() => {
  session.clearSession();
  showSignin('button', 'Your session has ended. Please sign in again.');
});

const initials = (s) => String(s || '?').split('@')[0].split(/[._\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const ROLE_LABEL = { admin: 'Admin', member: 'Editor', viewer: 'Viewer · read-only' };
let started = false;

async function boot() {
  let devMode = false;
  if (location.pathname.startsWith(session.CALLBACK_PATH)) {
    try {
      const back = await session.completeSignIn();
      history.replaceState(null, '', back.startsWith('/') ? back : '/');
    } catch (e) {
      session.markSignInFailed();
      history.replaceState(null, '', '/');
      return showSignin(e.status === 403 ? 'noaccess' : 'button', e.status === 403 ? '' : e.message);
    }
  }
  if (!session.hasSession()) {
    let cfg;
    try {
      cfg = await session.signInConfig();
    } catch (e) {
      return showSignin('button', e.message);
    }
    if (cfg.mode === 'dev') return showSignin('dev');
    if (session.mayAutoSignIn()) return signIn();
    return showSignin('button');
  }
  try {
    devMode = (await session.signInConfig()).mode === 'dev';
  } catch { /* keep the Workspace link */ }
  let me;
  try {
    me = await handle('GET', '/me');
  } catch (e) {
    if (e.status === 403) {
      session.clearSession();
      return showSignin('noaccess');
    }
    if (e.status === 401) return showSignin('button', 'Your session has ended. Please sign in again.');
    return showSignin('button', e.message);
  }
  App.me.email = me.email;
  App.me.role = me.role;
  document.title = 'GrandPine Capital Emailing';
  $('signin').style.display = 'none';
  $('layout').style.display = '';
  $('user-email').textContent = me.name || me.email;
  $('user-initials').textContent = initials(me.name || me.email);
  $('user-role').textContent = ROLE_LABEL[me.role] || 'Connected';
  // Staff sign out in the Workspace; only a local dev session has its own Sign out.
  show('workspace-link', !devMode);
  show('signout', devMode);
  if (!started) {
    started = true;
    App.start();
  } else App.navigate();
}

boot();
