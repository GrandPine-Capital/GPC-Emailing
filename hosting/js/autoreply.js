/* Auto-reply: rules that answer incoming email automatically, plus an inbox activity log. */
(() => {
  const { api, esc, toast, confirmDialog, fmtDate, icon } = App;
  const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
  const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Asia/Kuala_Lumpur'; } };

  // Quick-start presets; `library` names the template from the template library.
  const PRESETS = [
    { key: 'thanks', icon: 'mail', title: 'Thank everyone who emails us', library: 'auto-thanks',
      desc: 'Confirm receipt of every new email and save the sender as a contact.',
      rule: { name: 'Thanks for contacting us', audience: 'all', create_contact: true, tags: 'email-enquiry', cooldown_hours: 24 } },
    { key: 'after_hours', icon: 'clock', title: 'After office hours', library: 'auto-after-hours',
      desc: 'Only outside Mon-Fri 9:00-18:00: let people know when you will reply.',
      rule: { name: 'After-hours reply', audience: 'all', cooldown_hours: 12, schedule: { mode: 'outside', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } } },
    { key: 'course_info', icon: 'sparkles', title: 'Course enquiry → info pack', library: 'auto-course-info',
      desc: 'When an email mentions course, fee or class, send your course details and tag the lead.',
      rule: { name: 'Course enquiry info', audience: 'all', keywords: 'course, fee, price, class, workshop, intake', create_contact: true, tags: 'course-enquiry', cooldown_hours: 72 } },
  ];

  function summary(r, ctx) {
    const parts = [];
    parts.push(r.to_address ? `email to <b>${esc(r.to_address)}</b>` : 'email to <b>any of my addresses</b>');
    if (r.audience === 'new') parts.push('from <b>new senders</b>');
    if (r.audience === 'contacts') parts.push('from <b>existing contacts</b>');
    if (r.keywords) parts.push(`mentioning <b>${esc(r.keywords)}</b>`);
    const sch = r.schedule || {};
    if (sch.mode === 'outside') parts.push(`<b>outside ${esc(sch.start)}-${esc(sch.end)}</b>`);
    if (sch.mode === 'inside') parts.push(`<b>during ${esc(sch.start)}-${esc(sch.end)}</b>`);
    return `When ${parts.join(' ')}, reply with <b>"${esc(ctx.templateName(r.template_id) || 'choose a template')}"</b>, at most once every ${r.cooldown_hours || 24}h per sender.`;
  }

  const resultBadge = (d) => ({
    replied: `<span class="badge green">${icon('check', 12)}Auto-replied</span>`,
    skipped: `<span class="badge yellow" title="${esc(d.reason || '')}">Skipped</span>`,
    error: `<span class="badge red" title="${esc(d.reason || '')}">Error</span>`,
  }[d.status] || '<span class="badge">Received</span>');

  async function ensureLibraryTemplate(key, templates) {
    const lib = (window.EmailTemplateLibrary || []).find((t) => t.key === key);
    const existing = templates.find((t) => t.name === lib.name);
    if (existing) return existing.id;
    const saved = await api.post('/templates', { name: lib.name, category: lib.category, subject: lib.subject, mode: lib.mode === 'html' ? 'html' : 'dragdrop', design: lib.design || null, html: lib.html || '' });
    return saved.id;
  }

  // ------------------------------------------------------------------ list page
  App.route(/^#\/autoreply$/, async (root) => {
    const [meta, rules, templates, inbound, settings] = await Promise.all([
      App.getMeta(), api.get('/autoreplies'), api.get('/templates'), api.get('/inbound?limit=40'), api.get('/settings'),
    ]);
    const tname = Object.fromEntries(templates.map((t) => [t.id, t.name]));
    const ctx = { templateName: (id) => tname[id] };
    const identities = (settings.senders || []).filter((x) => x.verified);
    const lastSeen = Object.fromEntries((settings.inbox || []).map((x) => [x.email, x.last_received_at]));
    root.innerHTML = `
      ${App.pageHead({
        title: 'Auto-reply',
        subtitle: 'Answer incoming emails automatically - from the same address they wrote to.',
        actions: `<a class="btn primary lg" href="#/autoreply/new">${icon('plus', 18)}New auto-reply</a>`,
      })}
      ${App.banners.worker(meta)}
      <div class="grid cols-2" style="margin-bottom:24px">
        <section class="card">
          ${App.cardHead({ icon: 'at', title: 'Connected addresses', sub: 'Emails to these addresses reach your inbox and can be auto-replied' })}
          ${identities.length ? identities.map((x) => `<div class="list-row"><div class="avatar">${esc(x.email[0].toUpperCase())}</div>
            <div class="grow"><b class="truncate" style="display:block">${esc(x.email)}</b><span class="muted" style="font-size:13px">${lastSeen[x.email] ? `Last email received ${fmtDate(lastSeen[x.email])}` : 'No email received yet'}</span></div>
            ${x.primary ? '<span class="badge blue">Main inbox</span>' : '<span class="badge green">Connected</span>'}</div>`).join('')
            : `<p class="muted">Connect the worker first (Settings).</p>`}
          <a class="btn" href="#/settings" style="margin-top:14px">${icon('plus', 16)}Connect another email address</a>
        </section>
        <section class="card">
          ${App.cardHead({ icon: 'sparkles', tone: 'violet', title: 'Quick start', sub: 'One click creates the rule and its reply template' })}
          ${PRESETS.map((p) => `<button type="button" class="pick" data-preset="${p.key}" style="width:100%;margin-bottom:10px"><div class="icon-tile sm">${icon(p.icon, 16)}</div>
            <div><div class="p-t">${esc(p.title)}</div><div class="p-d">${esc(p.desc)}</div></div></button>`).join('')}
        </section>
      </div>
      <h2>Your rules</h2>
      ${rules.length ? `<div class="stack">${rules.map((r) => `<div class="card" style="padding:18px 20px"><div class="list-row" style="padding:0">
          <div class="icon-tile ${r.enabled ? 'green' : 'gray'}">${icon('reply', 20)}</div>
          <div class="grow"><a href="#/autoreply/${r.id}"><b>${esc(r.name)}</b></a>
            <div class="muted" style="font-size:13.5px">${summary(r, ctx)}</div>
            <div class="muted" style="font-size:12.5px;margin-top:4px">${r.replied_count || 0} auto-replies sent${r.last_replied_at ? ` · last ${fmtDate(r.last_replied_at)}` : ''}</div></div>
          <span class="badge ${r.enabled ? 'green' : ''}">${r.enabled ? 'On' : 'Off'}</span>
          <button class="btn sm" data-toggle="${r.id}">${r.enabled ? 'Turn off' : 'Turn on'}</button>
          <button class="btn icon ghost danger" data-del="${r.id}" title="Delete">${icon('trash', 17)}</button>
        </div></div>`).join('')}</div>` : '<div class="card empty">No auto-reply rules yet. Use a quick start above or create your own.</div>'}
      <div class="card" style="margin-top:24px">
        ${App.cardHead({ icon: 'mail-open', tone: 'gray', title: 'Recent incoming email', sub: 'What happened to each email the worker read (checked every 5 minutes)' })}
        ${inbound.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Received</th><th>From</th><th class="hide-sm">To</th><th>Subject</th><th>Result</th></tr></thead><tbody>
          ${inbound.map((d) => `<tr><td class="nowrap">${fmtDate(d.received_at)}</td><td>${esc(d.from_email)}</td><td class="hide-sm">${esc((d.to || []).join(', '))}</td>
            <td>${esc(d.subject)}</td><td>${resultBadge(d)}${d.status === 'skipped' || d.status === 'error' ? `<div class="muted" style="font-size:12px">${esc(d.reason || '')}</div>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Nothing yet - incoming email appears here after the worker checks your inbox.</p>'}
      </div>`;

    root.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = async () => {
      const p = PRESETS.find((x) => x.key === b.dataset.preset);
      const templateId = await ensureLibraryTemplate(p.library, templates);
      const r = await api.post('/autoreplies', { enabled: true, template_id: templateId, timezone: browserTz(), ...p.rule });
      toast(`"${p.rule.name}" is on. Review it below.`);
      location.hash = `#/autoreply/${r.id}`;
    }));
    root.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => { await api.post(`/autoreplies/${b.dataset.toggle}/toggle`); App.navigate(); }));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (await confirmDialog('Delete this auto-reply rule?')) { await api.del(`/autoreplies/${b.dataset.del}`); App.navigate(); }
    }));
  });

  // ------------------------------------------------------------------ editor
  App.route(/^#\/autoreply\/(new|[\w-]+)$/, async (root, id) => {
    const [templates, lists, settings] = await Promise.all([api.get('/templates'), api.get('/lists'), api.get('/settings')]);
    const r = id === 'new'
      ? { name: '', enabled: true, to_address: '', audience: 'all', keywords: '', exclude: '', template_id: '', keep_thread: true, from_mode: 'recipient', from_email: '',
        cooldown_hours: 24, schedule: { mode: 'always', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, timezone: browserTz(),
        create_contact: true, list_id: '', tags: '', notify_email: '' }
      : await api.get(`/autoreplies/${id}`);
    const sch = r.schedule || {};
    const identities = (settings.senders || []).filter((x) => x.verified);
    const sel = (name, options, value) => `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const autoTemplates = templates.filter((t) => t.category === 'auto-reply');
    const otherTemplates = templates.filter((t) => t.category !== 'auto-reply');

    root.innerHTML = `
      ${App.pageHead({
        title: id === 'new' ? 'New auto-reply' : esc(r.name), back: { href: '#/autoreply', label: 'Auto-reply' },
        badge: `<span class="badge ${r.enabled ? 'green' : ''}">${r.enabled ? 'On' : 'Off'}</span>`,
        actions: `${id !== 'new' ? `<button class="btn danger" id="del">${icon('trash', 16)}Delete</button>` : ''}<button class="btn primary lg" id="save">${icon('check', 17)}Save</button>`,
      })}
      <form id="ar" onsubmit="return false"><div class="grid cols-2">
        <section class="card">
          ${App.cardHead({ icon: 'filter', title: 'Which emails', sub: 'Choose the emails this rule answers' })}
          <div class="field">${App.fieldLabel('Rule name')}<input type="text" name="name" value="${esc(r.name)}" placeholder="e.g. Thanks for contacting us"></div>
          <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Rule is on</label>
          <div class="field" style="margin-top:12px">${App.fieldLabel('Sent to')}${sel('to_address', [['', 'Any of my addresses'], ...identities.map((x) => [x.email, x.email])], r.to_address)}</div>
          <div class="field">${App.fieldLabel('From')}${sel('audience', [['all', 'Everyone'], ['new', 'New senders only (not yet a contact)'], ['contacts', 'Existing contacts only']], r.audience)}</div>
          <div class="field">${App.fieldLabel('Only if the subject or message contains', 'optional')}<input type="text" name="keywords" value="${esc(r.keywords)}" placeholder="course, price, fee">
            <div class="hint">Comma separated - any one matches. Leave empty to answer every email.</div></div>
          <div class="field" style="margin-bottom:0">${App.fieldLabel('Never reply to senders containing', 'optional')}<input type="text" name="exclude" value="${esc(r.exclude)}" placeholder="@mycompany.com, supplier">
            <div class="hint">No-reply addresses, newsletters, mailing lists and other auto-responders are always ignored.</div></div>
        </section>

        <section class="card">
          ${App.cardHead({ icon: 'reply', tone: 'green', title: 'Reply', sub: 'What to send back' })}
          <div class="field">${App.fieldLabel('Reply with template', '<a href="#/templates/library/Auto-reply">Template library →</a>')}
            <select name="template_id"><option value="">— choose a template —</option>
              ${autoTemplates.length ? `<optgroup label="Auto-reply templates">${autoTemplates.map((t) => `<option value="${t.id}" ${r.template_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>` : ''}
              <optgroup label="All templates">${otherTemplates.map((t) => `<option value="${t.id}" ${r.template_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup></select>
            <div class="hint">Merge tags like <code>{{first_name|there}}</code> use the sender's name.</div></div>
          <label class="check"><input type="checkbox" name="keep_thread" ${r.keep_thread !== false ? 'checked' : ''}> Reply in the same conversation ("Re: their subject")</label>
          <div class="field" style="margin-top:12px">${App.fieldLabel('Send from')}${sel('from_mode', [['recipient', 'The address they wrote to (recommended)'], ['default', 'My default sender'], ['custom', 'A specific address…']], r.from_mode)}</div>
          <div class="field" id="from-custom" style="${r.from_mode === 'custom' ? '' : 'display:none'}">${sel('from_email', identities.map((x) => [x.email, x.email]), r.from_email)}</div>
          <div class="field" style="margin-bottom:0">${App.fieldLabel('Reply to the same person at most once every')}
            <div class="affix"><input type="number" name="cooldown_hours" min="1" value="${esc(r.cooldown_hours || 24)}"><span class="suffix">hours</span></div></div>
        </section>

        <section class="card">
          ${App.cardHead({ icon: 'clock', tone: 'orange', title: 'When', sub: 'Always, or only in or outside office hours' })}
          <div class="field">${App.fieldLabel('Active')}<select name="schedule_mode">
            <option value="always" ${!sch.mode || sch.mode === 'always' ? 'selected' : ''}>Always</option>
            <option value="outside" ${sch.mode === 'outside' ? 'selected' : ''}>Only outside office hours</option>
            <option value="inside" ${sch.mode === 'inside' ? 'selected' : ''}>Only during office hours</option></select></div>
          <div id="hours" style="${!sch.mode || sch.mode === 'always' ? 'display:none' : ''}">
            <div class="field">${App.fieldLabel('Office days')}${DAYS.map(([v, l]) => `<label class="check"><input type="checkbox" name="days" data-group value="${v}" ${(sch.days || [1, 2, 3, 4, 5]).map(Number).includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
            <div class="row"><div class="field">${App.fieldLabel('Opens')}<input type="text" name="start" value="${esc(sch.start || '09:00')}" placeholder="09:00"></div>
              <div class="field">${App.fieldLabel('Closes')}<input type="text" name="end" value="${esc(sch.end || '18:00')}" placeholder="18:00"></div></div>
            <div class="field" style="margin-bottom:0">${App.fieldLabel('Time zone')}<input type="text" name="timezone" value="${esc(r.timezone || browserTz())}" class="mono"></div>
          </div>
        </section>

        <section class="card">
          ${App.cardHead({ icon: 'user-plus', tone: 'violet', title: 'After replying', sub: 'Capture the lead and keep your team informed' })}
          <label class="check"><input type="checkbox" name="create_contact" ${r.create_contact ? 'checked' : ''}> Save the sender as a contact</label>
          <div class="row" style="margin-top:12px">
            <div class="field">${App.fieldLabel('Add to list')}${sel('list_id', [['', '— none —'], ...lists.map((l) => [l.id, l.name])], r.list_id)}</div>
            <div class="field">${App.fieldLabel('Tags')}<input type="text" name="tags" value="${esc(r.tags)}" placeholder="email-enquiry"></div></div>
          <div class="field" style="margin-bottom:0">${App.fieldLabel('Notify my team at', 'optional')}<input type="email" name="notify_email" value="${esc(r.notify_email)}" placeholder="sales@mycompany.com">
            <div class="hint">For follow-ups (wait, WhatsApp, tags), use an automation with the trigger <b>Any email received</b>.</div></div>
        </section>
      </div></form>`;

    const form = root.querySelector('#ar');
    form.querySelector('[name=from_mode]').onchange = (e) => { root.querySelector('#from-custom').style.display = e.target.value === 'custom' ? '' : 'none'; };
    form.querySelector('[name=schedule_mode]').onchange = (e) => { root.querySelector('#hours').style.display = e.target.value === 'always' ? 'none' : ''; };
    root.querySelector('#save').onclick = async () => {
      const f = App.formData(form);
      const body = { ...f, schedule: { mode: f.schedule_mode, days: (f.days || []).map(Number), start: f.start, end: f.end } };
      if (!/^\d{2}:\d{2}$/.test(f.start || '') || !/^\d{2}:\d{2}$/.test(f.end || '')) return toast('Use 24-hour times like 09:00 and 18:00', 'error');
      const saved = id === 'new' ? await api.post('/autoreplies', body) : await api.put(`/autoreplies/${id}`, body);
      toast('Auto-reply saved');
      location.hash = id === 'new' ? `#/autoreply/${saved.id}` : '#/autoreply';
    };
    root.querySelector('#del')?.addEventListener('click', async () => {
      if (await confirmDialog('Delete this auto-reply rule?')) { await api.del(`/autoreplies/${id}`); location.hash = '#/autoreply'; }
    });
  });
})();
