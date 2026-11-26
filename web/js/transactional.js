/* Transactional e-mails: what other systems (GPC-Payment, Helpdesk, Keycloak) ask us to send to
   one person — receipts, bank-transfer instructions, refund notices, password-reset and
   verify-address e-mails. Which ones are on, the template each uses, the sender, each message's
   WhatsApp copy (through GPC WhatsApp), and everything sent, with resend. */
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
    const admin = App.isAdmin();
    const [cfg, templates, sent] = await Promise.all([
      api.get('/transactional/config'), api.get('/templates'), api.get(`/transactional?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    ]);
    // The company's numbers on GPC WhatsApp, to choose from (admins, once it is connected).
    const channels = admin && cfg.whatsapp_connected ? await api.get('/transactional/whatsapp-channels').catch(() => null) : null;
    const canWrite = App.me.role !== 'viewer';
    const label = Object.fromEntries(cfg.events.map((e) => [e.event, e.label]));
    const eventOf = (r) => label[(r.source_key || '').split(':')[0]] || r.template_key;
    // Transactional templates first, then the rest.
    const sorted = [...templates].sort((a, b) => (b.category === 'transactional') - (a.category === 'transactional') || a.name.localeCompare(b.name));
    const dis = admin ? '' : 'disabled';

    const chanLabel = (c) => `${c.name || c.id}${c.phone_number ? ` · ${c.phone_number}` : ''} (${c.type === 'waba' ? 'WABA: approved templates' : 'personal: free text'})${c.status && c.status !== 'connected' ? ` – ${c.status}` : ''}`;
    const waBlock = (e) => {
      const w = e.whatsapp;
      if (!w) return '';
      const opts = [`<option value="personal" data-type="personal" ${w.channel === 'personal' ? 'selected' : ''}>The company's personal number (free text)</option>`]
        .concat((channels || []).map((c) => `<option value="${esc(c.id)}" data-type="${esc(c.type)}" ${c.id === w.channel ? 'selected' : ''}>${esc(chanLabel(c))}</option>`));
      if (w.channel !== 'personal' && !(channels || []).some((c) => c.id === w.channel)) {
        opts.push(`<option value="${esc(w.channel)}" data-type="${w.kind === 'template' ? 'waba' : 'personal'}" selected>${esc(w.channel)}</option>`);
      }
      return `<div data-wa style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border, #e5e7eb)">
        <label class="check"><input type="checkbox" data-w="enabled" ${w.enabled ? 'checked' : ''} ${dis}> Also send on WhatsApp</label>
        <div data-w-fields style="margin-top:12px">
          <div class="field">${fieldLabel('From number')}<select data-w="channel" style="max-width:460px" ${dis}>${opts.join('')}</select></div>
          <div class="field" data-w-text>${fieldLabel('Message', admin ? '<button type="button" class="link-btn" data-w-reset>Default wording</button>' : '')}
            <textarea data-w="text" rows="${Math.min(18, Math.max(5, (w.text || w.default_text).split('\n').length + 1))}" ${dis}>${esc(w.text || w.default_text)}</textarea>
            <div class="hint">${e.source === 'keycloak'
              ? 'Merge tags: <code>{{first_name}}</code>, <code>{{expires_in}}</code>, <code>{{realm_name}}</code>, <code>{{username}}</code>. The link itself is never sent on WhatsApp: it stays in the email.'
              : 'Merge tags as in the email: <code>{{first_name}}</code>, <code>{{amount}}</code>, <code>{{item}}</code> …'} A line whose tags are all empty is left out.</div></div>
          <div data-w-template>
            <div class="row" style="gap:10px">
              <div class="field">${fieldLabel('Approved template name')}<input type="text" class="mono" data-w="template" value="${esc(w.template)}" placeholder="${e.source === 'keycloak' ? 'password_reset_notice' : 'payment_receipt'}" ${dis}></div>
              <div class="field" style="max-width:140px">${fieldLabel('Language')}<input type="text" class="mono" data-w="language" value="${esc(w.language)}" ${dis}></div>
            </div>
            <div class="field" style="margin-bottom:0">${fieldLabel('Body parameters', 'one per line, in order')}<textarea data-w="params" rows="4" class="mono" placeholder="{{first_name}}&#10;${e.source === 'keycloak' ? '{{expires_in}}' : '{{amount}}'}" ${dis}>${esc((w.params || []).join('\n'))}</textarea>
              <div class="hint">What fills the template's {{1}}, {{2}} … The template must be approved by Meta first (GPC WhatsApp → Templates, category Utility).</div></div>
          </div>
        </div></div>`;
    };
    const hasWhatsApp = cfg.events.some((e) => e.whatsapp);

    root.innerHTML = `
      ${App.pageHead({
        title: 'Transactional emails',
        subtitle: 'Emails (and WhatsApp messages) other systems send to one person about their order or account: receipts, bank-transfer instructions, refunds, password resets. They go even to people who unsubscribed from marketing, and are not tracked.',
        actions: admin ? `<button class="btn primary lg" id="save">${icon('check', 17)}Save</button>` : `<span class="badge yellow lg">Read-only (${esc(App.me.role)})</span>`,
      })}
      ${cfg.payment_hook ? '' : '<div class="banner warn">Payment events are not connected on this server (PAYMENT_EVENT_SECRET), so nothing here is sent yet.</div>'}
      ${cfg.keycloak_hook ? '' : '<div class="banner">The Keycloak emails below are not connected on this server (KEYCLOAK_EVENT_SECRET): Keycloak sends its own account emails.</div>'}
      ${cfg.crm_hook ? '' : '<div class="banner">The CRM emails below are not connected: set the signing secret in <a href="#/settings">Settings → Integrations → CRM (GPC-Lead)</a>.</div>'}
      ${hasWhatsApp && !cfg.whatsapp_connected ? '<div class="banner">To send these on WhatsApp too, connect GPC WhatsApp in <a href="#/settings">Settings → Integrations</a>.</div>' : ''}
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
          <p class="muted">A payment email can also go to the buyer's WhatsApp through GPC WhatsApp, where it shows in the inbox. It is off until you tick it: if the CRM still sends its own payment WhatsApp, switch that off first, or buyers get two.</p>
          <p class="muted" style="margin-bottom:0">Keycloak's account emails (new password, verify address) come here too. Switch one off and Keycloak sends its own email again; the same happens by itself whenever this server cannot send. Their WhatsApp message is only a notice that the email was sent, to the phone number on the account.</p>
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
          ${waBlock(e)}
        </div>`).join('')}
      </div>
      </form>
      <div class="card">
        ${cardHead({ icon: 'mail-open', tone: 'gray', title: 'Sent', sub: 'The latest 100; search by order number, account ID or email address' })}
        <form id="find" class="row" style="gap:8px;margin-bottom:16px;flex-wrap:nowrap" data-nosubmit>
          <input type="search" name="q" value="${esc(q)}" placeholder="Order number or email" style="flex:1;min-width:0;max-width:360px">
          <button class="btn">${icon('search', 15)}Find</button></form>
        ${sent.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Sent</th><th>To</th><th>Message</th><th class="hide-sm">Order / account</th><th>Status</th><th></th></tr></thead><tbody>
          ${sent.map((r) => {
            const wa = r.channel === 'whatsapp';
            const to = wa ? `+${r.to_phone}` : r.to_email;
            return `<tr><td class="nowrap">${fmtDate(r.sent_at || r.created_at)}</td><td>${esc(r.to_name ? `${r.to_name} <${to}>` : to)}</td>
            <td>${wa ? '<span class="badge green">WhatsApp</span> ' : ''}${esc(eventOf(r))}<div class="muted" style="font-size:12px" title="${esc(r.subject || '')}">${esc(wa && (r.subject || '').length > 60 ? `${r.subject.slice(0, 60)}…` : r.subject || '')}</div></td>
            <td class="hide-sm mono" style="font-size:12.5px">${esc(r.reference)}</td>
            <td>${statusBadge(r)}${r.error && r.status !== 'sent' ? `<div class="muted" style="font-size:12px">${esc(r.error)}</div>` : ''}</td>
            <td class="nowrap">${canWrite ? `<button class="btn sm" data-resend="${esc(r.id)}">${icon('refresh', 14)}Resend</button>` : ''}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : `<p class="muted">${q ? 'Nothing matches.' : 'Nothing sent yet.'}</p>`}
      </div>`;

    // "Edit template" follows the selection; the WhatsApp fields follow the number chosen.
    const isWaba = (box) => box.querySelector('[data-w="channel"]').selectedOptions[0]?.dataset.type === 'waba';
    const syncWa = (box) => {
      box.querySelector('[data-w-fields]').hidden = !box.querySelector('[data-w="enabled"]').checked;
      box.querySelector('[data-w-text]').hidden = isWaba(box);
      box.querySelector('[data-w-template]').hidden = !isWaba(box);
    };
    root.querySelectorAll('[data-event]').forEach((card) => {
      const sel = card.querySelector('[data-k="template_id"]');
      sel.onchange = () => { card.querySelector('[data-edit]').href = `#/templates/${sel.value}`; };
      const box = card.querySelector('[data-wa]');
      if (!box) return;
      syncWa(box);
      box.querySelector('[data-w="enabled"]').onchange = () => syncWa(box);
      box.querySelector('[data-w="channel"]').onchange = () => syncWa(box);
      const reset = box.querySelector('[data-w-reset]');
      const def = cfg.events.find((x) => x.event === card.dataset.event).whatsapp.default_text;
      if (reset) reset.onclick = () => { box.querySelector('[data-w="text"]').value = def; };
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
        const box = card.querySelector('[data-wa]');
        if (box) {
          const def = cfg.events.find((x) => x.event === card.dataset.event).whatsapp.default_text;
          const text = box.querySelector('[data-w="text"]').value.trim();
          events[card.dataset.event].whatsapp = {
            enabled: box.querySelector('[data-w="enabled"]').checked,
            channel: box.querySelector('[data-w="channel"]').value,
            kind: isWaba(box) ? 'template' : 'text',
            text: text === def.trim() ? '' : text, // the default wording stays the default
            template: box.querySelector('[data-w="template"]').value.trim(),
            language: box.querySelector('[data-w="language"]').value.trim(),
            params: box.querySelector('[data-w="params"]').value.split('\n').map((v) => v.trim()).filter(Boolean),
          };
        }
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
