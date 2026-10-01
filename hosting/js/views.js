/* All screens except the template editor (see builder.js). */
(() => {
  const { api, esc, toast, modal, confirmDialog, formData, fmtDate, statusBadge, chips, chipValues, route } = App;
  const pct = (n) => `${Number(n || 0).toFixed(1).replace(/\.0$/, '')}%`;
  const opts = (items, selected, { value = 'id', label = 'name', blank } = {}) =>
    (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
    items.map((i) => `<option value="${esc(i[value])}" ${String(i[value]) === String(selected ?? '') ? 'selected' : ''}>${esc(i[label])}</option>`).join('');

  function dryRunBanner(meta) {
    return meta.dryRun
      ? '<div class="banner warn"><strong>Dry-run mode is on:</strong> emails are rendered and tracked but not delivered. Turn it off in <a href="#/settings">Settings</a>.</div>'
      : '';
  }

  function workerBanner(meta) {
    if (!meta.workerConfigured) {
      return '<div class="banner warn"><strong>Worker not connected:</strong> deploy the Google Apps Script worker and run <code>setup()</code> (see README) to send emails, detect replies, run automations and find leads.</div>';
    }
    if (!meta.workerOnline) {
      return `<div class="banner warn"><strong>Worker idle:</strong> the Apps Script worker last ran ${meta.lastTick ? fmtDate(meta.lastTick) : 'never'}. Check its 5-minute trigger in Apps Script.</div>`;
    }
    return '';
  }

  // ================================================================ Dashboard
  route(/^#\/dashboard$/, async (root) => {
    const [meta, s] = await Promise.all([App.getMeta(true), api.get('/stats')]);
    const max = Math.max(1, ...s.daily.map((d) => Number(d.sent) + Number(d.opens) + Number(d.clicks) + Number(d.replies)));
    const colors = { sent: '#93c5fd', opens: '#2563eb', clicks: '#16a34a', replies: '#d97706' };
    root.innerHTML = `
      <div class="page-head"><h1>Dashboard</h1>
        <div class="actions"><a class="btn" href="#/leads">🔎 Find leads</a><a class="btn" href="#/templates/new-dragdrop">🎨 New template</a><a class="btn primary" href="#/campaigns/new">🚀 New campaign</a></div></div>
      ${workerBanner(meta)}${dryRunBanner(meta)}
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Contacts</div><div class="value">${s.contacts}</div><div class="sub">${s.subscribed} subscribed · ${s.lists} lists</div></div>
        <div class="card stat"><div class="label">Sent (30 days)</div><div class="value">${s.sent30}</div><div class="sub">${s.queued} queued now</div></div>
        <div class="card stat"><div class="label">Open rate</div><div class="value">${pct(s.openRate)}</div><div class="sub">Click rate ${pct(s.clickRate)}</div></div>
        <div class="card stat"><div class="label">Reply rate</div><div class="value">${pct(s.replyRate)}</div><div class="sub">${s.replied30} replies · ${s.activeAutomations} active automations</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card"><h2>Activity (last 30 days)</h2>
          ${s.daily.length ? `<div class="bars">${s.daily.map((d) => `<div class="bar" title="${esc(d.day)}: ${d.sent} sent, ${d.opens} opens, ${d.clicks} clicks, ${d.replies} replies">
            ${['sent', 'opens', 'clicks', 'replies'].map((k) => `<span style="height:${(Number(d[k]) / max) * 130}px;background:${colors[k]}"></span>`).join('')}</div>`).join('')}</div>
            <div class="legend">${Object.entries(colors).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('')}</div>` : '<div class="empty">No activity yet.</div>'}
        </div>
        <div class="card"><h2>Latest replies</h2>
          ${s.recentReplies.length ? s.recentReplies.map((r) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><strong>${esc(r.first_name || r.from_email)}</strong> <span class="muted">${esc(r.company || '')} · ${fmtDate(r.received_at)}</span><div class="muted">${esc((r.body || r.subject || '').slice(0, 140))}</div></div>`).join('') + '<p><a href="#/replies">All replies →</a></p>' : '<div class="empty">No replies yet.</div>'}
        </div>
      </div>
      <div class="card"><h2>Getting started</h2>
        <ol style="margin:0;padding-left:20px;line-height:2">
          <li>Connect the Google Apps Script worker (sends through your Gmail and reads replies from it) and review <a href="#/settings">Settings</a>.</li>
          <li>Import contacts from CSV in <a href="#/contacts">Contacts</a>, or discover leads by country &amp; industry in <a href="#/leads">Lead Finder</a>.</li>
          <li>Design an email with the <a href="#/templates">drag &amp; drop builder or HTML editor</a> (standard templates included).</li>
          <li>Create a <a href="#/campaigns">campaign</a>, send a test, then send now or schedule.</li>
          <li>Activate <a href="#/automations">automations</a> for follow-ups after sending and auto-responses after replies.</li>
        </ol></div>`;
  });

  // ================================================================ Templates
  route(/^#\/templates$/, async (root) => {
    const list = await api.get('/templates');
    root.innerHTML = `
      <div class="page-head"><h1>Templates</h1>
        <div class="actions"><a class="btn" href="#/templates/new-html">&lt;/&gt; New HTML template</a><a class="btn primary" href="#/templates/new-dragdrop">＋ New drag &amp; drop template</a></div></div>
      <div class="tpl-grid">${list.map((t) => `
        <div class="tpl-card" data-id="${t.id}">
          <div class="tpl-thumb" data-open><iframe loading="lazy" sandbox="" data-html="${t.id}"></iframe></div>
          <div class="meta"><div class="name">${esc(t.name)}</div>
            <div class="muted" style="font-size:12px">${t.is_standard ? '<span class="badge blue">standard</span> ' : ''}<span class="badge">${esc(t.category)}</span> <span class="badge">${t.mode === 'html' ? 'HTML' : 'drag & drop'}</span></div>
            <div class="muted" style="font-size:12px;margin-top:4px">${esc(t.subject)}</div></div>
          <div class="acts"><a class="btn sm" href="#/templates/${t.id}">Edit</a><button class="btn sm" data-dup>Duplicate</button><a class="btn sm" href="#/campaigns/new?template=${t.id}">Use</a><button class="btn sm danger" data-del>Delete</button></div>
        </div>`).join('')}</div>`;
    const byId = Object.fromEntries(list.map((t) => [t.id, t]));
    root.querySelectorAll('iframe[data-html]').forEach((f) => { f.srcdoc = byId[f.dataset.html].html; });
    root.querySelectorAll('.tpl-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-open]').onclick = () => { location.hash = `#/templates/${id}`; };
      card.querySelector('[data-dup]').onclick = async () => { const t = await api.post(`/templates/${id}/duplicate`); location.hash = `#/templates/${t.id}`; };
      card.querySelector('[data-del]').onclick = async () => {
        if (await confirmDialog('Delete this template?')) { await api.del(`/templates/${id}`); App.navigate(); }
      };
    });
  });

  // ================================================================ Campaigns
  route(/^#\/campaigns$/, async (root) => {
    const list = await api.get('/campaigns');
    root.innerHTML = `
      <div class="page-head"><h1>Campaigns</h1><div class="actions"><a class="btn primary" href="#/campaigns/new">＋ New campaign</a></div></div>
      <div class="card table-wrap">${list.length ? `<table class="data"><thead><tr><th>Name</th><th>Status</th><th>Template</th><th class="right">Sent</th><th class="right">Opens</th><th class="right">Clicks</th><th class="right">Replies</th><th>Date</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr><td><a href="#/campaigns/${c.id}">${esc(c.name)}</a><div class="muted" style="font-size:12px">${esc(c.subject)}</div></td>
          <td>${statusBadge(c.status)}</td><td>${esc(c.template_name || '—')}</td>
          <td class="right">${c.stats.sent}${c.stats.queued ? ` <span class="muted">(+${c.stats.queued})</span>` : ''}</td>
          <td class="right">${pct(c.stats.open_rate)}</td><td class="right">${pct(c.stats.click_rate)}</td><td class="right">${c.stats.replied}</td>
          <td class="nowrap">${fmtDate(c.finished_at || c.scheduled_at || c.created_at)}</td>
          <td class="nowrap"><button class="btn sm" data-dup="${c.id}">Duplicate</button> <button class="btn sm danger" data-del="${c.id}">Delete</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No campaigns yet. <a href="#/campaigns/new">Create your first campaign</a>.</div>'}</div>`;
    root.querySelectorAll('[data-dup]').forEach((b) => (b.onclick = async () => { const c = await api.post(`/campaigns/${b.dataset.dup}/duplicate`); location.hash = `#/campaigns/${c.id}`; }));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (await confirmDialog('Delete this campaign and its statistics?')) { await api.del(`/campaigns/${b.dataset.del}`); App.navigate(); }
    }));
  });

  route(/^#\/campaigns\/(new|[\w-]+)(?:\?template=([\w-]+))?$/, async (root, id, presetTemplate) => {
    const [meta, templates, lists, settings] = await Promise.all([App.getMeta(), api.get('/templates'), api.get('/lists'), api.get('/settings')]);
    let c = id === 'new'
      ? { id: null, name: '', subject: '', preheader: '', template_id: presetTemplate || '', from_name: '', reply_to: '', list_ids: [], status: 'draft' }
      : await api.get(`/campaigns/${id}`);
    if (id === 'new' && presetTemplate) c.subject = templates.find((t) => String(t.id) === presetTemplate)?.subject || '';
    if (['launching', 'sending', 'sent', 'paused'].includes(c.status)) return renderReport(root, c);
    root.innerHTML = `
      <div class="page-head"><div><a href="#/campaigns">← Campaigns</a><h1>${c.id ? esc(c.name) : 'New campaign'} ${statusBadge(c.status)}</h1></div>
        <div class="actions">${c.status === 'scheduled' ? '<button class="btn" id="unschedule">Cancel schedule</button>' : ''}
          <button class="btn" id="save">Save draft</button><button class="btn" id="test">Send test</button><button class="btn" id="schedule">Schedule…</button><button class="btn success" id="send">Send now</button></div></div>
      ${workerBanner(meta)}${dryRunBanner(meta)}
      ${c.error ? `<div class="banner warn">${esc(c.error)}</div>` : ''}
      ${c.status === 'scheduled' ? `<div class="banner info">Scheduled for <strong>${fmtDate(c.scheduled_at)}</strong>.</div>` : ''}
      <div class="grid cols-2">
        <div class="card" id="form">
          <h2>1. Details</h2>
          <div class="field"><label>Campaign name <span class="hint">(internal)</span></label><input type="text" name="name" value="${esc(c.name)}" placeholder="October newsletter"></div>
          <div class="field"><label>Subject line</label><input type="text" name="subject" value="${esc(c.subject)}" placeholder="{{first_name}}, ..."></div>
          <div class="field"><label>Preheader <span class="hint">(preview text in inbox)</span></label><input type="text" name="preheader" value="${esc(c.preheader)}"></div>
          <div class="row"><div class="field"><label>From name</label><input type="text" name="from_name" value="${esc(c.from_name)}" placeholder="${esc(settings.from_name)}"></div>
            <div class="field"><label>From email</label><input type="email" value="${esc(meta.account || 'your Gmail account')}" disabled></div></div>
          <div class="field"><label>Reply-to <span class="hint">(optional; replies are detected in the Gmail inbox)</span></label><input type="email" name="reply_to" value="${esc(c.reply_to)}" placeholder="${esc(settings.reply_to || meta.account || '')}"></div>
          <h2 style="margin-top:20px">2. Recipients</h2>
          ${lists.length ? lists.map((l) => `<label class="check"><input type="checkbox" name="list_ids" data-group value="${l.id}" ${c.list_ids.map(String).includes(String(l.id)) ? 'checked' : ''}> ${esc(l.name)} <span class="muted">(${l.subscribed || 0})</span></label>`).join('') : '<p class="muted">No lists yet. <a href="#/lists">Create a list</a> and add contacts.</p>'}
          <p class="hint">Unsubscribed and bounced contacts and duplicates across lists are skipped automatically. Gmail limits sending to about 100/day (free Gmail) or 1,500–2,000/day (Google Workspace); large campaigns continue automatically on the following days.</p>
          <h2 style="margin-top:20px">3. Content</h2>
          <div class="field"><label>Template</label><select name="template_id">${opts(templates, c.template_id, { blank: '— choose a template —' })}</select></div>
          <p><a href="#/templates/new-dragdrop">Design a new template</a> · <span id="edit-tpl"></span></p>
        </div>
        <div class="card"><h2>Preview</h2><iframe class="preview-frame" id="preview" style="height:640px"></iframe></div>
      </div>`;
    const form = root.querySelector('#form');
    const preview = async () => {
      const tid = form.querySelector('[name=template_id]').value;
      root.querySelector('#edit-tpl').innerHTML = tid ? `<a href="#/templates/${tid}">Edit this template</a>` : '';
      const t = tid ? await api.get(`/templates/${tid}`) : null;
      const subj = form.querySelector('[name=subject]');
      if (t && !subj.value && !subj.dataset.touched && document.activeElement !== subj) subj.value = t.subject;
      const r = t ? await api.post('/templates/render', { mode: t.mode, design: t.design, html: t.html }) : { preview: '<p style="font-family:sans-serif;color:#888;padding:20px">Choose a template to preview.</p>' };
      root.querySelector('#preview').srcdoc = r.preview;
    };
    ['input', 'focus'].forEach((ev) => form.querySelector('[name=subject]').addEventListener(ev, (e) => { e.target.dataset.touched = '1'; }));
    form.querySelector('[name=template_id]').onchange = preview;
    preview();

    const save = async () => {
      const data = formData(form);
      data.list_ids = data.list_ids || [];
      if (!data.name) data.name = data.subject || 'Untitled campaign';
      c = c.id ? await api.put(`/campaigns/${c.id}`, data) : await api.post('/campaigns', data);
      history.replaceState(null, '', `#/campaigns/${c.id}`);
      return c;
    };
    root.querySelector('#save').onclick = async () => { await save(); toast('Campaign saved'); };
    root.querySelector('#unschedule')?.addEventListener('click', async () => { await api.post(`/campaigns/${c.id}/unschedule`); App.navigate(); });
    root.querySelector('#test').onclick = () => modal(`<h2>Send test</h2><div class="field"><label>Send to</label><input type="email" id="to"></div>
      <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Send test</button></div>`, {
      onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
        await save();
        const r = await api.post(`/campaigns/${c.id}/test`, { email: el.querySelector('#to').value });
        toast(r.dryRun ? 'Dry-run: test rendered but not delivered.' : 'Test sent');
        close();
      }),
    });
    root.querySelector('#schedule').onclick = () => {
      const d = new Date(Date.now() + 3600e3);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      modal(`<h2>Schedule campaign</h2><div class="field"><label>Send at (your local time)</label><input type="datetime-local" id="at" value="${d.toISOString().slice(0, 16)}"></div>
        <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Schedule</button></div>`, {
        onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
          await save();
          await api.post(`/campaigns/${c.id}/schedule`, { scheduled_at: new Date(el.querySelector('#at').value).toISOString() });
          close();
          toast('Campaign scheduled');
          App.navigate();
        }),
      });
    };
    root.querySelector('#send').onclick = async () => {
      await save();
      const detail = await api.get(`/campaigns/${c.id}`);
      if (!detail.recipients) return toast('No subscribed recipients in the selected lists', 'error');
      if (!(await confirmDialog(`Send "${detail.subject}" to ${detail.recipients_estimate ? 'up to ' : ''}${detail.recipients} recipients now?`, { okText: 'Send now', danger: false }))) return;
      await api.post(`/campaigns/${c.id}/send`);
      toast('Campaign started. The worker sends in batches every few minutes.');
      App.navigate();
    };
  });

  async function renderReport(root, c) {
    const draw = async () => {
      c = await api.get(`/campaigns/${c.id}`);
      const s = c.stats;
      const filter = root.querySelector('#msg-filter')?.value || '';
      const msgs = await api.get(`/campaigns/${c.id}/messages${filter ? `?filter=${filter}` : ''}`);
      const done = s.total ? Math.round(((s.total - s.queued) / s.total) * 100) : 100;
      root.innerHTML = `
        <div class="page-head"><div><a href="#/campaigns">← Campaigns</a><h1>${esc(c.name)} ${statusBadge(c.status)}</h1><div class="muted">${esc(c.subject)}</div></div>
          <div class="actions">${c.status === 'sending' ? '<button class="btn" id="pause">Pause</button>' : ''}${c.status === 'paused' ? '<button class="btn primary" id="resume">Resume</button>' : ''}
          <button class="btn" id="dup">Duplicate</button><a class="btn" href="#/automations/new?campaign=${c.id}">⚡ Add follow-up automation</a></div></div>
        ${c.status === 'launching' ? '<div class="banner info">Preparing recipients… the worker picks this up within a few minutes.</div>' : ''}
        ${c.status === 'sending' || c.status === 'paused' ? `<div class="card"><div class="row" style="justify-content:space-between"><strong>Sending progress</strong><span>${s.total - s.queued} / ${s.total}</span></div><div class="progress" style="margin-top:8px"><div style="width:${done}%"></div></div></div>` : ''}
        <div class="grid cols-4">
          <div class="card stat"><div class="label">Delivered</div><div class="value">${s.sent}</div><div class="sub">${s.failed} failed · ${s.skipped} skipped</div></div>
          <div class="card stat"><div class="label">Opened</div><div class="value">${pct(s.open_rate)}</div><div class="sub">${s.opened} contacts</div></div>
          <div class="card stat"><div class="label">Clicked</div><div class="value">${pct(s.click_rate)}</div><div class="sub">${s.clicked} contacts</div></div>
          <div class="card stat"><div class="label">Replied</div><div class="value">${pct(s.reply_rate)}</div><div class="sub">${s.replied} replies · ${s.unsubscribed} unsubscribed</div></div>
        </div>
        ${c.links.length ? `<div class="card"><h2>Top links</h2><table class="data"><thead><tr><th>URL</th><th class="right">Clicks</th><th class="right">People</th></tr></thead><tbody>${c.links.map((l) => `<tr><td class="mono">${esc(l.url)}</td><td class="right">${l.clicks}</td><td class="right">${l.people}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="card table-wrap"><div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Recipients</h2>
          <select id="msg-filter" style="width:auto"><option value="">All</option>${['opened', 'clicked', 'replied', 'failed'].map((f) => `<option ${f === filter ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
          <table class="data"><thead><tr><th>Contact</th><th>Status</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Replied</th></tr></thead><tbody>
          ${msgs.map((m) => `<tr><td><a href="#/contacts/${encodeURIComponent(m.contact_id)}">${esc(m.email)}</a><div class="muted" style="font-size:12px">${esc([m.first_name, m.last_name].join(' '))} ${esc(m.company || '')}</div></td>
            <td>${statusBadge(m.status)}${m.error ? `<div class="muted" style="font-size:12px">${esc(m.error)}</div>` : ''}</td><td class="nowrap">${fmtDate(m.sent_at)}</td>
            <td>${m.opened_at ? `✓ ${m.open_count}×` : ''}</td><td>${m.clicked_at ? `✓ ${m.click_count}×` : ''}</td><td>${m.replied_at ? '✓' : ''}</td></tr>`).join('')}
          </tbody></table></div>`;
      root.querySelector('#msg-filter').onchange = draw;
      root.querySelector('#pause')?.addEventListener('click', async () => { await api.post(`/campaigns/${c.id}/pause`); draw(); });
      root.querySelector('#resume')?.addEventListener('click', async () => { await api.post(`/campaigns/${c.id}/resume`); draw(); });
      root.querySelector('#dup').onclick = async () => { const d = await api.post(`/campaigns/${c.id}/duplicate`); location.hash = `#/campaigns/${d.id}`; };
    };
    await draw();
    const timer = setInterval(() => { if (['launching', 'sending'].includes(c.status) && document.visibilityState === 'visible') draw(); }, 10000);
    return () => clearInterval(timer);
  }

  // ================================================================ Automations
  route(/^#\/automations$/, async (root) => {
    const [meta, list] = await Promise.all([App.getMeta(), api.get('/automations')]);
    root.innerHTML = `
      <div class="page-head"><h1>Automations</h1><div class="actions"><a class="btn primary" href="#/automations/new">＋ New automation</a></div></div>
      ${workerBanner(meta)}
      <div class="card table-wrap">${list.length ? `<table class="data"><thead><tr><th>Name</th><th>Trigger</th><th>Steps</th><th>Runs</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((a) => `<tr><td><a href="#/automations/${a.id}">${esc(a.name)}</a></td><td>${esc(a.trigger_type.replace('_', ' '))}${a.trigger_config.keywords ? `<div class="muted" style="font-size:12px">keywords: ${esc(a.trigger_config.keywords)}</div>` : ''}</td>
        <td>${a.steps.map((s) => `<span class="tag">${esc(s.type.replace(/_/g, ' '))}</span>`).join(' ')}</td>
        <td class="nowrap">${Object.entries(a.runs).map(([k, v]) => `${v} ${k}`).join(' · ') || '—'}</td>
        <td>${statusBadge(a.status)}</td>
        <td class="nowrap"><button class="btn sm" data-toggle="${a.id}" data-status="${a.status}">${a.status === 'active' ? 'Pause' : 'Activate'}</button> <button class="btn sm danger" data-del="${a.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No automations yet.</div>'}</div>`;
    root.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
      await api.post(`/automations/${b.dataset.toggle}/${b.dataset.status === 'active' ? 'pause' : 'activate'}`);
      App.navigate();
    }));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (await confirmDialog('Delete this automation and its run history?')) { await api.del(`/automations/${b.dataset.del}`); App.navigate(); }
    }));
  });

  route(/^#\/automations\/(new|[\w-]+)(?:\?campaign=([\w-]+))?$/, async (root, id, presetCampaign) => {
    const [meta, templates, lists, campaignsList] = await Promise.all([App.getMeta(), api.get('/templates'), api.get('/lists'), api.get('/campaigns')]);
    const a = id === 'new'
      ? {
        id: null, name: presetCampaign ? 'Follow-up sequence' : '', status: 'paused', allow_reentry: 0,
        trigger_type: presetCampaign ? 'email_sent' : 'reply_received',
        trigger_config: presetCampaign ? { campaign_id: presetCampaign, stop_on_reply: true } : {},
        steps: presetCampaign ? [{ type: 'wait', amount: 3, unit: 'days' }, { type: 'stop_if', condition: 'replied' }, { type: 'send_email', template_id: '', reply_in_thread: true }] : [],
        recent: [], runs: {},
      }
      : await api.get(`/automations/${id}`);

    const triggerFields = () => {
      const cfg = a.trigger_config;
      const campaignSel = `<div class="field"><label>Campaign <span class="hint">(optional)</span></label><select data-cfg="campaign_id">${opts(campaignsList, cfg.campaign_id, { blank: 'Any campaign' })}</select></div>`;
      const templateSel = `<div class="field"><label>Template <span class="hint">(optional)</span></label><select data-cfg="template_id">${opts(templates, cfg.template_id, { blank: 'Any template' })}</select></div>`;
      switch (a.trigger_type) {
        case 'email_sent':
        case 'email_opened':
          return `<div class="row">${campaignSel}${templateSel}</div>`;
        case 'link_clicked':
          return `<div class="row">${campaignSel}<div class="field"><label>URL contains <span class="hint">(optional)</span></label><input type="text" data-cfg="url_contains" value="${esc(cfg.url_contains || '')}"></div></div>`;
        case 'reply_received':
          return `<div class="row">${campaignSel}<div class="field"><label>Reply contains any keyword <span class="hint">(comma separated, optional)</span></label><input type="text" data-cfg="keywords" value="${esc(cfg.keywords || '')}" placeholder="interested, price, call"></div></div>`;
        case 'contact_added':
          return `<div class="field"><label>List</label><select data-cfg="list_id">${opts(lists, cfg.list_id, { blank: 'Any list' })}</select></div>`;
        default:
          return '<p class="hint">Enrol contacts manually from this page after saving.</p>';
      }
    };

    const stepFields = (s, i) => {
      const tplSel = `<select data-step="${i}" data-k="template_id">${opts(templates, s.template_id, { blank: '— choose template —' })}</select>`;
      switch (s.type) {
        case 'wait':
          return `<div class="row"><div class="field"><label>Wait</label><input type="number" min="0" data-step="${i}" data-k="amount" value="${esc(s.amount ?? 1)}"></div>
            <div class="field"><label>&nbsp;</label><select data-step="${i}" data-k="unit">${['minutes', 'hours', 'days'].map((u) => `<option ${(s.unit || 'days') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div></div>`;
        case 'send_email':
          return `<div class="field"><label>Template</label>${tplSel}</div>
            <div class="field"><label>Subject <span class="hint">(blank = template subject)</span></label><input type="text" data-step="${i}" data-k="subject" value="${esc(s.subject || '')}"></div>
            <label class="check"><input type="checkbox" data-step="${i}" data-k="reply_in_thread" ${s.reply_in_thread ? 'checked' : ''}> Send as a reply in the same thread ("Re: …")</label>`;
        case 'stop_if':
          return `<div class="field"><label>Stop the automation if the contact…</label><select data-step="${i}" data-k="condition">${[['replied', 'has replied'], ['opened', 'has opened an email'], ['clicked', 'has clicked a link'], ['not_opened', 'has NOT opened any email'], ['not_clicked', 'has NOT clicked'], ['unsubscribed', 'has unsubscribed']].map(([v, l]) => `<option value="${v}" ${s.condition === v ? 'selected' : ''}>${l}</option>`).join('')}</select><p class="hint">Checked since the contact entered this automation.</p></div>`;
        case 'add_tag':
        case 'remove_tag':
          return `<div class="field"><label>Tag</label><input type="text" data-step="${i}" data-k="tag" value="${esc(s.tag || '')}"></div>`;
        case 'add_to_list':
        case 'remove_from_list':
          return `<div class="field"><label>List</label><select data-step="${i}" data-k="list_id">${opts(lists, s.list_id, { blank: '— choose list —' })}</select></div>`;
        case 'update_field':
          return `<div class="row"><div class="field"><label>Field</label><select data-step="${i}" data-k="field">${['status', 'company', 'country', 'industry', 'phone', 'website', 'first_name', 'last_name'].map((x) => `<option ${s.field === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            <div class="field"><label>Value</label><input type="text" data-step="${i}" data-k="value" value="${esc(s.value || '')}"></div></div>`;
        case 'notify':
          return `<div class="row"><div class="field"><label>Notify email <span class="hint">(blank = sender address)</span></label><input type="email" data-step="${i}" data-k="email" value="${esc(s.email || '')}"></div>
            <div class="field"><label>Subject <span class="hint">(optional)</span></label><input type="text" data-step="${i}" data-k="subject" value="${esc(s.subject || '')}"></div></div>`;
        case 'webhook':
          return `<div class="field"><label>Webhook URL</label><input type="url" data-step="${i}" data-k="url" value="${esc(s.url || '')}" placeholder="https://hooks.zapier.com/…"></div>`;
        default:
          return '';
      }
    };

    const draw = () => {
      root.innerHTML = `
        <div class="page-head"><div><a href="#/automations">← Automations</a><h1>${a.id ? esc(a.name) : 'New automation'} ${statusBadge(a.status)}</h1></div>
          <div class="actions">${a.id ? '<button class="btn" id="enroll">Enrol contacts…</button>' : ''}<button class="btn" id="save">Save</button><button class="btn ${a.status === 'active' ? '' : 'success'}" id="toggle">${a.status === 'active' ? 'Save &amp; pause' : 'Save &amp; activate'}</button></div></div>
        <div class="card"><div class="field" style="max-width:480px"><label>Name</label><input type="text" id="a-name" value="${esc(a.name)}" placeholder="e.g. Follow up non-responders"></div>
          <label class="check"><input type="checkbox" id="a-stop" ${a.trigger_config.stop_on_reply ? 'checked' : ''}> Stop this automation for a contact as soon as they reply</label>
          <label class="check"><input type="checkbox" id="a-reentry" ${a.allow_reentry ? 'checked' : ''}> Allow a contact to go through this automation more than once</label></div>
        <div class="flow">
          <div class="node trigger"><div class="node-head"><span>⚡</span><span class="t">Trigger</span></div>
            <div class="field"><select id="a-trigger">${Object.entries(meta.triggers).map(([k, v]) => `<option value="${k}" ${a.trigger_type === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
            <div id="trigger-cfg">${triggerFields()}</div></div>
          ${a.steps.map((s, i) => `<div class="arrow">↓</div>
            <div class="node step"><div class="node-head"><span class="badge blue">${i + 1}</span><span class="t">${esc(meta.stepTypes[s.type] || s.type)}</span>
              <button class="btn icon sm" data-mv="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn icon sm" data-mv="${i}" data-d="1" ${i === a.steps.length - 1 ? 'disabled' : ''}>↓</button><button class="btn icon sm danger" data-rm="${i}">✕</button></div>
              ${stepFields(s, i)}</div>`).join('')}
          <div class="arrow">↓</div>
          <div class="node" style="border-style:dashed"><div class="row"><div class="field" style="margin:0"><select id="new-step">${Object.entries(meta.stepTypes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div><button class="btn primary" id="add-step">＋ Add step</button></div></div>
        </div>
        ${a.id ? `<div class="card" style="margin-top:20px"><h2>Recent runs</h2>${a.recent.length ? `<table class="data"><thead><tr><th>Contact</th><th>Status</th><th>Step</th><th>Next action</th><th>Log</th><th></th></tr></thead><tbody>
          ${a.recent.map((r) => `<tr><td>${esc(r.email)}</td><td>${statusBadge(r.status)}</td><td>${r.step_index + 1}</td><td class="nowrap">${r.status === 'active' ? fmtDate(r.next_run_at) : ''}</td>
            <td class="run-log">${r.log.slice(-4).map((l) => `${esc(l.type)}: ${esc(l.note || l.error || '')}`).join('<br>')}</td><td>${r.status === 'active' ? `<button class="btn sm" data-stop="${r.id}">Stop</button>` : ''}</td></tr>`).join('')}
          </tbody></table>` : '<p class="muted">No runs yet.</p>'}</div>` : ''}`;

      const sync = () => {
        a.name = root.querySelector('#a-name').value;
        a.trigger_config.stop_on_reply = root.querySelector('#a-stop').checked;
        a.allow_reentry = root.querySelector('#a-reentry').checked ? 1 : 0;
        root.querySelectorAll('[data-cfg]').forEach((el) => { a.trigger_config[el.dataset.cfg] = el.value; });
        root.querySelectorAll('[data-step]').forEach((el) => {
          a.steps[el.dataset.step][el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
        });
      };
      root.querySelector('#a-trigger').onchange = (e) => {
        sync();
        a.trigger_type = e.target.value;
        a.trigger_config = { stop_on_reply: a.trigger_config.stop_on_reply };
        draw();
      };
      root.querySelector('#add-step').onclick = () => {
        sync();
        const type = root.querySelector('#new-step').value;
        a.steps.push({ type, ...(type === 'wait' ? { amount: 1, unit: 'days' } : {}), ...(type === 'stop_if' ? { condition: 'replied' } : {}) });
        draw();
      };
      root.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { sync(); a.steps.splice(Number(b.dataset.rm), 1); draw(); }));
      root.querySelectorAll('[data-mv]').forEach((b) => (b.onclick = () => {
        sync();
        const i = Number(b.dataset.mv);
        const j = i + Number(b.dataset.d);
        [a.steps[i], a.steps[j]] = [a.steps[j], a.steps[i]];
        draw();
      }));
      root.querySelectorAll('[data-stop]').forEach((b) => (b.onclick = async () => { await api.post(`/automation-runs/${b.dataset.stop}/stop`); App.navigate(); }));
      const save = async (status) => {
        sync();
        const body = { name: a.name || 'Untitled automation', trigger_type: a.trigger_type, trigger_config: a.trigger_config, steps: a.steps, status: status || a.status, allow_reentry: a.allow_reentry };
        const saved = a.id ? await api.put(`/automations/${a.id}`, body) : await api.post('/automations', body);
        toast(`Automation saved${saved.status === 'active' ? ' and active' : ''}`);
        location.hash = `#/automations/${saved.id}`;
        if (a.id) App.navigate();
      };
      root.querySelector('#save').onclick = () => save();
      root.querySelector('#toggle').onclick = () => save(a.status === 'active' ? 'paused' : 'active');
      root.querySelector('#enroll')?.addEventListener('click', () => modal(`<h2>Enrol contacts</h2><p class="hint">Start this automation now for every subscribed contact in a list.</p>
        <div class="field"><label>List</label><select id="el">${opts(lists, '', {})}</select></div>
        <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Enrol</button></div>`, {
        onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
          await api.post(`/automations/${a.id}/enroll`, { list_id: el.querySelector('#el').value });
          toast(`Enrolment queued${a.status === 'active' ? '' : ' (activate the automation to start processing)'}`);
          close();
          App.navigate();
        }),
      }));
    };
    draw();
  });

  // ================================================================ Contacts
  route(/^#\/contacts(?:\?(.*))?$/, async (root, qs) => {
    const params = new URLSearchParams(qs || '');
    const [lists, facets] = await Promise.all([api.get('/lists'), api.get('/contacts/facets')]);
    let page = 1;
    root.innerHTML = `
      <div class="page-head"><h1>Contacts</h1><div class="actions">
        <button class="btn" id="export">⬇ Export CSV</button><button class="btn" id="import">⬆ Import CSV</button><a class="btn" href="#/leads">🔎 Find leads</a><button class="btn primary" id="add">＋ Add contact</button></div></div>
      <div class="card"><div class="row" id="filters">
        <div class="field"><label>Search</label><input type="search" name="q" placeholder="Email, name, company" value="${esc(params.get('q') || '')}"></div>
        <div class="field"><label>List</label><select name="list_id">${opts(lists, params.get('list_id'), { blank: 'All lists' })}</select></div>
        <div class="field"><label>Country</label><select name="country"><option value="">All</option>${facets.countries.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label>Industry</label><select name="industry"><option value="">All</option>${facets.industries.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label>Tag</label><select name="tag"><option value="">All</option>${facets.tags.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label>Status</label><select name="status"><option value="">All</option><option>subscribed</option><option>unsubscribed</option><option>bounced</option></select></div>
      </div></div>
      <div class="card table-wrap"><div class="row" style="align-items:center;margin-bottom:10px" id="bulk">
        <strong id="count"></strong><span class="spacer"></span>
        <select id="bulk-action" style="width:auto"><option value="">Bulk action…</option><option value="add_to_list">Add to list</option><option value="remove_from_list">Remove from list</option><option value="add_tag">Add tag</option><option value="unsubscribe">Unsubscribe</option><option value="resubscribe">Resubscribe</option><option value="delete">Delete</option></select>
        <select id="bulk-list" style="width:auto;display:none">${opts(lists, '')}</select><input type="text" id="bulk-tag" placeholder="tag" style="width:140px;display:none">
        <button class="btn" id="bulk-go">Apply to selected</button></div>
        <div id="table"></div>
        <div class="row" style="justify-content:center;margin-top:12px"><button class="btn sm" id="prev">← Prev</button><span id="pageinfo" class="muted"></span><button class="btn sm" id="next">Next →</button></div></div>`;
    const filters = root.querySelector('#filters');
    const query = () => {
      const f = formData(filters);
      return new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    };
    let total = 0;
    const load = async () => {
      const r = await api.get(`/contacts?${query()}&page=${page}&limit=50`);
      if (!root.querySelector('#count')) return; // user navigated away meanwhile
      total = r.total;
      root.querySelector('#count').textContent = `${r.total} contacts`;
      root.querySelector('#pageinfo').textContent = `Page ${page} of ${Math.max(1, Math.ceil(r.total / 50))}`;
      const listName = Object.fromEntries(lists.map((l) => [l.id, l.name]));
      root.querySelector('#table').innerHTML = r.rows.length ? `<table class="data"><thead><tr><th><input type="checkbox" id="all"></th><th>Email</th><th>Name</th><th>Company</th><th>Country</th><th>Industry</th><th>Lists / tags</th><th>Status</th></tr></thead><tbody>
        ${r.rows.map((c) => `<tr><td><input type="checkbox" class="sel" value="${esc(c.id)}"></td><td><a href="#/contacts/${encodeURIComponent(c.id)}">${esc(c.email)}</a>${c.replied_at ? ' <span class="badge yellow">replied</span>' : ''}</td>
          <td>${esc([c.first_name, c.last_name].join(' '))}</td><td>${esc(c.company)}</td><td>${esc(c.country)}</td><td>${esc(c.industry)}</td>
          <td>${(c.list_ids || []).map((id) => `<span class="badge">${esc(listName[id] || id)}</span>`).join(' ')} ${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td><td>${statusBadge(c.status)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No contacts match. Import a CSV or use the Lead Finder.</div>';
      root.querySelector('#all')?.addEventListener('change', (e) => root.querySelectorAll('.sel').forEach((x) => { x.checked = e.target.checked; }));
    };
    filters.addEventListener('input', App.debounce(() => { page = 1; load(); }, 300));
    filters.addEventListener('change', () => { page = 1; load(); });
    root.querySelector('#prev').onclick = () => { if (page > 1) { page--; load(); } };
    root.querySelector('#next').onclick = () => { if (page * 50 < total) { page++; load(); } };
    root.querySelector('#bulk-action').onchange = (e) => {
      root.querySelector('#bulk-list').style.display = e.target.value.includes('list') ? '' : 'none';
      root.querySelector('#bulk-tag').style.display = e.target.value === 'add_tag' ? '' : 'none';
    };
    root.querySelector('#bulk-go').onclick = async () => {
      const ids = [...root.querySelectorAll('.sel:checked')].map((x) => x.value);
      const action = root.querySelector('#bulk-action').value;
      if (!ids.length || !action) return toast('Select contacts and an action', 'error');
      if (action === 'delete' && !(await confirmDialog(`Delete ${ids.length} contacts?`))) return;
      await api.post('/contacts/bulk', { ids, action, list_id: root.querySelector('#bulk-list').value, tag: root.querySelector('#bulk-tag').value });
      toast('Done');
      load();
    };
    root.querySelector('#export').onclick = async () => {
      const r = await api.post('/contacts/export', Object.fromEntries(new URLSearchParams(query())));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
      a.download = 'contacts.csv';
      a.click();
      toast(`Exported ${r.count} contacts`);
    };
    root.querySelector('#add').onclick = () => contactModal(null, lists, load);
    root.querySelector('#import').onclick = () => importModal(lists, load);
    load();
  });

  function contactModal(c, lists, done) {
    c = c || { email: '', first_name: '', last_name: '', company: '', website: '', phone: '', country: '', industry: '', tags: [], list_ids: [], status: 'subscribed' };
    modal(`<h2>${c.id ? 'Edit contact' : 'Add contact'}</h2><div id="cf">
      <div class="field"><label>Email *</label><input type="email" name="email" value="${esc(c.email)}"></div>
      <div class="row"><div class="field"><label>First name</label><input type="text" name="first_name" value="${esc(c.first_name)}"></div><div class="field"><label>Last name</label><input type="text" name="last_name" value="${esc(c.last_name)}"></div></div>
      <div class="row"><div class="field"><label>Company</label><input type="text" name="company" value="${esc(c.company)}"></div><div class="field"><label>Website</label><input type="text" name="website" value="${esc(c.website)}"></div></div>
      <div class="row"><div class="field"><label>Country</label><input type="text" name="country" value="${esc(c.country)}"></div><div class="field"><label>Industry</label><input type="text" name="industry" value="${esc(c.industry)}"></div></div>
      <div class="row"><div class="field"><label>Phone</label><input type="text" name="phone" value="${esc(c.phone)}"></div><div class="field"><label>Status</label><select name="status">${['subscribed', 'unsubscribed', 'bounced'].map((s) => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
      <div class="field"><label>Tags <span class="hint">(comma separated)</span></label><input type="text" name="tags" value="${esc(c.tags.join(', '))}"></div>
      <div class="field"><label>Lists</label>${lists.map((l) => `<label class="check"><input type="checkbox" name="list_ids" data-group value="${l.id}" ${c.list_ids.includes(l.id) ? 'checked' : ''}>${esc(l.name)}</label>`).join('') || '<span class="muted">No lists</span>'}</div>
      </div><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Save</button></div>`, {
      onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
        const data = formData(el.querySelector('#cf'));
        data.list_ids = data.list_ids || [];
        const saved = c.id ? await api.put(`/contacts/${encodeURIComponent(c.id)}`, data) : await api.post('/contacts', data);
        close();
        toast('Contact saved');
        done(saved);
      }),
    });
  }

  function importModal(lists, done) {
    modal(`<h2>Import contacts from CSV</h2>
      <p class="hint">The first row must contain column names. Recognised columns: email, first name, last name, name, company, website, phone, country, industry, tags. Existing contacts are updated (empty fields filled, tags merged).</p>
      <div class="field"><label>CSV file</label><input type="file" id="file" accept=".csv,text/csv,text/plain"></div>
      <div class="field"><label>…or paste CSV</label><textarea id="csv" class="code" rows="5" placeholder="email,first name,company,country&#10;jane@acme.com,Jane,Acme,Malaysia"></textarea></div>
      <div class="row"><div class="field"><label>Add to list</label><select id="list">${opts(lists, '', { blank: '— none —' })}</select></div>
        <div class="field"><label>or create new list</label><input type="text" id="newlist" placeholder="New list name"></div></div>
      <div class="row"><div class="field"><label>Tags for all rows</label><input type="text" id="tags" placeholder="e.g. expo-2026"></div>
        <div class="field"><label>Default country</label><input type="text" id="country"></div><div class="field"><label>Default industry</label><input type="text" id="industry"></div></div>
      <label class="check"><input type="checkbox" id="consent"> I confirm these contacts have agreed to receive email from us, or I have another lawful basis (e.g. legitimate interest for B2B under GDPR / PDPA).</label>
      <div id="result"></div>
      <div class="foot"><button class="btn" data-close>Close</button><button class="btn primary" id="go">Import</button></div>`, {
      onMount: (el) => (el.querySelector('#go').onclick = async () => {
        if (!el.querySelector('#consent').checked) return toast('Please confirm you have permission to email these contacts', 'error');
        const fd = new FormData();
        const file = el.querySelector('#file').files[0];
        if (file) fd.append('file', file);
        else fd.append('csv', el.querySelector('#csv').value);
        let listId = el.querySelector('#list').value;
        const newName = el.querySelector('#newlist').value.trim();
        if (newName) listId = (await api.post('/lists', { name: newName })).id;
        if (listId) fd.append('list_id', listId);
        for (const k of ['tags', 'country', 'industry']) fd.append(k, el.querySelector(`#${k}`).value);
        const r = await api('POST', '/contacts/import', fd);
        el.querySelector('#result').innerHTML = `<div class="banner info">Imported ${r.total} rows: <strong>${r.created}</strong> new, <strong>${r.updated}</strong> updated, ${r.skipped} skipped.${r.errors.length ? `<br><span class="mono">${r.errors.map(esc).join('<br>')}</span>` : ''}</div>`;
        done();
      }),
    });
  }

  route(/^#\/contacts\/([^?]+)$/, async (root, rawId) => {
    const id = encodeURIComponent(decodeURIComponent(rawId));
    const [c, lists] = await Promise.all([api.get(`/contacts/${id}`), api.get('/lists')]);
    root.innerHTML = `
      <div class="page-head"><div><a href="#/contacts">← Contacts</a><h1>${esc(c.email)} ${statusBadge(c.status)}</h1></div>
        <div class="actions"><button class="btn" id="edit">Edit</button><button class="btn danger" id="del">Delete</button></div></div>
      <div class="grid cols-3">
        <div class="card"><h2>Profile</h2>${[['Name', `${c.first_name} ${c.last_name}`], ['Company', c.company], ['Website', c.website], ['Phone', c.phone], ['Country', c.country], ['Industry', c.industry], ['Source', c.source], ['Added', fmtDate(c.created_at)], ['Last reply', fmtDate(c.replied_at)]]
          .map(([k, v]) => `<div style="margin-bottom:6px"><span class="muted">${k}:</span> ${esc(v || '—')}</div>`).join('')}
          <div>${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
        <div class="card" style="grid-column:span 2"><h2>Emails</h2>${c.messages.length ? `<table class="data"><thead><tr><th>Subject</th><th>Campaign</th><th>Status</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Replied</th></tr></thead><tbody>
          ${c.messages.map((m) => `<tr><td>${esc(m.subject)}</td><td>${esc(m.campaign || 'automation')}</td><td>${statusBadge(m.status)}</td><td class="nowrap">${fmtDate(m.sent_at)}</td><td>${m.opened_at ? '✓' : ''}</td><td>${m.clicked_at ? '✓' : ''}</td><td>${m.replied_at ? '✓' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No emails sent yet.</p>'}
          <h2 style="margin-top:16px">Replies</h2>${c.replies.length ? c.replies.map((r) => `<div><strong>${esc(r.subject)}</strong> <span class="muted">${fmtDate(r.received_at)}</span><div class="reply-body">${esc(r.body)}</div></div>`).join('') : '<p class="muted">No replies.</p>'}
        </div></div>`;
    root.querySelector('#edit').onclick = () => contactModal(c, lists, (saved) => { location.hash = `#/contacts/${encodeURIComponent(saved?.id || c.id)}`; App.navigate(); });
    root.querySelector('#del').onclick = async () => {
      if (await confirmDialog('Delete this contact?')) { await api.del(`/contacts/${id}`); location.hash = '#/contacts'; }
    };
  });

  // ================================================================ Lists
  route(/^#\/lists$/, async (root) => {
    const lists = await api.get('/lists');
    root.innerHTML = `
      <div class="page-head"><h1>Lists</h1><div class="actions"><button class="btn primary" id="new">＋ New list</button></div></div>
      <div class="card table-wrap">${lists.length ? `<table class="data"><thead><tr><th>Name</th><th>Description</th><th class="right">Contacts</th><th class="right">Subscribed</th><th>Created</th><th></th></tr></thead><tbody>
        ${lists.map((l) => `<tr><td><a href="#/contacts?list_id=${l.id}">${esc(l.name)}</a></td><td class="muted">${esc(l.description)}</td><td class="right">${l.contacts}</td><td class="right">${l.subscribed || 0}</td><td>${fmtDate(l.created_at)}</td>
          <td class="nowrap"><button class="btn sm" data-edit="${l.id}">Rename</button> <button class="btn sm danger" data-del="${l.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No lists yet.</div>'}</div>`;
    const edit = (l) => modal(`<h2>${l ? 'Edit list' : 'New list'}</h2><div class="field"><label>Name</label><input type="text" id="n" value="${esc(l?.name || '')}"></div>
      <div class="field"><label>Description</label><input type="text" id="d" value="${esc(l?.description || '')}"></div>
      <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Save</button></div>`, {
      onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
        const body = { name: el.querySelector('#n').value, description: el.querySelector('#d').value };
        if (l) await api.put(`/lists/${l.id}`, body);
        else await api.post('/lists', body);
        close();
        App.navigate();
      }),
    });
    root.querySelector('#new').onclick = () => edit(null);
    root.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => edit(lists.find((l) => String(l.id) === b.dataset.edit))));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (await confirmDialog('Delete this list? Contacts are kept.')) { await api.del(`/lists/${b.dataset.del}`); App.navigate(); }
    }));
  });

  // ================================================================ Lead finder
  route(/^#\/leads$/, async (root) => {
    const [meta, searches, settings] = await Promise.all([App.getMeta(), api.get('/leads/searches'), api.get('/settings')]);
    const hasHunter = !!settings.hunter_api_key;
    const hasApollo = !!settings.apollo_api_key;
    root.innerHTML = `
      <div class="page-head"><h1>Lead Finder</h1></div>
      ${workerBanner(meta)}
      <div class="banner info">Find publicly listed business emails by <strong>country</strong> and <strong>industry</strong>: search the web and crawl company websites (robots.txt respected), or query B2B data portals (Hunter.io, Apollo.io) with your API keys.
        Only email people you have a lawful basis to contact, include an unsubscribe link (added automatically), and follow local rules (GDPR, PDPA, CAN-SPAM, CASL).</div>
      <div class="card" id="lf">
        <div class="field"><label>Countries <span class="hint" id="cc"></span></label><input type="search" id="cfilter" placeholder="Filter countries…" style="margin-bottom:6px">${chips('countries', meta.countries.map((c) => ({ value: c.code, label: c.name })))}</div>
        <div class="field"><label>Industries</label>${chips('industries', meta.industries)}
          <input type="text" id="custom-ind" placeholder="Add a custom industry and press Enter" style="margin-top:6px"></div>
        <div class="row"><div class="field"><label>Extra keywords <span class="hint">(optional)</span></label><input type="text" name="keywords" placeholder="e.g. SME, distributor, Kuala Lumpur"></div>
          <div class="field" style="max-width:150px"><label>Max emails</label><input type="number" name="limit" value="100" min="1" max="1000"></div>
          <div class="field" style="max-width:150px"><label>Emails per company</label><input type="number" name="perSiteMaxEmails" value="3" min="1" max="20"></div>
          <div class="field" style="max-width:150px"><label>Search pages</label><input type="number" name="pages" value="2" min="1" max="5"></div></div>
        <div class="field"><label>Sources</label>
          <label class="check"><input type="checkbox" name="sources" data-group value="web" checked> Web search + crawl websites ${settings.google_cse_key ? '(Google)' : '(DuckDuckGo)'}</label>
          <label class="check"><input type="checkbox" name="sources" data-group value="hunter" ${hasHunter ? 'checked' : 'disabled'}> Hunter.io ${hasHunter ? '' : '<span class="hint">(add API key in Settings)</span>'}</label>
          <label class="check"><input type="checkbox" name="sources" data-group value="apollo" ${hasApollo ? 'checked' : 'disabled'}> Apollo.io ${hasApollo ? '' : '<span class="hint">(add API key in Settings)</span>'}</label>
          <label class="check"><input type="checkbox" name="sources" data-group value="urls" id="src-urls"> Crawl specific websites / directory pages</label></div>
        <div class="field" id="urls-field" style="display:none"><label>Websites to crawl <span class="hint">(one per line)</span></label><textarea name="urls" rows="4" placeholder="https://company-a.com&#10;company-b.com.my"></textarea></div>
        <button class="btn primary" id="go">🔎 Start search</button>
      </div>
      <div class="card table-wrap"><h2>Searches</h2>${searches.length ? `<table class="data"><thead><tr><th>#</th><th>Countries</th><th>Industries</th><th>Status</th><th class="right">Emails</th><th>Started</th><th></th></tr></thead><tbody>
        ${searches.map((s) => `<tr><td><a href="#/leads/${s.id}">#${s.id}</a></td><td>${esc((s.params.countries || []).join(', ') || '—')}</td><td>${esc((s.params.industries || []).join(', ') || s.params.keywords || '—')}</td>
          <td>${statusBadge(s.status)}</td><td class="right">${s.results_count}</td><td>${fmtDate(s.created_at)}</td><td><a class="btn sm" href="#/leads/${s.id}">Open</a></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No searches yet.</p>'}</div>`;
    const lf = root.querySelector('#lf');
    const cchips = lf.querySelector('[data-chips="countries"]');
    const countCountries = () => { lf.querySelector('#cc').textContent = `${chipValues(lf, 'countries').length} selected`; };
    cchips.addEventListener('change', countCountries);
    countCountries();
    lf.querySelector('#cfilter').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      cchips.querySelectorAll('.chip').forEach((c) => { c.style.display = c.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    };
    lf.querySelector('#custom-ind').onkeydown = (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      const chip = document.createElement('span');
      chip.className = 'chip on';
      chip.dataset.value = chip.textContent = e.target.value.trim();
      lf.querySelector('[data-chips="industries"]').prepend(chip);
      e.target.value = '';
    };
    lf.querySelector('#src-urls').onchange = (e) => { lf.querySelector('#urls-field').style.display = e.target.checked ? '' : 'none'; };
    lf.querySelector('#go').onclick = async () => {
      const data = formData(lf);
      data.countries = chipValues(lf, 'countries');
      data.industries = chipValues(lf, 'industries');
      const r = await api.post('/leads/search', data);
      location.hash = `#/leads/${r.id}`;
    };
  });

  route(/^#\/leads\/([\w-]+)$/, async (root, id) => {
    const lists = await api.get('/lists');
    let timer;
    const draw = async () => {
      const s = await api.get(`/leads/searches/${id}`);
      // Keep selections and typed values across auto-refreshes.
      const keepChecked = new Set([...root.querySelectorAll('.sel:checked')].map((x) => x.value));
      const keep = Object.fromEntries(['list', 'newlist', 'tags'].map((k) => [k, root.querySelector(`#${k}`)?.value || '']));
      root.innerHTML = `
        <div class="page-head"><div><a href="#/leads">← Lead Finder</a><h1>Search #${s.id} ${statusBadge(s.status)}</h1>
          <div class="muted">${esc([(s.params.countries || []).join(', '), (s.params.industries || []).join(', '), s.params.keywords].filter(Boolean).join(' · '))}</div></div>
          <div class="actions"><button class="btn danger" id="del">Delete search</button></div></div>
        <div class="card"><strong>${s.leads.length} emails found.</strong> <span class="muted">${esc(s.progress || '')}</span>
          ${s.status === 'running' ? '<div class="progress" style="margin-top:8px"><div style="width:100%;opacity:.5;animation:none"></div></div>' : ''}
          ${s.error ? `<details style="margin-top:8px"><summary class="muted">Warnings</summary><pre class="mono">${esc(s.error)}</pre></details>` : ''}</div>
        <div class="card table-wrap" id="leads-table"><div class="row" style="align-items:center;margin-bottom:10px">
          <label class="check"><input type="checkbox" id="all"> Select all new</label><span class="spacer"></span>
          <select id="list" style="width:auto">${opts(lists, '', { blank: '— add to list —' })}</select><input type="text" id="newlist" placeholder="or new list name" style="width:180px">
          <input type="text" id="tags" placeholder="tags" style="width:140px"><button class="btn primary" id="imp">Import selected</button></div>
          ${s.leads.length ? `<table class="data"><thead><tr><th></th><th>Email</th><th>Name / position</th><th>Company</th><th>Country</th><th>Industry</th><th>Source</th></tr></thead><tbody>
          ${s.leads.map((l) => `<tr><td><input type="checkbox" class="sel" value="${esc(l.id)}" ${l.imported || l.in_contacts ? 'disabled' : ''} ${keepChecked.has(String(l.id)) ? 'checked' : ''}></td>
            <td>${esc(l.email)} ${l.imported ? '<span class="badge green">imported</span>' : l.in_contacts ? '<span class="badge">in contacts</span>' : ''}</td>
            <td>${esc([l.first_name, l.last_name].join(' '))}<div class="muted" style="font-size:12px">${esc(l.position)}</div></td>
            <td>${esc(l.company)}<div class="muted" style="font-size:12px">${l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener">${esc(l.website.replace(/^https?:\/\//, ''))}</a>` : ''}</div></td>
            <td>${esc(l.country)}</td><td>${esc(l.industry)}</td><td><span class="badge">${esc(l.source)}</span>${l.source_url && /^https?:/.test(l.source_url) ? `<div><a class="muted" style="font-size:12px" href="${esc(l.source_url)}" target="_blank" rel="noopener">page</a></div>` : ''}</td></tr>`).join('')}
          </tbody></table>` : `<div class="empty">${s.status === 'running' ? 'Searching… results appear here as they are found.' : 'No emails found. Try other industries / keywords, more search pages, or add a data portal API key.'}</div>`}</div>`;
      for (const [k, v] of Object.entries(keep)) root.querySelector(`#${k}`).value = v;
      root.querySelector('#all').onchange = (e) => root.querySelectorAll('.sel:not(:disabled)').forEach((x) => { x.checked = e.target.checked; });
      root.querySelector('#del').onclick = async () => {
        if (await confirmDialog('Delete this search and its results?')) { await api.del(`/leads/searches/${id}`); location.hash = '#/leads'; }
      };
      root.querySelector('#imp').onclick = async () => {
        const ids = [...root.querySelectorAll('.sel:checked')].map((x) => x.value);
        if (!ids.length) return toast('Select leads to import', 'error');
        let listId = root.querySelector('#list').value;
        const newName = root.querySelector('#newlist').value.trim();
        if (newName) listId = (await api.post('/lists', { name: newName })).id;
        const r = await api.post(`/leads/searches/${id}/import`, { lead_ids: ids, list_id: listId, tags: root.querySelector('#tags').value });
        toast(`${r.created} new contacts, ${r.updated} updated`);
        draw();
      };
      if (s.status !== 'running') clearInterval(timer);
    };
    await draw();
    timer = setInterval(draw, 4000);
    return () => clearInterval(timer);
  });

  // ================================================================ Replies
  route(/^#\/replies$/, async (root) => {
    const [meta, list] = await Promise.all([App.getMeta(true), api.get('/replies')]);
    root.innerHTML = `
      <div class="page-head"><h1>Replies</h1><div class="actions"><button class="btn" id="log">＋ Log a reply manually</button><button class="btn primary" id="poll" ${meta.workerConfigured ? '' : 'disabled'}>↻ Check Gmail now</button></div></div>
      ${workerBanner(meta)}<p class="muted">Replies are read from your Gmail inbox every 5 minutes and matched to the email they answer.</p>
      <div class="card">${list.length ? list.map((r) => `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
        <div class="row" style="align-items:center"><strong>${r.contact_id ? `<a href="#/contacts/${r.contact_id}">${esc([r.first_name, r.last_name].join(' ').trim() || r.from_email)}</a>` : esc(r.from_email)}</strong>
        <span class="muted">${esc(r.from_email)} · ${esc(r.company || '')}</span><span class="spacer"></span><span class="muted">${fmtDate(r.received_at)}</span></div>
        <div><strong>${esc(r.subject)}</strong> ${r.campaign ? `<span class="badge">${esc(r.campaign)}</span>` : ''}</div>
        <div class="reply-body">${esc(r.body || '')}</div></div>`).join('') : '<div class="empty">No replies yet.</div>'}</div>`;
    root.querySelector('#poll').onclick = async () => {
      const r = await api.post('/replies/poll');
      toast(`${r.found} new repl${r.found === 1 ? 'y' : 'ies'}`);
      App.navigate();
    };
    root.querySelector('#log').onclick = () => modal(`<h2>Log a reply</h2><p class="hint">Record a reply received elsewhere (phone, WhatsApp, another inbox). Reply automations will run.</p>
      <div class="field"><label>From (contact email)</label><input type="email" id="f"></div><div class="field"><label>Subject</label><input type="text" id="s"></div>
      <div class="field"><label>Message</label><textarea id="t"></textarea></div><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Save</button></div>`, {
      onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
        await api.post('/replies', { from: el.querySelector('#f').value, subject: el.querySelector('#s').value, text: el.querySelector('#t').value });
        close();
        toast('Reply logged - it appears here once the worker processes it.');
        App.navigate();
      }),
    });
  });

  // ================================================================ Settings
  route(/^#\/settings$/, async (root) => {
    const [s, meta] = await Promise.all([api.get('/settings'), App.getMeta(true)]);
    const st = s.status || {};
    const input = (k, label, type = 'text', hint = '') => `<div class="field"><label>${label} ${hint ? `<span class="hint">${hint}</span>` : ''}</label><input type="${type}" name="${k}" value="${esc(s[k] ?? '')}" autocomplete="off"></div>`;
    root.innerHTML = `
      <div class="page-head"><h1>Settings</h1><div class="actions"><button class="btn primary" id="save">Save settings</button></div></div>
      <div class="grid cols-2" id="settings">
        <div class="card"><h2>Sender</h2>
          <div class="field"><label>Sending account</label><input type="text" value="${esc(meta.account || 'not connected yet')}" disabled>
            <p class="hint">Emails are sent from the Google account that owns the Apps Script worker (via Gmail). To send from an alias, add it in Gmail settings → Accounts → "Send mail as".</p></div>
          ${input('from_name', 'From name')}${input('reply_to', 'Reply-to', 'email', '(optional)')}
          ${input('company_address', 'Company postal address', 'text', '(required by CAN-SPAM; shown in footers)')}</div>
        <div class="card"><h2>Sending limits</h2>
          ${input('daily_limit', 'Max emails per day', 'number', '(free Gmail ≈ 100, Google Workspace ≈ 1,500)')}
          ${input('per_run_limit', 'Max emails per 5-minute run', 'number', '(spreads sending out, protects your reputation)')}
          <div class="field"><label>Dry-run mode</label><select name="dry_run"><option value="false" ${!s.dry_run ? 'selected' : ''}>Off - deliver emails</option><option value="true" ${s.dry_run ? 'selected' : ''}>On - record but do not deliver</option></select></div>
          <p class="hint">Today: ${meta.remainingToday ?? '?'} emails left.</p></div>
        <div class="card"><h2>Worker (Google Apps Script)</h2>
          <p class="hint">Sends email through Gmail, reads replies from your inbox, runs automations, crawls leads and records opens. <code>setup()</code> fills these in automatically.</p>
          ${input('tracking_url', 'Apps Script web app URL', 'url', '(…/exec)')}
          ${input('site_url', 'Firebase Hosting URL', 'url', '(used for click and unsubscribe links)')}
          <p class="hint">Last run: ${st.last_tick ? fmtDate(st.last_tick) : 'never'} · Last Gmail check: ${st.last_reply_poll ? fmtDate(st.last_reply_poll) : 'never'}</p>
          ${st.last_summary ? `<p class="hint mono">${esc(st.last_summary)}</p>` : ''}
          <button class="btn" id="check">Check worker connection</button> <button class="btn" id="run">Run worker now</button></div>
        <div class="card"><h2>Lead finder sources</h2>
          <p class="hint">Without keys, the Lead Finder uses DuckDuckGo search and crawls public company websites. Google Programmable Search gives 100 free queries/day.</p>
          ${input('hunter_api_key', 'Hunter.io API key', 'password', '(hunter.io → API)')}
          ${input('apollo_api_key', 'Apollo.io API key', 'password', '(apollo.io → Settings → API)')}
          ${input('google_cse_key', 'Google Programmable Search API key', 'password')}
          ${input('google_cse_cx', 'Google Search engine ID (cx)')}
          ${input('crawler_user_agent', 'Crawler User-Agent', 'text', '(identify yourself to websites)')}</div>
      </div>`;
    const save = async () => {
      await api.put('/settings', formData(root.querySelector('#settings')));
      await App.getMeta(true);
      toast('Settings saved');
    };
    root.querySelector('#save').onclick = save;
    root.querySelector('#check').onclick = async () => { await save(); const r = await api.post('/settings/check'); toast(r.message, r.ok ? 'info' : 'error'); };
    root.querySelector('#run').onclick = async () => {
      toast('Running the worker…');
      const r = await api.post('/replies/poll');
      toast(`Worker finished: ${JSON.stringify(r.summary || {})}`);
      App.navigate();
    };
  });

})();
