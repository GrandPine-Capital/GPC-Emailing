/* The Settings tab "Transactional e-mails" (the page used to be #/transactional): what other systems (GPC-Payment, Helpdesk, Keycloak) ask us to send to
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

  // ------------------------------------------------------------------ system & lifecycle e-mails
  // The table in the Settings tab "Transactional e-mails" (it used to sit at the bottom of Automations): every e-mail the system sends by itself (payment,
  // Helpdesk and Keycloak events: on/off, template, WhatsApp copy), the Keycloak templates that
  // nothing sends yet, and the standard lifecycle flows still to be created as automations.

  const STAGE = { payment: 'Billing', helpdesk: 'Account & security', keycloak: 'Account & security', crm: 'CRM' };
  const stageOf = (e) => (e.event === 'subscription.charge_upcoming' ? 'Trial' : STAGE[e.source] || 'Other');

  // Standard lifecycle flows. `event` is what the product posts to the webhook (Settings →
  // Integrations → Inbound webhooks) as {"email": "...", "event": "<event>"}; the automation starts on it.
  const LIFECYCLE = [
    { key: 'lc_signup_welcome', stage: 'Sign-up', title: 'Welcome a new sign-up', when: 'The product reports a new account', event: 'user_signed_up', tag: 'signed-up', tpl: 'Welcome Email' },
    { key: 'lc_optin_welcome', stage: 'Sign-up', title: 'Welcome a confirmed subscriber', when: 'Someone confirms a subscribe form (double opt-in)', trigger: 'subscription_confirmed', tag: 'subscriber', tpl: 'Welcome Email' },
    { key: 'lc_onboarding', stage: 'Onboarding', title: 'Onboarding series (day 1, 3 and 7)', when: 'After sign-up: three emails over the first week', event: 'user_signed_up', tag: 'onboarding', tpl: 'Welcome Email', series: true },
    { key: 'lc_installed', stage: 'Install', title: 'App installed: getting started', when: 'The product reports a first install', event: 'app_installed', tag: 'installed', tpl: 'Welcome Email' },
    { key: 'lc_uninstalled', stage: 'Install', title: 'App uninstalled: ask why, invite back', when: 'The product reports an uninstall', event: 'app_uninstalled', tag: 'uninstalled', untag: 'installed', tpl: 'Personal Follow-up' },
    { key: 'lc_trial_started', stage: 'Trial', title: 'Trial started', when: 'A free trial begins', event: 'trial_started', tag: 'trial', tpl: 'Welcome Email' },
    { key: 'lc_trial_ending', stage: 'Trial', title: 'Trial ending soon', when: 'A few days before the trial ends', event: 'trial_ending', tag: 'trial-ending', tpl: 'Promotion' },
    { key: 'lc_trial_ended', stage: 'Trial', title: 'Trial ended: upgrade offer', when: 'The trial ends without a paid plan', event: 'trial_ended', tag: 'trial-ended', untag: 'trial', tpl: 'Promotion' },
    { key: 'lc_subscribed', stage: 'Billing', title: 'Became a paying customer: thank you', when: 'A paid plan starts', event: 'subscription_started', tag: 'customer', untag: 'trial' },
    { key: 'lc_payment_failed', stage: 'Billing', title: 'Payment failed: update your card', when: 'A renewal charge fails', event: 'payment_failed', tag: 'payment-failed', tpl: 'Personal Follow-up' },
    { key: 'lc_renewal', stage: 'Billing', title: 'Renewal reminder', when: 'A few days before a plan renews', event: 'subscription_renewal_upcoming', tag: 'renewal-due', tpl: 'Personal Follow-up' },
    { key: 'lc_cancelled', stage: 'Billing', title: 'Subscription cancelled: feedback and win-back', when: 'A paid plan is cancelled', event: 'subscription_cancelled', tag: 'cancelled', untag: 'customer', tpl: 'Personal Follow-up' },
    { key: 'lc_unsubscribed', stage: 'Opt-out', title: 'Unsubscribed: tag and tell the team', when: 'A contact unsubscribes (they get no further email)', trigger: 'unsubscribed', tag: 'unsubscribed', notify: true },
    { key: 'lc_inactive', stage: 'Retention', title: 'Inactive user: win-back', when: 'The product reports no activity for a while', event: 'user_inactive', tag: 'inactive', tpl: 'Promotion' },
  ];
  const lcTrigger = (l) => l.trigger || 'webhook_received';

  /** The automation a lifecycle flow starts as (the builder opens it at #/automations/new/<key>). */
  function lifecycleRecipe(key) {
    const l = LIFECYCLE.find((x) => x.key === key);
    if (!l) return null;
    return {
      key: l.key, title: l.title, trigger_type: lcTrigger(l), trigger_config: l.event ? { event: l.event } : {},
      steps: (t) => {
        const steps = [{ type: 'add_tag', tag: l.tag }];
        if (l.untag) steps.push({ type: 'remove_tag', tag: l.untag });
        if (l.notify) steps.push({ type: 'notify', channel: 'email' });
        // No starter template named: the step is there, and the builder asks for one.
        if (!l.notify) steps.push({ type: 'send_email', template_id: l.tpl ? t(l.tpl) : '' });
        if (l.series) {
          steps.push({ type: 'wait', amount: 2, unit: 'days' }, { type: 'send_email', template_id: t('Monthly Newsletter') },
            { type: 'wait', amount: 4, unit: 'days' }, { type: 'send_email', template_id: t('Personal Follow-up') });
        }
        return steps;
      },
    };
  }

  /** The automation already built for a lifecycle flow, if any. */
  const builtFor = (l, automations) => automations.find((a) => a.trigger_type === lcTrigger(l) && (l.event ? (a.trigger_config || {}).event === l.event : true)
    // Welcome and onboarding start on the same event: the series is the one with several emails.
    && (l.event !== 'user_signed_up' || (a.steps.filter((x) => x.type === 'send_email').length > 1) === !!l.series));

  async function mountSystemEmails(el, { automations, templates }) {
    const admin = App.isAdmin();
    const dis = admin ? '' : 'disabled';
    const cfg = await api.get('/transactional/config');
    const channels = admin && cfg.whatsapp_connected ? await api.get('/transactional/whatsapp-channels').catch(() => null) : null;
    const sorted = [...templates].sort((a, b) => (b.category === 'transactional') - (a.category === 'transactional') || a.name.localeCompare(b.name));
    const used = new Set(cfg.events.map((e) => e.default_template_id));
    // Keycloak's other e-mails: a template each, and nothing that sends it yet.
    const waiting = templates.filter((t) => /^txn-keycloak-/.test(t.id) && !used.has(t.id) && !cfg.events.some((e) => e.template_id === t.id));
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
    const badge = (text, color = '') => `<span class="badge ${color}">${text}</span>`;
    const hookOff = (e) => (e.source === 'payment' && !cfg.payment_hook) || (e.source === 'keycloak' && !cfg.keycloak_hook) || (e.source === 'crm' && !cfg.crm_hook);

    const eventRows = cfg.events.map((e) => `<tr data-row="${esc(e.event)}">
        <td>${esc(stageOf(e))}</td>
        <td><b>${esc(e.label)}</b><div class="muted" style="font-size:12.5px">${esc(e.description)}</div></td>
        <td><a href="#/templates/${esc(e.template_id)}">${esc(e.template_name || 'template')}</a></td>
        <td>${e.whatsapp ? (e.whatsapp.enabled ? badge('WhatsApp on', 'green') : '<span class="muted">off</span>') : '<span class="muted">—</span>'}</td>
        <td>${e.enabled ? badge('On', 'green') : badge('Off')}${hookOff(e) ? ` ${badge('Not connected', 'yellow')}` : ''}</td>
        <td class="nowrap right"><button type="button" class="btn sm" data-toggle-row="${esc(e.event)}">${icon('settings', 14)}Configure</button></td></tr>
      <tr data-detail="${esc(e.event)}" hidden><td colspan="6" style="background:var(--subtle, #f8fafc)">
        <div data-event="${esc(e.event)}" style="padding:6px 4px">
          <div class="row" style="gap:16px;flex-wrap:wrap;align-items:center">
            <label class="check" style="margin:0"><input type="checkbox" data-k="enabled" ${e.enabled ? 'checked' : ''} ${dis}> Send this email</label>
            <span class="muted" style="font-size:13px">Template</span>
            <select data-k="template_id" style="max-width:340px" ${dis}>
              ${sorted.map((t) => `<option value="${esc(t.id)}" ${t.id === e.template_id ? 'selected' : ''}>${esc(t.name)}${t.id === e.default_template_id ? ' (default)' : ''}</option>`).join('')}
            </select>
            <a class="btn sm" data-edit href="#/templates/${esc(e.template_id)}">${icon('edit', 15)}Edit template</a>
          </div>
          ${waBlock(e)}
        </div></td></tr>`).join('');

    const waitingRows = waiting.map((t) => `<tr>
        <td>Account &amp; security</td>
        <td><b>${esc(t.name.replace(/^Keycloak( alert)?: /, (m, a) => (a ? 'Alert: ' : '')))}</b><div class="muted" style="font-size:12.5px">Keycloak still sends its own version of this email.</div></td>
        <td><a href="#/templates/${esc(t.id)}">${esc(t.name)}</a></td>
        <td><span class="muted">—</span></td>
        <td>${badge('Template ready, not connected', 'yellow')}</td>
        <td class="nowrap right"><a class="btn sm" href="#/templates/${esc(t.id)}">${icon('edit', 14)}Edit template</a></td></tr>`).join('');

    const lifecycleRows = LIFECYCLE.map((l) => {
      const a = builtFor(l, automations);
      return `<tr>
        <td>${esc(l.stage)}</td>
        <td><b>${esc(l.title)}</b><div class="muted" style="font-size:12.5px">${esc(l.when)}${l.event ? ` · event <code>${esc(l.event)}</code>` : ''}</div></td>
        <td>${a ? `<a href="#/automations/${esc(a.id)}">${esc(a.name)}</a>` : '<span class="muted">—</span>'}</td>
        <td><span class="muted">—</span></td>
        <td>${a ? (a.status === 'active' ? badge('Created · active', 'green') : badge('Created · paused', 'yellow')) : badge('To be created', 'red')}</td>
        <td class="nowrap right">${a ? `<a class="btn sm" href="#/automations/${esc(a.id)}">Open</a>` : `<a class="btn sm primary" href="#/automations/new/${l.key}">${icon('plus', 14)}Create</a>`}</td></tr>`;
    }).join('');

    const done = cfg.events.length + LIFECYCLE.filter((l) => builtFor(l, automations)).length;
    const todo = waiting.length + LIFECYCLE.filter((l) => !builtFor(l, automations)).length;
    const head = (title, note) => `<tr><th colspan="6" style="background:transparent;padding-top:22px;text-transform:none;letter-spacing:0;font-size:14.5px;color:var(--text)">${title} <span class="muted" style="font-weight:400">${note}</span></th></tr>`;
    el.innerHTML = `<div class="card" style="margin-top:24px" id="sys-emails-card">
      ${cardHead({ icon: 'send', tone: 'green', title: 'System & lifecycle emails', sub: 'Every email the system sends by itself: what exists, and the standard flows still to create',
        aside: `<span class="badge green lg">${done} created</span> <span class="badge red lg">${todo} to do</span>` })}
      ${admin ? '' : '<div class="banner info"><span>Only admins can change which system emails are sent.</span></div>'}
      <div class="table-wrap"><table class="data"><thead><tr><th>Stage</th><th>Email / flow</th><th>Template or automation</th><th>WhatsApp</th><th>Status</th><th></th></tr></thead><tbody>
        ${head('Created: sent automatically', 'when another GrandPine system (payments, Helpdesk, sign-in) reports the event')}
        ${eventRows}
        ${waiting.length ? head('Templates ready, not connected yet', 'the wording is here to edit; the sign-in service does not hand these to Emailing yet') + waitingRows : ''}
        ${head('Standard lifecycle flows', 'each is an automation: Create opens it pre-filled, you choose the email and activate')}
        ${lifecycleRows}
      </tbody></table></div>
      ${admin ? `<div class="row" style="margin-top:16px;align-items:center;gap:12px"><button type="button" class="btn primary" id="sys-save">${icon('check', 16)}Save system emails</button><span class="muted" style="font-size:13px">Saves the On/Off, template and WhatsApp choices above.</span></div>` : ''}
      <div class="inforow" style="margin-top:16px">${icon('info', 18)}<span>The lifecycle flows start when your product posts the event to the webhook in <a href="#/settings/integrations">Settings → Integrations → Inbound webhooks</a>, for example <code>{"email":"jane@acme.com","first_name":"Jane","event":"trial_started"}</code>. The sender of the system emails is above this table and everything sent is below it.</span></div>
    </div>`;

    el.querySelectorAll('[data-toggle-row]').forEach((b) => (b.onclick = () => {
      const d = el.querySelector(`[data-detail="${b.dataset.toggleRow}"]`);
      d.hidden = !d.hidden;
    }));
    // "Edit template" follows the selection; the WhatsApp fields follow the number chosen.
    const isWaba = (box) => box.querySelector('[data-w="channel"]').selectedOptions[0]?.dataset.type === 'waba';
    const syncWa = (box) => {
      box.querySelector('[data-w-fields]').hidden = !box.querySelector('[data-w="enabled"]').checked;
      box.querySelector('[data-w-text]').hidden = isWaba(box);
      box.querySelector('[data-w-template]').hidden = !isWaba(box);
    };
    el.querySelectorAll('[data-event]').forEach((card) => {
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
    const save = el.querySelector('#sys-save');
    if (save) save.onclick = async () => {
      const events = {};
      el.querySelectorAll('[data-event]').forEach((card) => {
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
        await api.put('/transactional/config', { events_only: true, events });
        toast('System emails saved.');
        App.navigate();
      } catch { save.disabled = false; }
    };
  }
  App.systemEmails = { mount: mountSystemEmails, lifecycleRecipe };

  /** Draws the tab into `root` (a panel of the Settings page); `qs` is the query string (q=…) of the address. */
  async function render(root, qs) {
    const params = new URLSearchParams(qs || '');
    const q = params.get('q') || '';
    const admin = App.isAdmin();
    const [cfg, templates, sent, automations] = await Promise.all([
      api.get('/transactional/config'), api.get('/templates'), api.get(`/transactional?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`), api.get('/automations'),
    ]);
    const canWrite = App.me.role !== 'viewer';
    const label = Object.fromEntries(cfg.events.map((e) => [e.event, e.label]));
    const eventOf = (r) => label[(r.source_key || '').split(':')[0]] || r.template_key;
    const dis = admin ? '' : 'disabled';

    root.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px">
        <p class="muted" style="margin:0;flex:1">Emails (and WhatsApp messages) other systems send to one person about their order or account: receipts, bank-transfer instructions, refunds, password resets. They go even to people who unsubscribed from marketing, and are not tracked.</p>
        ${admin ? `<button class="btn primary lg" id="txn-save" style="flex-shrink:0">${icon('check', 17)}Save sender</button>` : `<span class="badge yellow lg">Read-only (${esc(App.me.role)})</span>`}
      </div>
      ${cfg.payment_hook ? '' : '<div class="banner warn">Payment events are not connected on this server (PAYMENT_EVENT_SECRET), so nothing here is sent yet.</div>'}
      ${cfg.keycloak_hook ? '' : '<div class="banner">The Keycloak emails below are not connected on this server (KEYCLOAK_EVENT_SECRET): Keycloak sends its own account emails.</div>'}
      ${cfg.crm_hook ? '' : '<div class="banner">The CRM emails below are not connected: set the signing secret in <a href="#/settings/integrations">Settings → Integrations → CRM (GPC-Lead)</a>.</div>'}
      <form id="txn" data-nosubmit autocomplete="off">
      <div class="grid cols-2" style="margin-bottom:24px">
        <section class="card">
          ${cardHead({ icon: 'mail', title: 'Sender', sub: 'Who these emails come from' })}
          <div class="field">${fieldLabel('From address', '<span class="aside chip-hint">empty = server default</span>')}
            <input type="email" name="from_email" value="${esc(cfg.from_email)}" placeholder="${esc(cfg.default_from_email || cfg.effective_from_email)}" ${dis}>
            <div class="hint">Any address on a verified SES identity (<a href="#/settings/sending">Settings → Sending → Sender identities</a>). Now sending as <b>${esc(cfg.effective_from_email)}</b>.
              ${cfg.no_reply ? 'A no-reply address carries no reply address, so customers cannot reply.' : 'Replies come back through the reply domain and are forwarded to this mailbox.'}</div></div>
          <div class="field" style="margin-bottom:0">${fieldLabel('From name', '<span class="aside chip-hint">empty = server default</span>')}
            <input type="text" name="from_name" value="${esc(cfg.from_name)}" placeholder="${esc(cfg.effective_from_name || 'GrandPine Capital')}" ${dis}></div>
        </section>
        <section class="card">
          ${cardHead({ icon: 'info', tone: 'gray', title: 'How it works', sub: 'From GPC-Payment to the customer' })}
          <p class="muted" style="margin-top:0">When an order changes in GPC-Payment, it tells Emailing, and the matching email from the table below goes to the buyer's address straight away. Each email goes once per order; a failed send is retried for a few hours. Edit the wording in <a href="#/templates">Templates</a> — merge tags such as <code>{{item}}</code>, <code>{{amount}}</code>, <code>{{receipt_url}}</code> are listed in each template's starter text.</p>
          <p class="muted">A payment email can also go to the buyer's WhatsApp through GPC WhatsApp, where it shows in the inbox. It is off until you tick it: if the CRM still sends its own payment WhatsApp, switch that off first, or buyers get two.</p>
          <p class="muted" style="margin-bottom:0">Keycloak's account emails (new password, verify address) come here too. Switch one off and Keycloak sends its own email again; the same happens by itself whenever this server cannot send. Their WhatsApp message is only a notice that the email was sent, to the phone number on the account.</p>
        </section>
      </div>
      </form>
      <div id="sys-emails"></div>
      <div class="card" style="margin-top:24px">
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

    // The system emails and the lifecycle flows, as one table: its own Save button, apart from the sender's.
    const sys = root.querySelector('#sys-emails');
    mountSystemEmails(sys, { automations, templates }).catch((err) => { sys.innerHTML = `<div class="card"><h2>System &amp; lifecycle emails</h2><p class="muted">${esc(err.message)}</p></div>`; });
    root.querySelector('#find').onsubmit = (ev) => {
      ev.preventDefault();
      const v = new FormData(ev.target).get('q').trim();
      location.hash = window.SettingsTabs.hashFor('transactional', v ? `q=${encodeURIComponent(v)}` : '');
    };
    root.querySelectorAll('[data-resend]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api.post(`/transactional/${b.dataset.resend}/resend`);
        toast(r.status === 'sent' ? 'Sent again.' : `Queued (${r.status}).`);
        App.navigate();
      } catch { b.disabled = false; }
    }));
    const save = root.querySelector('#txn-save');
    if (save) save.onclick = async () => {
      const form = root.querySelector('#txn');
      save.disabled = true;
      try {
        await api.put('/transactional/config', { sender_only: true, from_email: form.from_email.value.trim(), from_name: form.from_name.value.trim() });
        toast('Saved.');
        App.navigate();
      } catch { save.disabled = false; }
    };
  }

  window.TransactionalPanel = { render };

  // The page's old address now leads to its tab in Settings (the search, if any, goes with it).
  App.route(/^#\/transactional(?:\?.*)?$/, async () => {
    location.replace(window.SettingsTabs.legacyRedirect(location.hash));
  });
})();
