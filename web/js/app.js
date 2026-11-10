/* Core front-end helpers: API client, router, toasts, modals, formatting. */
const App = (() => {
  const view = () => document.getElementById('view');
  const routes = [];
  let meta = null;
  let cleanup = null;
  let navToken = 0;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let backend = null;
  async function api(method, path, body) {
    try {
      return await backend(method, path, body);
    } catch (err) {
      console.error(err);
      toast(friendlyError(err), 'error');
      throw err;
    }
  }
  function friendlyError(err) {
    const msg = String(err && err.message || err);
    return msg;
  }
  api.get = (p) => api('GET', p);
  api.post = (p, b) => api('POST', p, b ?? {});
  api.put = (p, b) => api('PUT', p, b);
  api.del = (p) => api('DELETE', p);

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  /** Open a modal; returns { el, close }. `onMount(el, close)` wires up events. */
  function modal(html, { wide = false, onMount } = {}) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
    const close = () => bg.remove();
    bg.addEventListener('mousedown', (e) => e.target === bg && close());
    bg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.body.appendChild(bg);
    onMount?.(bg.querySelector('.modal'), close);
    bg.querySelector('input, select, textarea')?.focus();
    return { el: bg.querySelector('.modal'), close };
  }

  function confirmDialog(message, { okText = 'Delete', danger = true } = {}) {
    return new Promise((resolve) => {
      modal(`<h2>Please confirm</h2><p>${esc(message)}</p><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="ok">${esc(okText)}</button></div>`, {
        onMount: (el, close) => {
          el.querySelector('#ok').onclick = () => { close(); resolve(true); };
          el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
        },
      });
    });
  }

  /** Read named form controls into an object (checkbox groups become arrays). */
  function formData(root) {
    const out = {};
    root.querySelectorAll('[name]').forEach((el) => {
      if (el.type === 'checkbox') {
        if (el.dataset.group !== undefined) {
          out[el.name] = out[el.name] || [];
          if (el.checked) out[el.name].push(el.value);
        } else out[el.name] = el.checked;
      } else if (el.type === 'radio') {
        if (el.checked) out[el.name] = el.value;
      } else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
      else out[el.name] = el.value;
    });
    return out;
  }

  const fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };

  const statusBadge = (s) => {
    const color = { sent: 'green', active: 'green', subscribed: 'green', completed: 'green', done: 'green', sending: 'blue', running: 'blue', scheduled: 'yellow', paused: 'yellow', draft: '', stopped: '', unsubscribed: 'red', failed: 'red', bounced: 'red', queued: 'blue', skipped: '' }[s] ?? '';
    return `<span class="badge ${color}">${esc(s)}</span>`;
  };

  /** Clickable chip multi-select. */
  function chips(name, options, selected = []) {
    const set = new Set(selected.map(String));
    return `<div class="chips" data-chips="${esc(name)}">${options
      .map((o) => {
        const value = typeof o === 'object' ? o.value : o;
        const label = typeof o === 'object' ? o.label : o;
        return `<span class="chip ${set.has(String(value)) ? 'on' : ''}" data-value="${esc(value)}">${esc(label)}</span>`;
      })
      .join('')}</div>`;
  }
  const chipValues = (root, name) => [...root.querySelectorAll(`[data-chips="${name}"] .chip.on`)].map((c) => c.dataset.value);
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chips .chip');
    if (chip) {
      chip.classList.toggle('on');
      chip.closest('.chips').dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  async function getMeta(force = false) {
    if (!meta || force) meta = await api.get('/meta');
    return meta;
  }

  function route(pattern, render) {
    routes.push({ pattern, render });
  }

  async function navigate() {
    const hash = location.hash || '#/dashboard';
    if (cleanup) {
      try { cleanup(); } catch { /* ignore */ }
      cleanup = null;
    }
    const section = (hash.split('/')[1] || '').split('?')[0];
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
    const navLink = document.querySelector(`#nav a[data-nav="${section}"]`);
    const tb = document.getElementById('tb-title');
    if (tb && navLink) tb.textContent = navLink.textContent.trim();
    closeDrawer();
    const token = ++navToken;
    for (const r of routes) {
      const m = hash.match(r.pattern);
      if (m) {
        // Each navigation renders into its own container, so a slow page that
        // finishes after the user moved on writes into a detached element.
        const container = document.createElement('div');
        container.innerHTML = '<div class="empty">Loading…</div>';
        view().replaceChildren(container);
        try {
          const done = (await r.render(container, ...m.slice(1))) || null;
          if (token === navToken) cleanup = done;
          else if (done) done();
        } catch (err) {
          console.error(err);
          if (token === navToken) container.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div>`;
        }
        if (token === navToken) window.scrollTo(0, 0);
        return;
      }
    }
    location.hash = '#/dashboard';
  }

  function start() {
    window.addEventListener('hashchange', navigate);
    navigate();
  }

  function openDrawer() {
    document.body.classList.add('drawer-open');
    document.getElementById('hamburger')?.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    document.body.classList.remove('drawer-open');
    document.getElementById('hamburger')?.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('#hamburger')) openDrawer();
    else if (e.target.closest('#scrim') || e.target.closest('#nav a')) closeDrawer();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  // Forms that save through the API never submit the page (no inline handlers: see the CSP).
  document.addEventListener('submit', (e) => { if (e.target.matches('form[data-nosubmit]')) e.preventDefault(); });

  const icon = (name, size) => window.Icons.svg(name, size);

  /**
   * Standard page header: title (+ badge), subtitle, optional back link, actions (HTML).
   */
  function pageHead({ title, badge = '', subtitle = '', back = null, actions = '' }) {
    return `<div class="page-head"><div style="min-width:0">
      ${back ? `<a class="back" href="${back.href}">${icon('chevron-left', 16)}${esc(back.label)}</a>` : ''}
      <div class="title-row"><h1>${title}</h1>${badge}</div>
      ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
    </div><div class="actions">${actions}</div></div>`;
  }

  /** Card with the icon-tile header used across the app. */
  function cardHead({ icon: ic, tone = '', title, sub = '', aside = '' }) {
    return `<div class="card-head"><div class="icon-tile ${tone}">${icon(ic, 20)}</div>
      <div class="ttl"><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${aside}</div>`;
  }

  /** Uppercase field label with an optional right-hand hint (as in the design). */
  function fieldLabel(label, aside = '', forId = '') {
    return `<div class="field-label"><label ${forId ? `for="${forId}"` : ''}>${label}</label>${aside ? `<span class="aside">${aside}</span>` : ''}</div>`;
  }

  const debounce = (fn, ms = 300) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  const setBackend = (fn) => { backend = fn; };

  /** Which From addresses SES allows: any address at a verified domain, or a verified address. */
  function sendersHint(settings) {
    const ok = (settings.senders || []).filter((x) => x.verified);
    if (!ok.length) return 'Verified SES senders: none loaded yet (Settings → Sender identities).';
    return `Allowed: ${ok.map((x) => (x.type === 'domain' ? `any address @${esc(x.email)}` : esc(x.email))).join(', ')}.`;
  }

  const me = { email: '', role: 'member' };
  const isAdmin = () => me.role === 'owner' || me.role === 'admin';

  return { api, setBackend, me, isAdmin, sendersHint, icon, pageHead, cardHead, fieldLabel, openDrawer, closeDrawer, esc, toast, modal, confirmDialog, formData, fmtDate, statusBadge, chips, chipValues, getMeta, route, start, navigate, debounce };
})();
