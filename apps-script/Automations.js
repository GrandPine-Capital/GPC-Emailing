/*
 * Automation engine: trigger matching + step execution.
 * A run is created per (automation, contact) when a trigger fires; `wait`
 * steps park the run until next_run_at and the scheduler resumes it.
 */
var Automations = (function () {
  const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };
  let activeCache = null;

  function active() {
    if (!activeCache) activeCache = FS.query('automations', { where: [['status', '==', 'active']] });
    return activeCache;
  }
  function reset() {
    activeCache = null;
  }

  function has(v) {
    return v !== undefined && v !== null && v !== '';
  }

  function matches(config, event) {
    config = config || {};
    if (has(config.campaign_id) && String(config.campaign_id) !== String(event.campaignId)) return false;
    if (has(config.template_id) && String(config.template_id) !== String(event.templateId)) return false;
    if (has(config.list_id) && String(config.list_id) !== String(event.listId)) return false;
    if (has(config.tag) && String(config.tag) !== String(event.tag)) return false;
    if (has(config.event) && String(config.event) !== String(event.event)) return false;
    if (has(config.url_contains) && String(event.url || '').toLowerCase().indexOf(String(config.url_contains).toLowerCase()) < 0) return false;
    if (has(config.keywords)) {
      const text = String(event.text || '').toLowerCase();
      const words = String(config.keywords).split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
      if (words.length && !words.some(function (w) { return text.indexOf(w) >= 0; })) return false;
    }
    return true;
  }

  function startRun(automation, contactId, context) {
    const contact = FS.get('contacts/' + contactId);
    if (!contact) return null;
    const doc = FS.create('runs', {
      automation_id: automation.id,
      automation_name: automation.name,
      contact_id: contactId,
      email: contact.email,
      step_index: 0,
      status: 'active',
      next_run_at: nowIso(),
      context: context || {},
      log: [],
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    FS.commit([{ transform: 'automations/' + automation.id, increment: { 'runs.active': 1 } }]);
    return doc && doc.id;
  }

  function runsFor(automationId, contactId) {
    return FS.query('runs', { where: [['automation_id', '==', automationId], ['contact_id', '==', contactId]] });
  }

  function setRunStatus(run, status) {
    const inc = {};
    inc['runs.' + run.status] = -1;
    inc['runs.' + status] = 1;
    FS.commit([
      { update: 'runs/' + run.id, data: { status: status, updated_at: nowIso() } },
      { transform: 'automations/' + run.automation_id, increment: inc },
    ]);
  }

  /** Fire a trigger event; creates runs for every matching active automation. */
  function fire(type, event) {
    if (!event || !event.contactId) return [];
    const created = [];
    const autos = active();

    if (type === 'reply_received' || type === 'whatsapp_received') {
      // Sequences flagged "stop on reply" end as soon as the contact replies.
      autos.forEach(function (a) {
        if (!(a.trigger_config || {}).stop_on_reply) return;
        runsFor(a.id, event.contactId).forEach(function (r) {
          if (r.status === 'active') setRunStatus(r, 'stopped');
        });
      });
    }

    autos.forEach(function (a) {
      if (a.trigger_type !== type) return;
      if (event.fromAutomation && event.fromAutomation === a.id) return; // no self-loops
      if (!matches(a.trigger_config, event)) return;
      const prior = runsFor(a.id, event.contactId);
      if (a.allow_reentry ? prior.some(function (r) { return r.status === 'active'; }) : prior.length) return;
      const id = startRun(a, event.contactId, { trigger: type, event: event });
      if (id) created.push(id);
    });
    return created;
  }

  function conditionMet(condition, run, tag) {
    const since = run.created_at;
    const contact = FS.get('contacts/' + run.contact_id) || {};
    const msgs = function () { return FS.query('messages', { where: [['contact_id', '==', run.contact_id]] }); };
    switch (condition) {
      case 'replied': return !!(contact.replied_at && contact.replied_at >= since);
      case 'not_replied': return !conditionMet('replied', run);
      case 'opened': return msgs().some(function (m) { return m.opened_at && m.opened_at >= since; });
      case 'not_opened': return !conditionMet('opened', run);
      case 'clicked': return msgs().some(function (m) { return m.clicked_at && m.clicked_at >= since; });
      case 'not_clicked': return !conditionMet('clicked', run);
      case 'unsubscribed': return contact.status !== 'subscribed';
      case 'has_tag': return (contact.tags || []).indexOf(tag) >= 0;
      case 'not_has_tag': return (contact.tags || []).indexOf(tag) < 0;
      default: return false;
    }
  }

  function executeStep(step, run, ctx) {
    const contact = FS.get('contacts/' + run.contact_id);
    if (!contact) return { stop: true, note: 'contact deleted' };
    const contactPath = 'contacts/' + contact.id;

    switch (step.type) {
      case 'wait': {
        if (ctx.waiting_step === run.step_index) {
          delete ctx.waiting_step;
          return { note: 'wait finished' };
        }
        const ms = Math.max(0, Number(step.amount || 0)) * (UNIT_MS[step.unit] || UNIT_MS.days);
        ctx.waiting_step = run.step_index;
        return { waitUntil: new Date(Date.now() + ms), note: 'waiting ' + step.amount + ' ' + (step.unit || 'days') };
      }
      case 'send_email': {
        if (contact.status !== 'subscribed') return { stop: true, note: 'contact ' + contact.status };
        if (!EmailCore.isEmail(contact.email)) return { note: 'skipped: contact has no email address' };
        if (Mailer.remainingToday() <= 0) return { waitUntil: new Date(Date.now() + 3600e3), retry: true, note: 'daily sending limit reached, retrying later' };
        const template = Delivery.getTemplate(step.template_id);
        if (!template) throw new Error('template ' + step.template_id + ' not found');
        let subject = step.subject || template.subject || '';
        const extra = {};
        const trig = ctx.event || {};
        if (step.reply_in_thread && trig.messageId) {
          const orig = FS.get('messages/' + trig.messageId);
          if (orig && orig.thread_id && orig.gmail_id) {
            extra.threadId = orig.thread_id;
            extra.inReplyTo = Mailer.rfcMessageId(orig.gmail_id);
            if (!step.subject) subject = /^re:/i.test(orig.subject || '') ? orig.subject : 'Re: ' + (orig.subject || subject);
          }
        }
        const m = Delivery.createMessage({ contact: contact, templateId: template.id, subject: subject, automationId: run.automation_id, runId: run.id, fromEmail: step.from_email });
        FS.commit([m.op]);
        const status = Delivery.deliver(m.doc, extra);
        if (status === 'failed') throw new Error((FS.get('messages/' + m.doc.id) || {}).error || 'send failed');
        return { note: 'email "' + subject + '" ' + status };
      }
      case 'send_whatsapp': {
        if (contact.status === 'unsubscribed' && !step.ignore_unsubscribe) return { stop: true, note: 'contact unsubscribed' };
        const vars = whatsappVars(contact);
        const text = EmailCore.merge(step.text || '', vars);
        const params = String(step.params || '').split('|').map(function (p) { return EmailCore.merge(p.trim(), vars); }).filter(Boolean);
        Integrations.sendWhatsApp(contact, { provider: step.provider, text: text, template: step.template_name, language: step.language, params: params });
        logWhatsApp(contact, text || ('template ' + step.template_name), run);
        return { note: 'WhatsApp sent via ' + (step.provider || CONFIG.settings().whatsapp_provider || 'chatdaddy') };
      }
      case 'chatdaddy_contact': {
        const tags = String(step.tags || '').split(',').map(function (t) { return EmailCore.merge(t.trim(), whatsappVars(contact)); }).filter(Boolean);
        if (step.include_contact_tags) tags.push.apply(tags, contact.tags || []);
        Integrations.chatdaddyUpsert(contact, tags);
        return { note: 'synced to ChatDaddy' + (tags.length ? ' with tags ' + tags.join(', ') : '') };
      }
      case 'stop_if':
        return conditionMet(step.condition, run, step.tag) ? { stop: true, note: 'stopped: ' + step.condition } : { note: 'condition ' + step.condition + ' not met' };
      case 'add_tag': {
        FS.commit([{ transform: contactPath, arrayUnion: { tags: [step.tag] } }, { transform: 'meta/facets', arrayUnion: { tags: [step.tag] } }]);
        if ((contact.tags || []).indexOf(step.tag) < 0) fire('tag_added', { contactId: contact.id, tag: step.tag, fromAutomation: run.automation_id });
        return { note: 'tag +' + step.tag };
      }
      case 'remove_tag':
        FS.commit([{ transform: contactPath, arrayRemove: { tags: [step.tag] } }]);
        return { note: 'tag -' + step.tag };
      case 'add_to_list': {
        const listId = String(step.list_id);
        const isNew = (contact.list_ids || []).indexOf(listId) < 0;
        FS.commit([{ transform: contactPath, arrayUnion: { list_ids: [listId] } }]);
        if (isNew) fire('contact_added', { contactId: contact.id, listId: listId });
        return { note: 'added to list' };
      }
      case 'remove_from_list':
        FS.commit([{ transform: contactPath, arrayRemove: { list_ids: [String(step.list_id)] } }]);
        return { note: 'removed from list' };
      case 'update_field': {
        if (EmailCore.CONTACT_FIELDS.indexOf(step.field) < 0 && step.field !== 'status') throw new Error('cannot update field ' + step.field);
        const data = {};
        data[step.field] = step.value == null ? '' : String(step.value);
        FS.update(contactPath, data);
        return { note: step.field + ' = ' + step.value };
      }
      case 'notify': {
        const text = (ctx.event || {}).text;
        const reply = text ? '\n\nMessage:\n' + String(text).slice(0, 2000) : '';
        const who = contact.email || contact.phone || contact.id;
        const summary = 'Automation "' + ctx.automation_name + '" (' + ctx.trigger + ') for ' + who +
          ' (' + [contact.first_name, contact.last_name].filter(Boolean).join(' ') + (contact.company ? ', ' + contact.company : '') + ').' + reply +
          '\n\nOpen: ' + CONFIG.siteUrl() + '/#/contacts/' + encodeURIComponent(contact.id);
        const channel = step.channel || 'email';
        const notes = [];
        if (channel === 'email' || channel === 'both') {
          const to = step.email || CONFIG.senderEmail();
          Mailer.send({ to: to, force: true, subject: step.subject || '[Automation] ' + ctx.automation_name + ': ' + who, text: summary });
          notes.push('emailed ' + to);
        }
        if (channel === 'whatsapp' || channel === 'both') {
          if (!step.whatsapp) throw new Error('enter the WhatsApp number to notify');
          Integrations.sendWhatsApp(step.whatsapp, { provider: step.provider, text: (step.subject ? step.subject + '\n' : '') + summary });
          notes.push('WhatsApp ' + step.whatsapp);
        }
        return { note: 'notified: ' + notes.join(', ') };
      }
      case 'webhook': {
        const res = UrlFetchApp.fetch(step.url, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({ automation: ctx.automation_name, trigger: ctx.trigger, event: ctx.event, contact: contact }),
          muteHttpExceptions: true,
        });
        if (res.getResponseCode() >= 300) throw new Error('webhook responded ' + res.getResponseCode());
        return { note: 'webhook ' + res.getResponseCode() };
      }
      default:
        throw new Error('unknown step type ' + step.type);
    }
  }
  function whatsappVars(contact) {
    const s = CONFIG.settings();
    return Object.assign(EmailCore.contactVars(contact), { sender_name: s.from_name, company_address: s.company_address });
  }

  /** Keep a record of outgoing WhatsApp messages on the contact's timeline. */
  function logWhatsApp(contact, text, run) {
    FS.create('whatsapp', {
      contact_id: contact.id, phone: Integrations.phoneOf(contact), direction: 'out', text: String(text).slice(0, 4000),
      automation_id: run.automation_id, created_at: nowIso(),
    });
  }

  function processRun(run, automation) {
    const steps = automation.steps || [];
    const ctx = run.context || {};
    ctx.automation_name = automation.name;
    ctx.trigger = ctx.trigger || 'manual';
    const log = run.log || [];
    let index = Number(run.step_index || 0);
    const save = function (fields) {
      const data = Object.assign({ step_index: index, context: ctx, log: log.slice(-30), updated_at: nowIso() }, fields);
      const ops = [{ update: 'runs/' + run.id, data: data }];
      if (fields.status && fields.status !== 'active') {
        const inc = { 'runs.active': -1 };
        inc['runs.' + fields.status] = 1;
        ops.push({ transform: 'automations/' + automation.id, increment: inc });
      }
      FS.commit(ops);
    };

    for (let guard = 0; guard < 30; guard++) {
      if (index >= steps.length) return save({ status: 'completed' });
      const step = steps[index];
      run.step_index = index;
      try {
        const r = executeStep(step, run, ctx);
        log.push({ at: nowIso(), step: index, type: step.type, note: r.note });
        if (r.stop) return save({ status: 'stopped' });
        if (r.waitUntil) return save({ next_run_at: nowIso(r.waitUntil) });
        index++;
      } catch (e) {
        log.push({ at: nowIso(), step: index, type: step.type, error: String(e.message || e) });
        return save({ status: 'failed' });
      }
    }
    save({});
  }

  /** Advance every due run. */
  function processDue(hasTime) {
    const autos = {};
    active().forEach(function (a) { autos[a.id] = a; });
    const due = FS.query('runs', { where: [['status', '==', 'active'], ['next_run_at', '<=', nowIso()]], orderBy: [['next_run_at', 'asc']], limit: 100 });
    let n = 0;
    for (let i = 0; i < due.length && hasTime(); i++) {
      const a = autos[due[i].automation_id];
      if (!a) continue; // automation paused
      processRun(due[i], a);
      n++;
    }
    return n;
  }

  /** Stop every active run for a contact (unsubscribed / bounced). */
  function stopRunsFor(contactId) {
    FS.query('runs', { where: [['contact_id', '==', contactId], ['status', '==', 'active']] }).forEach(function (r) {
      setRunStatus(r, 'stopped');
    });
  }

  /** Manually enrol contacts (by id or by list) into an automation. */
  function enroll(automationId, contactIds, listId) {
    const a = FS.get('automations/' + automationId);
    if (!a) throw new Error('automation not found');
    let ids = (contactIds || []).slice();
    if (listId) {
      FS.query('contacts', { where: [['list_ids', 'array-contains', String(listId)]] }).forEach(function (c) {
        if (c.status === 'subscribed') ids.push(c.id);
      });
    }
    let n = 0;
    ids.filter(function (v, i) { return ids.indexOf(v) === i; }).forEach(function (id) {
      if (runsFor(a.id, id).some(function (r) { return r.status === 'active'; })) return;
      if (startRun(a, id, { trigger: 'manual', event: { contactId: id } })) n++;
    });
    return n;
  }

  return { fire: fire, stopRunsFor: stopRunsFor, processDue: processDue, enroll: enroll, matches: matches, conditionMet: conditionMet, reset: reset };
})();
