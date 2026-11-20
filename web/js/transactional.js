/* Transactional e-mails: what other systems (GPC-Payment) ask us to send to one person —
   receipts, bank-transfer instructions, refund notices. Which ones are on, the template each
   uses, the sender, and everything sent, with resend. */
(() => {
  const { api, esc, toast, fmtDate, icon, cardHead, fieldLabel } = App;

  const statusBadge = (r) => {
    const s = r.dry_run && r.status === 'sent' ? 'dry run' : r.status;
    const color = { sent: 'green', queued: 'blue', failed: 'red', bounced: 'red', complained: 'red', skipped: '', 'dry run': 'yellow' }[s] ?? '';
    return `<span class="badge ${color}" title="${esc(r.error || '')}">${esc(s)}</span>`;
  };

  App.route(/^#\/transactional(?:\?(.*))?$/, async (root, qs) => {
    const params = new URLSearchParams(qs || '');
    const q = params.get('q') || '';
    const [cfg, templates, sent] = await Promise.all([
      api.get('/transactional/config'), api.get('/templates'), api.get(`/transactional?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    ]);
    const admin = App.isAdmin();
    const canWrite = App.me.role !== 'viewer';
    const label = Object.fromEntries(cfg.events.map((e) => [e.event, e.label]));
    const eventOf = (r) => label[(r.source_key || '').split(':')[0]] || r.template_key;
    // Transactional templates first, then the rest.
    const sorted = [...templates].sort((a, b) => (b.category === 'transactional') - (a.category === 'transactional') || a.name.localeCompare(b.name));
    const dis = admin ? '' : 'disabled';

    root.innerHTML = `
      ${App.pageHead({
        title: 'Transactional emails',
        subtitle: 'Emails other systems send to one person about their order: receipts, bank-transfer instructions, refunds. They go even to people who unsubscribed from marketing, and are not tracked.',
        actions: admin ? `<button class="btn primary lg" id="save">${icon('check', 17)}Save</button>` : `<span class="badge yellow lg">Read-only (${esc(App.me.role)})</span>`,
      })}
      ${cfg.payment_hook ? '' : '<div class="banner warn">Payment events are not connected on this server (PAYMENT_EVENT_SECRET), so nothing here is sent yet.</div>'}
      <form id="txn" data-nosubmit autocomplete="off">
      <div class="grid cols-2" style="margin-bottom:24px">
        <section class="card">
          ${cardHead({ icon: 'mail', title: 'Sender', sub: 'Who these emails come from' })}
          <div class="field">${fieldLabel('From address', '<span class="aside chip-hint">empty = server default</span>')}
            <input type="email" name="from_email" value="${esc(cfg.from_email)}" placeholder="${esc(cfg.default_from_email || cfg.effective_from_email)}" ${dis}>
            <div class="hint">Any address on a verified SES identity (Settings → Sender identities). Now sending as <b>${esc(cfg.effective_from_email)}</b>.
              ${cfg.no_reply ? 'A no-reply address carries no reply address, so customers cannot reply.' : 'Replies come back through the reply domain and are forwarded to this mailbox.'}</div></div>
          <div class="field" style="margin-bottom:0">${fieldLabel('From name', '<span class="aside chip-hint">empty = server default</span>')}
            <input type="text" name="from_name" value="${esc(cfg.from_name)}" placeholder="${esc(cfg.effective_from_name || 'GrandPine Capital')}" ${dis}></div>
        </section>
        <section class="card">
          ${cardHead({ icon: 'info', tone: 'gray', title: 'How it works', sub: 'From GPC-Payment to the customer' })}
          <p class="muted" style="margin-top:0">When an order changes in GPC-Payment, it tells Emailing, and the email below goes to the buyer's address straight away. Each email goes once per order; a failed send is retried for a few hours. Edit the wording in <a href="#/templates">Templates</a> — merge tags such as <code>{{item}}</code>, <code>{{amount}}</code>, <code>{{receipt_url}}</code> are listed in each template's starter text.</p>
        </section>
      </div>
      <h2>Emails</h2>
      <div class="stack" style="margin-bottom:24px">
        ${cfg.events.map((e) => `<div class="card" style="padding:18px 20px" data-event="${esc(e.event)}">
          <div class="list-row" style="padding:0;flex-wrap:wrap;gap:12px">
            <div class="icon-tile ${e.enabled ? 'green' : 'gray'}">${icon('send', 20)}</div>
            <div class="grow" style="min-width:220px"><b>${esc(e.label)}</b>
              <div class="muted" style="font-size:13.5px">${esc(e.description)}</div></div>
            <label class="check"><input type="checkbox" data-k="enabled" ${e.enabled ? 'checked' : ''} ${dis}> On</label>
          </div>
          <div class="row" style="margin-top:12px;gap:10px;flex-wrap:wrap;align-items:center">
            <span class="muted" style="font-size:13px">Template</span>
            <select data-k="template_id" style="max-width:340px" ${dis}>
              ${sorted.map((t) => `<option value="${esc(t.id)}" ${t.id === e.template_id ? 'selected' : ''}>${esc(t.name)}${t.id === e.default_template_id ? ' (default)' : ''}</option>`).join('')}
            </select>
            <a class="btn sm" data-edit href="#/templates/${esc(e.template_id)}">${icon('edit', 15)}Edit template</a>
          </div>
        </div>`).join('')}
      </div>
      </form>
      <div class="card">
        ${cardHead({ icon: 'mail-open', tone: 'gray', title: 'Sent', sub: 'The latest 100; search by order number or email address' })}
        <form id="find" class="row" style="gap:8px;margin-bottom:16px;flex-wrap:nowrap" data-nosubmit>
          <input type="search" name="q" value="${esc(q)}" placeholder="Order number or email" style="flex:1;min-width:0;max-width:360px">
          <button class="btn">${icon('search', 15)}Find</button></form>
        ${sent.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Sent</th><th>To</th><th>Email</th><th class="hide-sm">Order</th><th>Status</th><th></th></tr></thead><tbody>
          ${sent.map((r) => `<tr><td class="nowrap">${fmtDate(r.sent_at || r.created_at)}</td><td>${esc(r.to_name ? `${r.to_name} <${r.to_email}>` : r.to_email)}</td>
            <td>${esc(eventOf(r))}<div class="muted" style="font-size:12px">${esc(r.subject || '')}</div></td>
            <td class="hide-sm mono" style="font-size:12.5px">${esc(r.reference)}</td>
            <td>${statusBadge(r)}${r.error && r.status !== 'sent' ? `<div class="muted" style="font-size:12px">${esc(r.error)}</div>` : ''}</td>
            <td class="nowrap">${canWrite ? `<button class="btn sm" data-resend="${esc(r.id)}">${icon('refresh', 14)}Resend</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : `<p class="muted">${q ? 'Nothing matches.' : 'Nothing sent yet.'}</p>`}
      </div>`;

    // "Edit template" follows the selection.
    root.querySelectorAll('[data-event]').forEach((card) => {
      const sel = card.querySelector('[data-k="template_id"]');
      sel.onchange = () => { card.querySelector('[data-edit]').href = `#/templates/${sel.value}`; };
    });
    root.querySelector('#find').onsubmit = (ev) => {
      ev.preventDefault();
      const v = new FormData(ev.target).get('q').trim();
      location.hash = v ? `#/transactional?q=${encodeURIComponent(v)}` : '#/transactional';
    };
    root.querySelectorAll('[data-resend]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api.post(`/transactional/${b.dataset.resend}/resend`);
        toast(r.status === 'sent' ? 'Sent again.' : `Queued (${r.status}).`);
        App.navigate();
      } catch { b.disabled = false; }
    }));
    const save = root.querySelector('#save');
    if (save) save.onclick = async () => {
      const form = root.querySelector('#txn');
      const events = {};
      form.querySelectorAll('[data-event]').forEach((card) => {
        events[card.dataset.event] = {
          enabled: card.querySelector('[data-k="enabled"]').checked,
          template_id: card.querySelector('[data-k="template_id"]').value,
        };
      });
      save.disabled = true;
      try {
        await api.put('/transactional/config', { from_email: form.from_email.value.trim(), from_name: form.from_name.value.trim(), events });
        toast('Saved.');
        App.navigate();
      } catch { save.disabled = false; }
    };
  });
})();
