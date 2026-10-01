/* Core front-end helpers: API client, router, toasts, modals, formatting. */
const App = (() => {
  const view = () => document.getElementById('view');
  const routes = [];
  let meta = null;
  let cleanup = null;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      toast(err.message, 'error');
      throw err;
    }
    return data;
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
    const section = hash.split('/')[1];
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
    for (const r of routes) {
      const m = hash.match(r.pattern);
      if (m) {
        view().innerHTML = '<div class="empty">Loading…</div>';
        try {
          cleanup = (await r.render(view(), ...m.slice(1))) || null;
        } catch (err) {
          console.error(err);
          view().innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div>`;
        }
        window.scrollTo(0, 0);
        return;
      }
    }
    location.hash = '#/dashboard';
  }

  function start() {
    window.addEventListener('hashchange', navigate);
    navigate();
  }

  const debounce = (fn, ms = 300) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  return { api, esc, toast, modal, confirmDialog, formData, fmtDate, statusBadge, chips, chipValues, getMeta, route, start, navigate, debounce };
})();
