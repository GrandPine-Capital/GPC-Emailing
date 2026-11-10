/*
 * Staff single sign-on through the GrandPine staff realm (Keycloak), as in the CRM, Helpdesk
 * and the other staff apps; access (admin, editor, viewer) is granted in the IAM Workspace.
 *
 * The app runs the authorization-code + PKCE redirect to the realm; the realm sends the browser
 * back to /auth/callback with a code, which the server exchanges (only it holds the client
 * secret). The access token (five minutes) goes with every API call and is renewed with the
 * refresh token; both live in sessionStorage, so a session ends with the tab.
 *
 * Locally (AUTH_MODE=dev on the server) a "dev:<uid>:<admin|editor|viewer>" token stands in.
 */
const SESSION_KEY = 'gpc.emailing.sso';
const PENDING_KEY = 'gpc.emailing.sso.pending';
const FAILED_KEY = 'gpc.emailing.sso.failed';
export const CALLBACK_PATH = '/auth/callback';
const SIGNED_OUT = 'signedout';

function store(key, v) {
  try {
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(v));
  } catch { /* storage unavailable: the session lasts until the page is reloaded */ }
}
function load(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let config = null;
export function signInConfig() {
  config ??= fetch('/api/public/sign-in')
    .then(async (r) => {
      const cfg = await r.json().catch(() => null);
      if (!r.ok || !cfg) throw new Error('Sign-in is not set up on this server.');
      return cfg;
    })
    .catch((e) => {
      config = null;
      throw e.message ? e : new Error('Could not reach the server. Check your connection and try again.');
    });
  return config;
}

let session = load(SESSION_KEY);
let signedOutHandler = () => {};
export function onSignedOut(cb) {
  if (typeof cb === 'function') signedOutHandler = cb;
  else signedOutHandler();
}
function setSession(s) {
  session = s;
  store(SESSION_KEY, s);
}
export const hasSession = () => session !== null;

/** Whether the sign-in page may redirect to the realm by itself (not after a failure or sign-out). */
export function mayAutoSignIn() {
  const failed = load(FAILED_KEY);
  store(FAILED_KEY, null);
  const url = new URL(location.href);
  const signedOut = url.searchParams.has(SIGNED_OUT);
  if (signedOut) {
    url.searchParams.delete(SIGNED_OUT);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return !failed && !signedOut;
}
export const markSignInFailed = () => store(FAILED_KEY, true);

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Sends the browser to the staff realm's sign-in page, then back to the same page. */
export async function startSignIn() {
  const cfg = await signInConfig();
  if (cfg.mode !== 'keycloak') throw new Error('Single sign-on is not set up on this server.');
  const verifier = randomString();
  const state = randomString();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const returnTo = location.pathname.startsWith(CALLBACK_PATH) ? '/' : location.pathname + location.search + location.hash;
  store(PENDING_KEY, { verifier, state, returnTo });
  const url = new URL(`${cfg.issuer}/protocol/openid-connect/auth`);
  url.search = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: location.origin + CALLBACK_PATH, response_type: 'code', scope: 'openid',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  location.assign(url.toString());
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `The server answered HTTP ${res.status}.`), { status: res.status });
  return data;
}

function keep(t, idToken) {
  // Renew a little early, so a request in flight never carries a token that lapses on the way.
  setSession({ accessToken: t.accessToken, refreshToken: t.refreshToken, idToken: t.idToken || idToken, renewAt: Date.now() + Math.max(10, (t.expiresIn || 300) - 30) * 1000 });
}

/** Finishes the sign-in on /auth/callback; returns the page to go back to. */
export async function completeSignIn() {
  const params = new URLSearchParams(location.search);
  const pending = load(PENDING_KEY);
  store(PENDING_KEY, null);
  if (params.get('error')) throw new Error(params.get('error_description') || 'The sign-in was cancelled.');
  const code = params.get('code');
  if (!code || !pending || params.get('state') !== pending.state) throw new Error('This sign-in link has expired or was opened in another tab. Please sign in again.');
  keep(await post('/api/public/sign-in/code', { code, codeVerifier: pending.verifier, redirectUri: location.origin + CALLBACK_PATH }));
  return pending.returnTo || '/';
}

let renewing = null;
/** The access token to send, renewed first when it is about to lapse; null when signed out. */
export async function accessToken() {
  if (!session) return null;
  if (Date.now() < session.renewAt) return session.accessToken;
  renewing ??= (async () => {
    const current = session;
    try {
      keep(await post('/api/public/sign-in/refresh', { refreshToken: current.refreshToken }), current.idToken);
      return session.accessToken;
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        setSession(null);
        return null;
      }
      throw e;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

export function useDevToken(token) {
  setSession({ accessToken: token.trim(), refreshToken: '', renewAt: Number.MAX_SAFE_INTEGER });
}

export const clearSession = () => setSession(null);

/** Ends the app session and the realm session. */
export async function signOut() {
  const idToken = session && session.idToken;
  setSession(null);
  const cfg = await signInConfig().catch(() => null);
  if (!cfg || cfg.mode !== 'keycloak' || !idToken) {
    location.assign(`/?${SIGNED_OUT}=1`);
    return;
  }
  const url = new URL(`${cfg.issuer}/protocol/openid-connect/logout`);
  url.search = new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: `${location.origin}/?${SIGNED_OUT}=1` }).toString();
  location.assign(url.toString());
}
