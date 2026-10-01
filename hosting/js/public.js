/* Helpers for the public pages (click redirect, unsubscribe): tiny Firestore REST client, no SDK. */
window.PublicFS = (() => {
  let basePromise = null;
  function base() {
    if (!basePromise) {
      basePromise = fetch('/__/firebase/init.json').then((r) => r.json()).then((cfg) => {
        const local = ['localhost', '127.0.0.1'].includes(location.hostname);
        const host = local ? `http://${location.hostname}:8080` : 'https://firestore.googleapis.com';
        return { url: `${host}/v1/projects/${cfg.projectId}/databases/(default)/documents`, key: cfg.apiKey };
      });
    }
    return basePromise;
  }
  const isToken = (t) => /^[a-f0-9]{24}$/.test(t || '');
  const params = new URLSearchParams(location.search);

  async function get(path) {
    const b = await base();
    const res = await fetch(`${b.url}/${path}?key=${b.key}`);
    if (!res.ok) return null;
    const doc = await res.json();
    return Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, v.stringValue ?? v.integerValue ?? v.booleanValue ?? null]));
  }

  async function create(collection, data) {
    const b = await base();
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { stringValue: String(v) }]));
    const res = await fetch(`${b.url}/${collection}?key=${b.key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields }), keepalive: true,
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
  }

  return { get, create, isToken, params };
})();
