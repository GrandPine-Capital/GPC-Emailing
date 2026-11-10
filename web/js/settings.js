/* Settings: sender, limits, Amazon SES and the worker, lead sources, sender identities, access, integrations. */
(() => {
  const { api, esc, toast, confirmDialog, fmtDate, icon, cardHead, fieldLabel } = App;

  const initials = (email) => String(email || '?').split('@')[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  function resetIn() {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const mins = Math.max(0, Math.round((next - now.getTime()) / 60000));
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  function input(name, value, { type = 'text', placeholder = '', suffix = '', mono = false, secret = false, readonly = false, copy = false } = {}) {
    const ro = readonly ? 'readonly' : '';
    const cls = mono || secret ? 'mono' : '';
    const attrs = `name="${name}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" class="${cls}" ${ro} autocomplete="off" spellcheck="false"`;
    if (secret) {
      return `<div class="affix has-btn"><input type="password" ${attrs}><button type="button" class="end-btn" data-reveal aria-label="Show or hide">${icon('eye', 18)}</button></div>`;
    }
    if (copy) {
      return `<div class="affix has-btn"><input type="${type}" ${attrs}><button type="button" class="end-btn" data-copy aria-label="Copy">${icon('copy', 17)}</button></div>`;
    }
    if (suffix) return `<div class="affix"><input type="${type}" ${attrs}><span class="suffix">${suffix}</span></div>`;
    return `<input type="${type}" ${attrs}>`;
  }

  /** How another sending domain or address is added (in AWS, by whoever runs the infrastructure). */
  function connectGuide(replyDomain) {
    App.modal(`<div class="row" style="align-items:center;margin-bottom:6px"><h2 style="margin:0;flex:1">Add a sending domain or address</h2><button class="btn icon ghost" data-close>${icon('x', 18)}</button></div>
      <p class="muted">Email goes out through <b>Amazon SES</b>. Any address at a verified domain can send; a single address can be verified on its own.</p>
      <ol style="line-height:1.9;padding-left:20px;margin-top:0">
        <li>In the AWS console, <b>Amazon SES → Identities → Create identity</b>, in the sending region shown on this page. Choose <b>Domain</b> (recommended) with <b>Easy DKIM</b>, or <b>Email address</b>.</li>
        <li>For a domain, add the three DKIM <code>CNAME</code> records SES shows at the domain's DNS host. SES verifies it within minutes to hours.</li>
        <li>Come back here and click <b>Refresh from SES</b>. The identity appears as <span class="badge green">Verified</span>.</li>
      </ol>
      <p class="hint">Replies to every sender come back through <b>${esc(replyDomain || 'the reply domain')}</b> and are forwarded to the sender's own mailbox, so nothing changes in your mail hosting.</p>
      <div class="foot"><button class="btn primary" data-close>Done</button></div>`, { wide: true });
  }

  App.route(/^#\/settings(?:\?(.*))?$/, async (root, qs) => {
    const [s, meta] = await Promise.all([api.get('/settings'), App.getMeta(true)]);
    const mail = s.mail || {};
    const sesAcct = mail.account || {};
    const st = s.status || {};
    const admin = !!s.can_edit;
    const remaining = meta.remainingToday ?? s.daily_limit ?? 100;
    const providers = 1 + ['hunter_api_key', 'apollo_api_key', 'google_cse_key'].filter((k) => s[k]).length;
    const workerBadge = !mail.configured
      ? '<span class="badge red lg">Not set up</span>'
      : mail.error ? '<span class="badge red lg">SES error</span>'
      : meta.workerOnline ? `<span class="badge green lg"><span class="dot"></span>Synced</span>` : '<span class="badge yellow lg">Idle</span>';
    const senders = s.senders || [];
    const lastSeen = Object.fromEntries((s.inbox || []).map((x) => [x.email, x.last_received_at]));
    const account = meta.account || st.account || '';

    root.innerHTML = `
      ${App.pageHead({
        title: 'Settings',
        badge: `<span class="badge outline lg">${s.dry_run ? 'Dry run' : 'Production'}</span>`,
        subtitle: 'Manage the sending mailbox, deliverability, sender identities and integrations.',
        actions: admin
          ? `<span class="save-state" id="save-state">${icon('check-circle', 17)}Auto-saved</span><button class="btn primary lg" id="save">Save settings</button>`
          : `<span class="badge yellow lg">Read-only (${esc(App.me.role)})</span>`,
      })}
      ${admin ? '' : '<div class="banner info">Only admins can change settings. Ask an admin if something needs updating.</div>'}
      <form id="settings" autocomplete="off" data-nosubmit>
      <div class="grid cols-2">

        <section class="card">
          ${cardHead({ icon: 'mail', title: 'Sender', sub: 'Configure outbound email identity and headers' })}
          <div class="field">${fieldLabel('Default sender')}
            <div class="affix"><input type="text" value="${esc(account || 'not set')}" readonly>${account && mail.configured ? '<span class="suffix pill"><span class="badge green"><span class="dot"></span>SES</span></span>' : ''}</div>
            <div class="hint">The default From address (below, under <b>Sender identities</b>); campaigns and automations may use any verified sender. Replies come back through ${esc(mail.reply_domain || 'the reply domain')} and are forwarded to the sender's mailbox.</div></div>
          <div class="field">${fieldLabel('From name')}${input('from_name', s.from_name, { placeholder: 'My Company' })}</div>
          <div class="field">${fieldLabel('Reply-to <span class="hint-inline">(optional)</span>')}${input('reply_to', s.reply_to, { type: 'email', placeholder: 'team@company.com' })}</div>
          <div class="field" style="margin-bottom:0">${fieldLabel('Company postal address <span class="hint-inline">(required by CAN-SPAM; shown in footers)</span>')}
            <textarea name="company_address" rows="2" placeholder="548 Market St, Suite 12345, San Francisco, CA 94104">${esc(s.company_address || '')}</textarea></div>
        </section>

        <section class="card">
          ${cardHead({ icon: 'chart', tone: 'violet', title: 'Sending limits', sub: 'Deliverability safety caps and scheduling throttle', aside: `<span class="badge green lg">${remaining} emails left today</span>` })}
          <div class="field">${fieldLabel('Max emails per day', `<span class="aside chip-hint">SES allows ${sesAcct.max_24h ? Math.round(sesAcct.max_24h).toLocaleString() : '…'} / 24h</span>`)}
            ${input('daily_limit', s.daily_limit ?? 100, { type: 'number', suffix: 'recipients / 24h' })}</div>
          <div class="field">${fieldLabel('Max emails per worker run', 'protects your reputation')}
            ${input('per_run_limit', s.per_run_limit ?? 40, { type: 'number', suffix: 'rate limit cap' })}
            <div class="hint">Spreads outgoing sending batches across steady recurring intervals.</div></div>
          <div class="field">${fieldLabel('Dry-run mode')}
            <select name="dry_run"><option value="false" ${!s.dry_run ? 'selected' : ''}>Off – deliver emails normally</option><option value="true" ${s.dry_run ? 'selected' : ''}>On – record and track, but don't deliver</option></select></div>
          <div class="inforow">${icon('info', 18)}<span>Remaining Today: <b>${remaining} emails left</b></span><span class="end">Resets in ${resetIn()}</span></div>
        </section>

        <section class="card">
          ${cardHead({ icon: 'server', tone: 'green', title: 'Amazon SES & worker', sub: 'How email goes out, and the worker that handles what comes back', aside: workerBadge })}
          <p class="muted" style="margin-top:0">The worker sends queued email through Amazon SES, handles bounces and spam complaints, records replies that reach the reply domain (and forwards them to the sender's mailbox), runs automations and auto-replies, and finds leads. It runs every few minutes, and straight away after you send or activate something.</p>
          ${mail.configured
            ? `<div class="status-lines">
                 <div><span class="dot"></span> <strong>Sending region:</strong> ${esc(mail.region || '')}${sesAcct.production === false ? ' <span class="badge yellow">SES sandbox: only verified recipients</span>' : ''}</div>
                 <div><span class="dot"></span> <strong>Quota:</strong> ${sesAcct.max_24h != null ? `${Math.round(sesAcct.sent_last_24h || 0).toLocaleString()} of ${Math.round(sesAcct.max_24h).toLocaleString()} sent in the last 24h, ${sesAcct.max_send_rate || 0}/s` : '—'}</div>
                 <div><span class="dot blue"></span> <strong>Replies to:</strong> ${mail.reply_domain ? `…@${esc(mail.reply_domain)}` : 'not set up (REPLY_DOMAIN)'}</div>
               </div>${mail.error ? `<div class="banner warn">SES answered: ${esc(mail.error)}</div>` : ''}`
            : '<div class="banner warn">The server has no Amazon SES configuration (SES_REGION, MAIL_FROM), so nothing is sent. Dry-run mode still records campaigns.</div>'}
          <div class="status-lines">
            <div><span class="dot"></span> <strong>Last run:</strong> ${st.last_tick ? fmtDate(st.last_tick) : 'never'}</div>
            <div><span class="dot blue"></span> <strong>Last reply check:</strong> ${st.last_reply_poll ? fmtDate(st.last_reply_poll) : 'never'}</div>
          </div>
          <div class="row"><button type="button" class="btn" id="check">${icon('check-circle', 17)}Check connection</button><button type="button" class="btn" id="run">${icon('play', 15)}Run worker now</button></div>
        </section>

        <section class="card">
          ${cardHead({ icon: 'key', tone: 'orange', title: 'Lead finder sources', sub: 'API keys for automated email finding & enrichment', aside: `<span class="badge outline lg">${providers} Provider${providers === 1 ? '' : 's'}</span>` })}
          <p class="muted" style="margin-top:0">Without keys, the Lead Finder uses DuckDuckGo search and crawls public company websites. Google Programmable Search gives 100 free queries/day.</p>
          <div class="field">${fieldLabel('Hunter.io API key', '<a href="https://hunter.io/api-keys" target="_blank" rel="noopener">hunter.io → API</a>')}${input('hunter_api_key', s.hunter_api_key, { secret: true, placeholder: 'Enter Hunter secret token' })}</div>
          <div class="field">${fieldLabel('Apollo.io API key', '<a href="https://app.apollo.io/#/settings/integrations/api" target="_blank" rel="noopener">apollo.io → Settings → API</a>')}${input('apollo_api_key', s.apollo_api_key, { secret: true, placeholder: 'Enter Apollo API key…' })}</div>
          <div class="field">${fieldLabel('Google Programmable Search API key', 'Cloud Console')}${input('google_cse_key', s.google_cse_key, { secret: true, placeholder: 'AIzaSy…' })}</div>
          <div class="field">${fieldLabel('Google Search engine ID (cx)')}${input('google_cse_cx', s.google_cse_cx, { mono: true })}</div>
          <div class="field" style="margin-bottom:0">${fieldLabel('Crawler User-Agent', 'identify yourself to websites')}${input('crawler_user_agent', s.crawler_user_agent, { mono: true })}</div>
        </section>

        <section class="card">
          ${cardHead({ icon: 'at', title: 'Sender identities', sub: 'Send campaigns and automations from different email addresses', aside: `<span class="badge outline lg">${senders.filter((x) => x.verified).length || 1} verified</span>` })}
          <div id="senders">${senders.length ? senders.map((x) => `
            <div class="list-row"><div class="avatar">${esc(initials(x.email))}</div>
              <div class="grow"><div class="truncate"><b>${x.type === 'domain' ? `*@${esc(x.email)}` : esc(x.email)}</b></div><div class="muted" style="font-size:13px">${x.type === 'domain' ? 'Any address at this domain' : 'This address only'}</div></div>
              ${x.primary ? '<span class="badge blue">Primary</span>' : ''}
              ${x.verified ? '<span class="badge green">Verified</span>' : '<span class="badge yellow">Pending verification</span>'}
            </div>`).join('') : `<p class="muted">No identities loaded yet. Click <b>Refresh from SES</b>.</p>`}</div>
          <div class="field" style="margin-top:18px">${fieldLabel('Default "From" address')}
            ${input('default_from_email', s.default_from_email, { type: 'email', placeholder: `${mail.default_from || 'hello@yourcompany.com'} (server default)` })}
            <div class="hint">Campaigns and automation emails can also pick their own address. ${App.sendersHint(s)}${s.senders_updated_at ? ` · last refreshed ${fmtDate(s.senders_updated_at)}` : ''}</div></div>
          <div class="row"><button type="button" class="btn primary" id="connect-email">${icon('plus', 16)}Add a sending domain</button>
            <button type="button" class="btn" id="refresh-senders">${icon('refresh', 16)}Refresh from SES</button></div>
        </section>

        <section class="card">
          ${cardHead({ icon: 'shield', tone: 'violet', title: 'Access', sub: 'Who can sign in to Emailing' })}
          <p class="muted" style="margin-top:0">Staff sign in with their GrandPine account. Access is granted in the IAM Workspace, on the Emailing app:</p>
          <ul class="muted">
            <li><b>Admin</b> also manages these settings and the integration keys.</li>
            <li><b>Editor</b> works with campaigns, contacts, templates and automations.</li>
            <li><b>Viewer</b> can look but not change anything.</li>
          </ul>
          <div class="hint">You are signed in as <b>${esc(App.me.email)}</b> (${esc(App.me.role === 'member' ? 'editor' : App.me.role)}).</div>
        </section>

        <section class="card">
          ${cardHead({ icon: 'whatsapp', tone: 'wa', title: 'WhatsApp & ChatDaddy', sub: 'Send WhatsApp messages from automations', aside: (s.chatdaddy_token || s.whatsapp_token) ? '<span class="badge green lg"><span class="dot"></span>Connected</span>' : '<span class="badge lg">Not set up</span>' })}
          <div class="row">
            <div class="field">${fieldLabel('Default provider')}<select name="whatsapp_provider">
              <option value="chatdaddy" ${s.whatsapp_provider !== 'cloud' ? 'selected' : ''}>ChatDaddy</option>
              <option value="cloud" ${s.whatsapp_provider === 'cloud' ? 'selected' : ''}>WhatsApp Cloud API (Meta)</option></select></div>
            <div class="field">${fieldLabel('Default country code', 'for local numbers')}${input('default_country_code', s.default_country_code, { placeholder: 'e.g. 60 for Malaysia', suffix: '' })}</div>
          </div>
          <h3 style="margin-top:4px">ChatDaddy</h3>
          <div class="field">${fieldLabel('ChatDaddy API token', '<a href="https://app.chatdaddy.tech/settings/api" target="_blank" rel="noopener">app.chatdaddy.tech → Settings → API</a>')}${input('chatdaddy_token', s.chatdaddy_token, { secret: true, placeholder: 'API token with messages & contacts scopes' })}</div>
          <div class="field">${fieldLabel('ChatDaddy channel (account ID)', '"random" = any connected number')}${input('chatdaddy_account_id', s.chatdaddy_account_id || 'random', { mono: true })}</div>
          <h3>WhatsApp Cloud API <span class="hint-inline" style="font-weight:400">(optional)</span></h3>
          <div class="row">
            <div class="field">${fieldLabel('Phone number ID')}${input('whatsapp_phone_number_id', s.whatsapp_phone_number_id, { mono: true, placeholder: '1234567890' })}</div>
            <div class="field" style="max-width:150px">${fieldLabel('Template language')}${input('whatsapp_template_language', s.whatsapp_template_language || 'en', { mono: true })}</div>
          </div>
          <div class="field">${fieldLabel('Access token', '<a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">Meta for Developers</a>')}${input('whatsapp_token', s.whatsapp_token, { secret: true, placeholder: 'EAAG…' })}</div>
          <div class="row"><div class="field" style="margin:0">${fieldLabel('Send a test to')}<input type="tel" id="wa-test" placeholder="+60 12-345 6789"></div>
            <button type="button" class="btn" id="wa-test-btn" style="height:46px">${icon('send', 16)}Send test</button></div>
          <div class="hint">ChatDaddy and WhatsApp are paid services: their usage is billed by them, not by this portal.</div>
        </section>

        <section class="card">
          ${cardHead({ icon: 'webhook', tone: 'gray', title: 'Inbound webhooks', sub: 'Receive WhatsApp replies and leads from other apps' })}
          <div class="field">${fieldLabel('ChatDaddy webhook URL', `<button type="button" class="link-btn" data-copy-from="cd_hook">${icon('copy', 14)}Copy</button>`)}
            <input type="text" class="mono" id="cd_hook" value="${esc(s.chatdaddy_webhook_url || (admin ? '' : 'Admins only'))}" readonly>
            <div class="hint">In ChatDaddy, add this URL as a webhook for the <b>message-insert</b> event. Incoming WhatsApp messages then appear in <a href="#/replies">Replies</a>, stop "stop on reply" sequences and fire the <b>WhatsApp message received</b> trigger.</div></div>
          <div class="field">${fieldLabel('Generic webhook URL (forms, Zapier, CRM)', `<button type="button" class="link-btn" data-copy-from="gen_hook">${icon('copy', 14)}Copy</button>`)}
            <input type="text" class="mono" id="gen_hook" value="${esc(s.generic_webhook_url || (admin ? '' : 'Admins only'))}" readonly>
            <div class="hint">POST JSON like <code>{"email":"jane@acme.com","phone":"+60123456789","name":"Jane Tan","tags":["webinar"],"list_id":"…","event":"form_submitted"}</code>. The contact is created or updated and the <b>Webhook received</b> trigger fires.</div></div>
          ${admin ? `<button type="button" class="btn" id="regen">${icon('refresh', 16)}Generate new secret</button>` : ''}
        </section>
      </div>
      ${admin ? `<button type="button" class="btn primary lg block" id="save-bottom" style="margin-top:24px">${icon('check', 18)}Save changes</button>
` : ''}
      </form>`;

    const form = root.querySelector('#settings');
    if (!admin) form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => { el.disabled = true; });

    // reveal / copy helpers
    form.querySelectorAll('[data-reveal]').forEach((b) => (b.onclick = () => {
      const inp = b.parentElement.querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      b.innerHTML = icon(inp.type === 'password' ? 'eye' : 'eye-off', 18);
    }));
    const copy = async (text) => {
      if (!text) return;
      try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed - select and copy manually', 'error'); }
    };
    form.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.parentElement.querySelector('input').value)));
    form.querySelectorAll('[data-copy-from]').forEach((b) => (b.onclick = () => {
      const el = form.querySelector(`[name="${b.dataset.copyFrom}"]`) || form.querySelector(`#${b.dataset.copyFrom}`);
      copy(el && el.value);
    }));

    // save (manual + auto)
    const state = root.querySelector('#save-state');
    const setState = (html) => { if (state) state.innerHTML = html; };
    const save = async ({ quiet = false } = {}) => {
      setState(`${icon('refresh', 16)}Saving…`);
      try {
        await api.put('/settings', App.formData(form));
        setState(`${icon('check-circle', 17)}Auto-saved`);
        await App.getMeta(true);
        if (!quiet) toast('Settings saved');
      } catch {
        setState(`${icon('alert', 16)}Not saved`);
      }
    };
    const autosave = App.debounce(() => save({ quiet: true }), 900);
    if (admin) {
      form.addEventListener('input', (e) => {
        if (!e.target.name) return;
        setState(`${icon('edit', 15)}Unsaved changes`);
        autosave();
      });
      form.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' && e.target.name) autosave(); });
      root.querySelector('#save').onclick = () => save();
      root.querySelector('#save-bottom').onclick = () => save();
    }

    root.querySelector('#check').onclick = async () => {
      if (admin) await save({ quiet: true });
      const r = await api.post('/settings/check');
      toast(r.message, r.ok ? 'info' : 'error');
    };
    root.querySelector('#run').onclick = async () => {
      toast('Running the worker…');
      const r = await api.post('/replies/poll');
      toast(`Worker finished: ${JSON.stringify(r.summary || {})}`);
      App.navigate();
    };
    root.querySelector('#connect-email').onclick = () => connectGuide(mail.reply_domain);
    root.querySelector('#refresh-senders').onclick = async () => {
      const r = await api.post('/senders/refresh');
      toast(`${r.senders.length} sender identit${r.senders.length === 1 ? 'y' : 'ies'} loaded from SES`);
      App.navigate();
    };
    root.querySelector('#wa-test-btn').onclick = async () => {
      if (admin) await save({ quiet: true });
      await api.post('/integrations/test-whatsapp', { phone: root.querySelector('#wa-test').value, provider: form.querySelector('[name=whatsapp_provider]').value });
      toast('Test WhatsApp message sent');
    };
    root.querySelector('#regen')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Generate a new webhook secret? Existing webhook URLs in ChatDaddy or other apps stop working until you update them.', { okText: 'Generate', danger: false }))) return;
      await api.post('/settings/webhook-secret');
      App.navigate();
    });

  });
})();
