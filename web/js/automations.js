/*
 * Automations: recipe gallery + visual step builder.
 * Triggers / steps are described in shared/catalog.js; this file renders
 * their settings, plain-language summaries and ready-made recipes.
 */
(() => {
  const { api, esc, toast, modal, confirmDialog, fmtDate, statusBadge, icon } = App;
  const C = () => window.EmailCatalog;
  const opts = (items, selected, blank) =>
    (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
    items.map((i) => `<option value="${esc(i.id)}" ${String(i.id) === String(selected ?? '') ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
  const short = (t, n = 48) => (String(t || '').length > n ? `${String(t).slice(0, n)}…` : String(t || ''));
  const toneFor = (group) => ({ Email: '', WhatsApp: 'wa', Contact: 'violet', Contacts: 'violet', 'Timing & logic': 'orange', 'Team & integrations': 'gray', Integrations: 'gray' }[group] || '');

  // ------------------------------------------------------------------ recipes
  const RECIPES = [
    {
      key: 'follow_up', title: 'Follow up if no reply', icon: 'reply',
      desc: 'After a campaign email, wait 3 days and send a threaded follow-up to people who did not reply.',
      trigger_type: 'email_sent', trigger_config: { stop_on_reply: true },
      steps: (t) => [{ type: 'wait', amount: 3, unit: 'days' }, { type: 'stop_if', condition: 'replied' }, { type: 'send_email', template_id: t('Personal Follow-up'), reply_in_thread: true },
        { type: 'wait', amount: 4, unit: 'days' }, { type: 'stop_if', condition: 'replied' }, { type: 'add_tag', tag: 'no-response' }],
    },
    {
      key: 'whatsapp_nudge', title: 'Email, then WhatsApp nudge', icon: 'whatsapp',
      desc: 'If a contact has not opened your email after 2 days, send them a short WhatsApp message.',
      trigger_type: 'email_sent', trigger_config: { stop_on_reply: true },
      steps: () => [{ type: 'wait', amount: 2, unit: 'days' }, { type: 'stop_if', condition: 'opened' },
        { type: 'send_whatsapp', text: 'Hi {{first_name|there}}, this is {{sender_name}}. I just sent you an email - did you get a chance to look at it? 🙂' }],
    },
    {
      key: 'hot_lead', title: 'Hot lead alert on WhatsApp', icon: 'bell',
      desc: 'When a reply mentions pricing or a meeting, tag the contact and alert your sales team on WhatsApp.',
      trigger_type: 'reply_received', trigger_config: { keywords: 'interested, pricing, price, quote, call, meeting' },
      steps: () => [{ type: 'add_tag', tag: 'hot-lead' }, { type: 'notify', channel: 'whatsapp', whatsapp: '', subject: '🔥 Hot lead replied' }],
    },
    {
      key: 'auto_reply', title: 'Thank people who reply', icon: 'mail',
      desc: 'Auto-respond to every reply in the same thread and notify your team by email.',
      trigger_type: 'reply_received', trigger_config: {},
      steps: (t) => [{ type: 'add_tag', tag: 'replied' }, { type: 'send_email', template_id: t('Thank You for Your Reply'), reply_in_thread: true }, { type: 'notify', channel: 'email' }],
    },
    {
      key: 'welcome', title: 'Welcome new subscribers', icon: 'user-plus',
      desc: 'When someone joins a list, send a welcome email, then your newsletter two days later.',
      trigger_type: 'contact_added', trigger_config: {},
      steps: (t) => [{ type: 'send_email', template_id: t('Welcome Email') }, { type: 'wait', amount: 2, unit: 'days' }, { type: 'send_email', template_id: t('Monthly Newsletter') }],
    },
    {
      key: 'click_to_chatdaddy', title: 'Clicked → ChatDaddy follow-up', icon: 'pointer',
      desc: 'When someone clicks a link, sync them to ChatDaddy with a tag and start a WhatsApp conversation.',
      trigger_type: 'link_clicked', trigger_config: {},
      steps: () => [{ type: 'add_tag', tag: 'clicked' }, { type: 'chatdaddy_contact', tags: 'email-clicked' },
        { type: 'send_whatsapp', provider: 'chatdaddy', text: 'Hi {{first_name|there}}! Thanks for checking out our email. Any questions I can help with?' }],
    },
    {
      key: 'whatsapp_inbound', title: 'WhatsApp message → lead', icon: 'message',
      desc: 'When someone messages you on WhatsApp (ChatDaddy), tag them, add them to a list and alert your team.',
      trigger_type: 'whatsapp_received', trigger_config: {},
      steps: () => [{ type: 'add_tag', tag: 'whatsapp-lead' }, { type: 'add_to_list', list_id: '' }, { type: 'notify', channel: 'email' }],
    },
    {
      key: 'form_lead', title: 'Website form → email + WhatsApp', icon: 'webhook',
      desc: 'When your form or Zapier posts a lead to the webhook, welcome them by email and WhatsApp.',
      trigger_type: 'webhook_received', trigger_config: { event: 'form_submitted' },
      steps: (t) => [{ type: 'send_email', template_id: t('Welcome Email') }, { type: 'wait', amount: 10, unit: 'minutes' },
        { type: 'send_whatsapp', text: 'Hi {{first_name|there}}, thanks for reaching out! I just emailed you the details.' }, { type: 'notify', channel: 'email' }],
    },
    {
      key: 'reengage', title: 'Re-engage a list', icon: 'refresh',
      desc: 'Enrol a list manually: send an email, and a second one 5 days later to people who did not open.',
      trigger_type: 'manual', trigger_config: { stop_on_reply: true },
      steps: (t) => [{ type: 'send_email', template_id: t('Promotion') }, { type: 'wait', amount: 5, unit: 'days' }, { type: 'stop_if', condition: 'opened' }, { type: 'send_email', template_id: t('Promotion') }],
    },
    {
      key: 'unsub_sync', title: 'Sync unsubscribes to ChatDaddy', icon: 'user-x',
      desc: 'When someone unsubscribes from email, tag them in ChatDaddy so your WhatsApp team knows.',
      trigger_type: 'unsubscribed', trigger_config: {},
      steps: () => [{ type: 'add_tag', tag: 'unsubscribed' }, { type: 'chatdaddy_contact', tags: 'email-unsubscribed' }],
    },
  ];

  function recipeCard(r, t = () => '') {
    const steps = r.steps(t);
    const tr = C().TRIGGERS[r.trigger_type];
    return `<button class="recipe" data-recipe="${r.key}">
      <div class="r-head"><div class="icon-tile ${toneFor(tr.group)}">${icon(r.icon, 20)}</div><div class="r-title">${esc(r.title)}</div></div>
      <div class="r-desc">${esc(r.desc)}</div>
      <div class="r-flow"><span class="icon-tile sm orange" title="${esc(tr.label)}">${icon(tr.icon, 15)}</span>
        ${steps.map((s) => `${icon('chevron-right', 14)}<span class="icon-tile sm ${toneFor(C().STEP_TYPES[s.type].group)}" title="${esc(C().STEP_TYPES[s.type].label)}">${icon(C().STEP_TYPES[s.type].icon, 15)}</span>`).join('')}</div>
    </button>`;
  }

  // ------------------------------------------------------------------ summaries
  function triggerSummary(a, ctx) {
    const c = a.trigger_config || {};
    const camp = c.campaign_id ? ` from "${short(ctx.campaignName(c.campaign_id), 30)}"` : '';
    switch (a.trigger_type) {
      case 'email_sent': return `an email is sent${camp}`;
      case 'email_opened': return `an email${camp} is opened`;
      case 'link_clicked': return `a link${c.url_contains ? ` containing "${short(c.url_contains, 24)}"` : ''}${camp} is clicked`;
      case 'reply_received': return `an email reply${c.keywords ? ` mentioning "${short(c.keywords, 36)}"` : ''} arrives`;
      case 'email_received': return `any email${c.keywords ? ` mentioning "${short(c.keywords, 36)}"` : ''} arrives from a contact`;
      case 'bounced': return 'an email bounces';
      case 'unsubscribed': return 'a contact unsubscribes';
      case 'contact_added': return `a contact joins ${c.list_id ? `"${short(ctx.listName(c.list_id), 30)}"` : 'any list'}`;
      case 'tag_added': return `the tag "${c.tag || '…'}" is added`;
      case 'whatsapp_received': return `a WhatsApp message${c.keywords ? ` mentioning "${short(c.keywords, 30)}"` : ''} arrives`;
      case 'webhook_received': return `a webhook${c.event ? ` "${c.event}"` : ''} is received`;
      default: return 'you enrol contacts manually';
    }
  }

  function stepSummary(s, ctx) {
    switch (s.type) {
      case 'send_email': return `Send email "${short(ctx.templateName(s.template_id) || 'choose a template', 34)}"${s.reply_in_thread ? ' as a reply' : ''}`;
      case 'send_whatsapp': return s.template_name ? `Send WhatsApp template "${s.template_name}"` : `Send WhatsApp: "${short(s.text || '…', 40)}"`;
      case 'chatdaddy_contact': return `Sync to ChatDaddy${s.tags ? ` with tags ${short(s.tags, 30)}` : ''}`;
      case 'wait': return `Wait ${s.amount ?? 1} ${s.unit || 'days'}`;
      case 'stop_if': return `Stop if contact ${(C().STOP_CONDITIONS[s.condition] || s.condition || '…').replace('…', `"${s.tag || '…'}"`)}`;
      case 'add_tag': return `Add tag "${s.tag || '…'}"`;
      case 'remove_tag': return `Remove tag "${s.tag || '…'}"`;
      case 'add_to_list': return `Add to list "${short(ctx.listName(s.list_id) || '…', 30)}"`;
      case 'remove_from_list': return `Remove from list "${short(ctx.listName(s.list_id) || '…', 30)}"`;
      case 'update_field': return `Set ${s.field || 'field'} to "${short(s.value, 24)}"`;
      case 'notify': return `Notify team by ${{ whatsapp: 'WhatsApp', both: 'email + WhatsApp' }[s.channel] || 'email'}`;
      case 'webhook': return `Call webhook ${short((s.url || '').replace(/^https?:\/\//, ''), 34)}`;
      default: return s.type;
    }
  }

  // ------------------------------------------------------------------ list page
  App.route(/^#\/automations$/, async (root) => {
    const [meta, list, templates, lists, campaigns] = await Promise.all([App.getMeta(), api.get('/automations'), api.get('/templates'), api.get('/lists'), api.get('/campaigns')]);
    const ctx = context(templates, lists, campaigns);
    root.innerHTML = `
      ${App.pageHead({
        title: 'Automations',
        subtitle: 'Follow up, alert your team and reach contacts on email and WhatsApp - automatically.',
        actions: `<a class="btn primary lg" href="#/automations/new">${icon('plus', 18)}New automation</a>`,
      })}
      ${App.banners.worker(meta)}
      ${list.length ? `<div class="stack">${list.map((a) => {
        const tr = C().TRIGGERS[a.trigger_type] || { icon: 'zap', group: '' };
        const runs = Object.entries(a.runs || {}).map(([k, v]) => `${v} ${k}`).join(' · ');
        return `<div class="card" style="padding:18px 20px"><div class="list-row" style="padding:0">
          <div class="icon-tile ${toneFor(tr.group)}">${icon(tr.icon, 20)}</div>
          <div class="grow"><a href="#/automations/${a.id}"><b>${esc(a.name)}</b></a>
            <div class="muted" style="font-size:13.5px">When ${esc(triggerSummary(a, ctx))} → ${a.steps.map((s) => esc(stepSummary(s, ctx))).join(' → ') || 'no steps yet'}</div>
            ${runs ? `<div class="muted" style="font-size:12.5px;margin-top:4px">${esc(runs)}</div>` : ''}</div>
          ${statusBadge(a.status)}
          <button class="btn sm" data-toggle="${a.id}" data-status="${a.status}">${a.status === 'active' ? 'Pause' : 'Activate'}</button>
          <button class="btn icon ghost danger" data-del="${a.id}" title="Delete">${icon('trash', 17)}</button>
        </div></div>`;
      }).join('')}</div>` : ''}
      <div class="card" style="margin-top:${list.length ? 24 : 0}px">
        ${App.cardHead({ icon: 'sparkles', title: 'Start from a recipe', sub: 'Ready-made automations - pick one, adjust it, activate.' })}
        <div class="recipes">${RECIPES.map((r) => recipeCard(r)).join('')}</div>
      </div>`;
    root.querySelectorAll('[data-recipe]').forEach((b) => (b.onclick = () => { location.hash = `#/automations/new/${b.dataset.recipe}`; }));
    root.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
      await api.post(`/automations/${b.dataset.toggle}/${b.dataset.status === 'active' ? 'pause' : 'activate'}`);
      App.navigate();
    }));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (await confirmDialog('Delete this automation and its run history?')) { await api.del(`/automations/${b.dataset.del}`); App.navigate(); }
    }));
  });

  // ------------------------------------------------------------------ recipe gallery
  App.route(/^#\/automations\/new$/, async (root) => {
    root.innerHTML = `
      ${App.pageHead({ title: 'New automation', back: { href: '#/automations', label: 'Automations' }, subtitle: 'Start from a recipe or build your own in a few clicks.' })}
      <div class="recipes">
        <button class="recipe" data-recipe="blank"><div class="r-head"><div class="icon-tile gray">${icon('plus', 20)}</div><div class="r-title">Start from scratch</div></div>
          <div class="r-desc">Choose a trigger and add your own steps.</div></button>
        ${RECIPES.map((r) => recipeCard(r)).join('')}
      </div>`;
    root.querySelectorAll('[data-recipe]').forEach((b) => (b.onclick = () => { location.hash = `#/automations/new/${b.dataset.recipe}`; }));
  });

  function context(templates, lists, campaigns) {
    const byId = (arr) => Object.fromEntries(arr.map((x) => [String(x.id), x.name]));
    const t = byId(templates); const l = byId(lists); const c = byId(campaigns);
    return { templateName: (id) => t[id], listName: (id) => l[id], campaignName: (id) => c[id] };
  }

  // ------------------------------------------------------------------ builder
  App.route(/^#\/automations\/(new\/[\w-]+|new\?campaign=[\w-]+|[\w-]+)$/, async (root, param) => {
    const [meta, templates, lists, campaigns, facets, settings] = await Promise.all([
      App.getMeta(), api.get('/templates'), api.get('/lists'), api.get('/campaigns'), api.get('/contacts/facets'), api.get('/settings'),
    ]);
    const ctx = context(templates, lists, campaigns);
    const findTpl = (prefix) => (templates.find((x) => x.name.toLowerCase().startsWith(prefix.toLowerCase())) || {}).id || '';

    let a;
    if (param.startsWith('new')) {
      const presetCampaign = (param.match(/campaign=([\w-]+)/) || [])[1];
      const key = presetCampaign ? 'follow_up' : param.split('/')[1];
      const r = RECIPES.find((x) => x.key === key);
      a = r
        ? { id: null, name: r.title, status: 'paused', allow_reentry: false, trigger_type: r.trigger_type, trigger_config: { ...r.trigger_config }, steps: r.steps(findTpl), recent: [], runs: {} }
        : { id: null, name: '', status: 'paused', allow_reentry: false, trigger_type: '', trigger_config: {}, steps: [], recent: [], runs: {} };
      if (presetCampaign) a.trigger_config.campaign_id = presetCampaign;
    } else {
      a = await api.get(`/automations/${param}`);
    }
    let open = a.trigger_type ? -2 : -1; // -1 = trigger open, n = step n open, -2 = none
    let dirty = false;

    const field = (label, html, hint = '') => `<div class="field">${App.fieldLabel(label)}${html}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
    const inp = (k, v, attrs = '') => `<input type="text" data-k="${k}" value="${esc(v ?? '')}" ${attrs}>`;
    const mergeSel = (target) => `<select data-merge="${target}" style="width:auto;height:34px;font-size:13px"><option value="">+ Insert merge tag</option>${meta.mergeTags.map((t) => `<option value="{{${t}}}">${t}</option>`).join('')}</select>`;
    const tagList = `<datalist id="tag-list">${(facets.tags || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`;

    function triggerFields() {
      const c = a.trigger_config || {};
      const campaign = field('Campaign <span class="hint-inline">(optional)</span>', `<select data-cfg="campaign_id">${opts(campaigns, c.campaign_id, 'Any campaign')}</select>`);
      const template = field('Template <span class="hint-inline">(optional)</span>', `<select data-cfg="template_id">${opts(templates, c.template_id, 'Any template')}</select>`);
      switch (a.trigger_type) {
        case 'email_sent':
        case 'email_opened': return `<div class="row">${campaign}${template}</div>`;
        case 'link_clicked': return `<div class="row">${campaign}${field('URL contains <span class="hint-inline">(optional)</span>', `<input type="text" data-cfg="url_contains" value="${esc(c.url_contains || '')}" placeholder="/pricing">`)}</div>`;
        case 'reply_received': return `<div class="row">${campaign}${field('Only if the reply mentions <span class="hint-inline">(optional)</span>', `<input type="text" data-cfg="keywords" value="${esc(c.keywords || '')}" placeholder="interested, price, call">`, 'Comma separated - any one matches.')}</div>`;
        case 'email_received': return field('Only if the email mentions <span class="hint-inline">(optional)</span>', `<input type="text" data-cfg="keywords" value="${esc(c.keywords || '')}" placeholder="brochure, price">`,
          'Fires for every new email from a known contact (including replies). To answer unknown senders automatically, use <a href="#/autoreply">Auto-reply</a>.');
        case 'whatsapp_received': return field('Only if the message mentions <span class="hint-inline">(optional)</span>', `<input type="text" data-cfg="keywords" value="${esc(c.keywords || '')}" placeholder="price, info">`, 'Needs the ChatDaddy webhook from Settings → Inbound webhooks.');
        case 'contact_added': return field('List', `<select data-cfg="list_id">${opts(lists, c.list_id, 'Any list')}</select>`);
        case 'tag_added': return field('Tag', `<input type="text" data-cfg="tag" list="tag-list" value="${esc(c.tag || '')}" placeholder="hot-lead">`);
        case 'webhook_received': return field('Event name <span class="hint-inline">(optional)</span>', `<input type="text" data-cfg="event" value="${esc(c.event || '')}" placeholder="form_submitted">`,
          `Matches the <code>event</code> field your app sends. Webhook URL: <a href="#/settings">Settings → Inbound webhooks</a>.`);
        case 'manual': return '<p class="muted" style="margin:0">Save the automation, then use <b>Enrol contacts</b> to start it for a list.</p>';
        default: return '<p class="muted" style="margin:0">No extra settings.</p>';
      }
    }

    function stepFields(s) {
      switch (s.type) {
        case 'send_email':
          return field('Template', `<select data-k="template_id">${opts(templates, s.template_id, '— choose a template —')}</select>`, `<a href="#/templates/new-dragdrop">Design a new template</a>`) +
            `<div class="row">${field('Subject <span class="hint-inline">(blank = template subject)</span>', inp('subject', s.subject))}
              ${field('From', `<input type="email" data-k="from_email" value="${esc(s.from_email || '')}" placeholder="Default sender">`, App.sendersHint(settings))}</div>
            <label class="check"><input type="checkbox" data-k="reply_in_thread" ${s.reply_in_thread ? 'checked' : ''}> Send as a reply in the same email thread ("Re: …")</label>`;
        case 'send_whatsapp': {
          const provider = s.provider || '';
          const cloud = provider === 'cloud' || (!provider && settings.whatsapp_provider === 'cloud');
          return field('Send with', `<select data-k="provider"><option value="">Default (${settings.whatsapp_provider === 'cloud' ? 'WhatsApp Cloud API' : 'ChatDaddy'})</option><option value="chatdaddy" ${provider === 'chatdaddy' ? 'selected' : ''}>ChatDaddy</option><option value="cloud" ${provider === 'cloud' ? 'selected' : ''}>WhatsApp Cloud API</option></select>`) +
            (cloud
              ? `<div class="row">${field('Approved template name', inp('template_name', s.template_name, 'placeholder="follow_up"'), 'Meta requires an approved template to start a conversation. Leave empty to send the text below (only within 24h of their last message).')}
                ${field('Language', inp('language', s.language, 'placeholder="en" style="max-width:120px"'))}</div>
                ${field('Template variables <span class="hint-inline">(separate with |)</span>', inp('params', s.params, 'placeholder="{{first_name}} | {{company}}"'))}`
              : '') +
            `<div class="field">${App.fieldLabel('Message', mergeSel('text'))}<textarea data-k="text" rows="4" placeholder="Hi {{first_name|there}}, …">${esc(s.text || '')}</textarea>
              <div class="hint">Sent to the contact's phone number (local numbers use the default country code from Settings).</div></div>`;
        }
        case 'chatdaddy_contact':
          return field('Tags to add in ChatDaddy', inp('tags', s.tags, 'placeholder="email-lead, {{company}}"'), 'Comma separated; merge tags allowed.') +
            `<label class="check"><input type="checkbox" data-k="include_contact_tags" ${s.include_contact_tags ? 'checked' : ''}> Also copy the contact's tags from this portal</label>`;
        case 'wait':
          return `<div class="row"><div class="field" style="max-width:140px">${App.fieldLabel('Wait')}<input type="number" min="0" data-k="amount" value="${esc(s.amount ?? 1)}"></div>
            <div class="field" style="max-width:180px">${App.fieldLabel('&nbsp;')}<select data-k="unit">${['minutes', 'hours', 'days'].map((u) => `<option ${(s.unit || 'days') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div></div>
            <div class="row" style="gap:6px;margin-top:-8px">${[[1, 'hours', '1 hour'], [1, 'days', '1 day'], [3, 'days', '3 days'], [7, 'days', '1 week']].map(([n, u, l]) => `<button type="button" class="btn sm" data-preset="${n}|${u}">${l}</button>`).join('')}</div>`;
        case 'stop_if':
          return field('Stop the automation if the contact…', `<select data-k="condition">${Object.entries(meta.stopConditions).map(([k, v]) => `<option value="${k}" ${s.condition === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`, 'Checked from the moment the contact entered this automation.') +
            (['has_tag', 'not_has_tag'].includes(s.condition) ? field('Tag', inp('tag', s.tag, 'list="tag-list"')) : '');
        case 'add_tag':
        case 'remove_tag':
          return field('Tag', inp('tag', s.tag, 'list="tag-list" placeholder="hot-lead"'));
        case 'add_to_list':
        case 'remove_from_list':
          return field('List', `<select data-k="list_id">${opts(lists, s.list_id, '— choose a list —')}</select>`);
        case 'update_field':
          return `<div class="row">${field('Field', `<select data-k="field">${['status', 'company', 'country', 'industry', 'phone', 'website', 'first_name', 'last_name'].map((x) => `<option ${s.field === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`)}
            ${field('Value', inp('value', s.value))}</div>`;
        case 'notify': {
          const ch = s.channel || 'email';
          return field('Notify by', `<select data-k="channel"><option value="email" ${ch === 'email' ? 'selected' : ''}>Email</option><option value="whatsapp" ${ch === 'whatsapp' ? 'selected' : ''}>WhatsApp</option><option value="both" ${ch === 'both' ? 'selected' : ''}>Email + WhatsApp</option></select>`) +
            `<div class="row">${ch !== 'whatsapp' ? field('Email to <span class="hint-inline">(blank = sending account)</span>', `<input type="email" data-k="email" value="${esc(s.email || '')}">`) : ''}
              ${ch !== 'email' ? field('WhatsApp number', `<input type="tel" data-k="whatsapp" value="${esc(s.whatsapp || '')}" placeholder="+60 12-345 6789">`) : ''}</div>` +
            field('Title <span class="hint-inline">(optional)</span>', inp('subject', s.subject, 'placeholder="Hot lead replied!"'));
        }
        case 'webhook':
          return field('Webhook URL', `<input type="url" data-k="url" value="${esc(s.url || '')}" placeholder="https://hooks.zapier.com/…">`, 'Receives a JSON POST with the automation, trigger, event and contact.');
        default:
          return '';
      }
    }

    function sentence() {
      if (!a.trigger_type) return '<span class="muted">Choose a trigger to start.</span>';
      return `When <b>${esc(triggerSummary(a, ctx))}</b>${a.steps.length ? `, then ${a.steps.map((s) => `<b>${esc(stepSummary(s, ctx).replace(/^./, (m) => m.toLowerCase()))}</b>`).join(' → ')}` : ' <span class="muted">(add steps below)</span>'}.`;
    }

    const connector = (index) => `<div class="connector"><div class="line"></div><button type="button" class="add" data-add="${index}" title="Add a step here">${icon('plus', 16)}</button><div class="line"></div></div>`;

    function draw() {
      const tr = C().TRIGGERS[a.trigger_type];
      root.innerHTML = `
        ${App.pageHead({
          title: a.id ? esc(a.name || 'Automation') : 'New automation',
          badge: statusBadge(a.status),
          back: { href: '#/automations', label: 'Automations' },
          actions: `${a.id ? `<button class="btn" id="enroll">${icon('user-plus', 17)}Enrol contacts</button>` : ''}
            <button class="btn" id="save">Save</button>
            <button class="btn ${a.status === 'active' ? '' : 'primary'}" id="toggle">${a.status === 'active' ? 'Save &amp; pause' : `${icon('play', 14)}Save &amp; activate`}</button>`,
        })}
        ${App.banners.worker(meta)}
        <div class="card">
          <div class="field">${App.fieldLabel('Automation name')}<input type="text" id="a-name" value="${esc(a.name)}" placeholder="e.g. Follow up non-responders"></div>
          <div class="sentence">${sentence()}</div>
          <hr class="divider">
          <label class="check"><input type="checkbox" id="a-stop" ${a.trigger_config.stop_on_reply ? 'checked' : ''}> Stop for a contact as soon as they reply (email or WhatsApp)</label>
          <label class="check"><input type="checkbox" id="a-reentry" ${a.allow_reentry ? 'checked' : ''}> Allow a contact to go through this more than once</label>
        </div>
        ${tagList}
        <div class="flow">
          <div class="node trigger ${open === -1 ? 'open' : ''}">
            <div class="node-head" data-open="-1"><div class="icon-tile orange">${icon(tr ? tr.icon : 'zap', 20)}</div>
              <div class="t"><div class="k">When</div><div class="s">${tr ? esc(tr.label) : 'Choose a trigger'}</div></div>${icon(open === -1 ? 'chevron-down' : 'chevron-right', 18)}</div>
            ${open === -1 ? `<div class="node-body">
              ${groups(C().TRIGGERS).map(([g, items]) => `<div class="picker-group"><h3>${esc(g)}</h3><div class="picker-grid">${items.map(([k, v]) => `
                <button type="button" class="pick ${a.trigger_type === k ? 'on' : ''}" data-trigger="${k}"><div class="icon-tile sm ${toneFor(v.group)}">${icon(v.icon, 16)}</div><div><div class="p-t">${esc(v.label)}</div><div class="p-d">${esc(v.description)}</div></div></button>`).join('')}</div></div>`).join('')}
              ${a.trigger_type ? `<hr class="divider"><div id="trigger-cfg">${triggerFields()}</div>` : ''}
            </div>` : ''}
          </div>
          ${a.trigger_type ? a.steps.map((s, i) => {
            const meta2 = C().STEP_TYPES[s.type] || { label: s.type, icon: 'zap', group: '' };
            return `${connector(i)}
              <div class="node step ${open === i ? 'open' : ''}">
                <div class="node-head" data-open="${i}"><div class="icon-tile ${toneFor(meta2.group)}">${icon(meta2.icon, 20)}</div>
                  <div class="t"><div class="k">Step ${i + 1} · ${esc(meta2.label)}</div><div class="s truncate">${esc(stepSummary(s, ctx))}</div></div>
                  <div class="node-tools">
                    <button type="button" class="btn icon ghost" data-mv="${i}" data-d="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up', 16)}</button>
                    <button type="button" class="btn icon ghost" data-mv="${i}" data-d="1" title="Move down" ${i === a.steps.length - 1 ? 'disabled' : ''}>${icon('arrow-down', 16)}</button>
                    <button type="button" class="btn icon ghost danger" data-rm="${i}" title="Delete step">${icon('trash', 16)}</button>
                  </div></div>
                ${open === i ? `<div class="node-body" data-step="${i}">${stepFields(s)}</div>` : ''}
              </div>`;
          }).join('') + connector(a.steps.length) + '<div class="end">End of automation</div>' : ''}
        </div>
        ${a.id ? `<div class="card" style="margin-top:28px">${App.cardHead({ icon: 'layers', tone: 'gray', title: 'Recent runs', sub: 'Contacts currently or previously in this automation' })}
          ${a.recent.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Contact</th><th>Status</th><th>Step</th><th>Next action</th><th class="hide-sm">Log</th><th></th></tr></thead><tbody>
          ${a.recent.map((r) => `<tr><td>${esc(r.email || r.contact_id)}</td><td>${statusBadge(r.status)}</td><td>${r.step_index + 1}</td><td class="nowrap">${r.status === 'active' ? fmtDate(r.next_run_at) : ''}</td>
            <td class="run-log hide-sm">${r.log.slice(-4).map((l) => `${esc(l.type)}: ${esc(l.note || l.error || '')}`).join('<br>')}</td><td>${r.status === 'active' ? `<button class="btn sm" data-stop="${r.id}">Stop</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">No runs yet.</p>'}</div>` : ''}`;
      bind();
    }

    function groups(map) {
      const out = {};
      Object.entries(map).forEach(([k, v]) => { (out[v.group] = out[v.group] || []).push([k, v]); });
      return Object.entries(out);
    }

    function sync() {
      const name = root.querySelector('#a-name');
      if (!name) return;
      a.name = name.value;
      a.trigger_config.stop_on_reply = root.querySelector('#a-stop').checked;
      a.allow_reentry = root.querySelector('#a-reentry').checked;
      root.querySelectorAll('[data-cfg]').forEach((el) => { a.trigger_config[el.dataset.cfg] = el.value; });
      const body = root.querySelector('[data-step]');
      if (body) {
        const s = a.steps[Number(body.dataset.step)];
        body.querySelectorAll('[data-k]').forEach((el) => { s[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
      }
    }

    function stepPicker(index) {
      modal(`<div class="row" style="align-items:center;margin-bottom:16px"><h2 style="margin:0;flex:1">Add a step</h2><button class="btn icon ghost" data-close>${icon('x', 18)}</button></div>
        ${groups(C().STEP_TYPES).map(([g, items]) => `<div class="picker-group"><h3>${esc(g)}</h3><div class="picker-grid">${items.map(([k, v]) => `
          <button type="button" class="pick" data-type="${k}"><div class="icon-tile sm ${toneFor(v.group)}">${icon(v.icon, 16)}</div><div><div class="p-t">${esc(v.label)}</div><div class="p-d">${esc(v.description)}</div></div></button>`).join('')}</div></div>`).join('')}`, {
        wide: true,
        onMount: (el, close) => el.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => {
          const type = b.dataset.type;
          const defaults = { wait: { amount: 1, unit: 'days' }, stop_if: { condition: 'replied' }, notify: { channel: 'email' } }[type] || {};
          a.steps.splice(index, 0, { type, ...defaults });
          open = index;
          dirty = true;
          close();
          draw();
        })),
      });
    }

    function bind() {
      root.querySelector('#a-name').addEventListener('input', () => { dirty = true; });
      root.querySelectorAll('[data-open]').forEach((h) => (h.onclick = (e) => {
        if (e.target.closest('.node-tools')) return;
        sync();
        const n = Number(h.dataset.open);
        open = open === n ? -2 : n;
        draw();
      }));
      root.querySelectorAll('[data-trigger]').forEach((b) => (b.onclick = () => {
        sync();
        if (a.trigger_type !== b.dataset.trigger) a.trigger_config = { stop_on_reply: a.trigger_config.stop_on_reply };
        a.trigger_type = b.dataset.trigger;
        dirty = true;
        draw();
        root.querySelector('#trigger-cfg')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }));
      root.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => { sync(); stepPicker(Number(b.dataset.add)); }));
      root.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { sync(); a.steps.splice(Number(b.dataset.rm), 1); open = -2; dirty = true; draw(); }));
      root.querySelectorAll('[data-mv]').forEach((b) => (b.onclick = () => {
        sync();
        const i = Number(b.dataset.mv);
        const j = i + Number(b.dataset.d);
        [a.steps[i], a.steps[j]] = [a.steps[j], a.steps[i]];
        if (open === i) open = j;
        dirty = true;
        draw();
      }));
      root.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
        sync();
        const [n, u] = b.dataset.preset.split('|');
        const s = a.steps[open];
        s.amount = Number(n);
        s.unit = u;
        draw();
      }));
      root.querySelectorAll('[data-merge]').forEach((sel) => (sel.onchange = () => {
        const ta = root.querySelector(`[data-k="${sel.dataset.merge}"]`);
        const p = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, p) + sel.value + ta.value.slice(p);
        sel.value = '';
        ta.focus();
      }));
      // Re-render summaries when a field that changes the layout/summary changes.
      // Selects can change which fields are shown -> redraw. Text fields only refresh the
      // summaries (a redraw on blur would swallow the click that caused the blur).
      root.querySelectorAll('[data-step] select, select[data-cfg]').forEach((el) => el.addEventListener('change', () => { sync(); dirty = true; draw(); }));
      root.querySelectorAll('[data-step] input, [data-step] textarea, input[data-cfg]').forEach((el) => el.addEventListener('input', () => {
        sync();
        dirty = true;
        root.querySelector('.sentence').innerHTML = sentence();
        const head = root.querySelector(`[data-open="${open}"] .s`);
        if (head && open >= 0) head.textContent = stepSummary(a.steps[open], ctx);
      }));
      root.querySelectorAll('[data-stop]').forEach((b) => (b.onclick = async () => { await api.post(`/automation-runs/${b.dataset.stop}/stop`); App.navigate(); }));

      const save = async (status) => {
        sync();
        if (!a.trigger_type) return toast('Choose a trigger first', 'error');
        const body = { name: a.name || C().TRIGGERS[a.trigger_type].label, trigger_type: a.trigger_type, trigger_config: a.trigger_config, steps: a.steps, status: status || a.status, allow_reentry: a.allow_reentry };
        const saved = a.id ? await api.put(`/automations/${a.id}`, body) : await api.post('/automations', body);
        dirty = false;
        toast(`Automation saved${saved.status === 'active' ? ' and active' : ''}`);
        if (a.id) App.navigate();
        else location.hash = `#/automations/${saved.id}`;
      };
      root.querySelector('#save').onclick = () => save();
      root.querySelector('#toggle').onclick = () => save(a.status === 'active' ? 'paused' : 'active');
      root.querySelector('#enroll')?.addEventListener('click', () => modal(`<h2>Enrol contacts</h2><p class="hint">Start this automation now for every subscribed contact in a list.</p>
        <div class="field"><label>List</label><select id="el">${opts(lists, '')}</select></div>
        <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Enrol</button></div>`, {
        onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
          await api.post(`/automations/${a.id}/enroll`, { list_id: el.querySelector('#el').value });
          toast(`Enrolment queued${a.status === 'active' ? '' : ' (activate the automation to start processing)'}`);
          close();
        }),
      }));
    }

    draw();
    const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  });
})();
