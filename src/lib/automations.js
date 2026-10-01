/*
 * Automation engine.
 *
 * An automation = trigger + ordered steps. When a trigger event fires for a
 * contact, a "run" is created. The scheduler advances due runs step by step;
 * `wait` steps park the run until `next_run_at`.
 */
const db = require('../db');

const TRIGGERS = {
  email_sent: 'After an email is sent (optionally from a specific campaign / template)',
  email_opened: 'When a contact opens an email',
  link_clicked: 'When a contact clicks a link (optionally matching a URL)',
  reply_received: 'When a reply is received (optionally containing keywords)',
  contact_added: 'When a contact is added to a list',
  manual: 'Only when started manually for selected contacts',
};

const STEP_TYPES = {
  wait: 'Wait for an amount of minutes / hours / days',
  send_email: 'Send an email using a template',
  stop_if: 'Stop the automation if a condition is met (replied, opened, clicked, ...)',
  add_tag: 'Add a tag to the contact',
  remove_tag: 'Remove a tag from the contact',
  add_to_list: 'Add the contact to a list',
  remove_from_list: 'Remove the contact from a list',
  update_field: 'Set a contact field (country, industry, company, ...)',
  notify: 'Send an internal notification email to your team',
  webhook: 'POST the event to an external URL (CRM, Slack, Zapier, ...)',
};

const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };

function parse(a) {
  return { ...a, trigger_config: db.json(a.trigger_config, {}), steps: db.json(a.steps, []) };
}

function matches(config, event) {
  const has = (v) => v !== undefined && v !== null && v !== '';
  if (has(config.campaign_id) && Number(config.campaign_id) !== Number(event.campaignId)) return false;
  if (has(config.template_id) && Number(config.template_id) !== Number(event.templateId)) return false;
  if (has(config.list_id) && Number(config.list_id) !== Number(event.listId)) return false;
  if (has(config.url_contains) && !String(event.url || '').toLowerCase().includes(String(config.url_contains).toLowerCase())) return false;
  if (has(config.keywords)) {
    const text = String(event.text || '').toLowerCase();
    const words = String(config.keywords).split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.length && !words.some((w) => text.includes(w))) return false;
  }
  return true;
}

function startRun(automationId, contactId, context = {}) {
  const res = db.run(
    'INSERT INTO automation_runs (automation_id, contact_id, context, next_run_at) VALUES (?, ?, ?, ?)',
    automationId, contactId, JSON.stringify(context), db.now(),
  );
  return Number(res.lastInsertRowid);
}

let kickScheduled = false;

/** Fire a trigger event; creates runs for every matching active automation. */
function fire(type, event = {}) {
  if (!event.contactId) return [];
  const created = [];

  if (type === 'reply_received') {
    // Sequences flagged "stop on reply" end as soon as the contact replies.
    for (const a of db.all("SELECT * FROM automations WHERE status = 'active'").map(parse)) {
      if (!a.trigger_config.stop_on_reply) continue;
      db.run(
        "UPDATE automation_runs SET status = 'stopped', updated_at = ? WHERE automation_id = ? AND contact_id = ? AND status = 'active'",
        db.now(), a.id, event.contactId,
      );
    }
  }

  const candidates = db.all("SELECT * FROM automations WHERE status = 'active' AND trigger_type = ?", type).map(parse);
  for (const a of candidates) {
    // Don't let an automation's own emails re-trigger itself in a loop.
    if (event.fromAutomationRun) {
      const src = db.get('SELECT automation_id FROM automation_runs WHERE id = ?', event.fromAutomationRun);
      if (src && src.automation_id === a.id) continue;
    }
    if (!matches(a.trigger_config, event)) continue;
    if (!a.allow_reentry) {
      const prior = db.get('SELECT id FROM automation_runs WHERE automation_id = ? AND contact_id = ?', a.id, event.contactId);
      if (prior) continue;
    } else {
      const active = db.get("SELECT id FROM automation_runs WHERE automation_id = ? AND contact_id = ? AND status = 'active'", a.id, event.contactId);
      if (active) continue;
    }
    created.push(startRun(a.id, event.contactId, { trigger: type, event }));
  }

  if (created.length && !kickScheduled && process.env.NODE_ENV !== 'test') {
    kickScheduled = true;
    setImmediate(() => {
      kickScheduled = false;
      processDue().catch((e) => console.error('[automations]', e));
    });
  }
  return created;
}

function conditionMet(condition, run) {
  const since = run.created_at;
  const c = run.contact_id;
  switch (condition) {
    case 'replied':
      return !!db.get('SELECT id FROM replies WHERE contact_id = ? AND received_at >= ?', c, since);
    case 'not_replied':
      return !conditionMet('replied', run);
    case 'opened':
      return !!db.get('SELECT id FROM messages WHERE contact_id = ? AND opened_at >= ?', c, since);
    case 'not_opened':
      return !conditionMet('opened', run);
    case 'clicked':
      return !!db.get('SELECT id FROM messages WHERE contact_id = ? AND clicked_at >= ?', c, since);
    case 'not_clicked':
      return !conditionMet('clicked', run);
    case 'unsubscribed':
      return !!db.get("SELECT id FROM contacts WHERE id = ? AND status != 'subscribed'", c);
    default:
      return false;
  }
}

async function executeStep(step, run, ctx) {
  const contacts = require('./contacts');
  const contact = contacts.getContact(run.contact_id);
  if (!contact) return { stop: true, note: 'contact deleted' };

  switch (step.type) {
    case 'wait': {
      if (ctx.waiting_step === run.step_index) {
        delete ctx.waiting_step;
        return { note: 'wait finished' };
      }
      const ms = Math.max(0, Number(step.amount || 0)) * (UNIT_MS[step.unit] || UNIT_MS.days);
      ctx.waiting_step = run.step_index;
      return { waitUntil: new Date(Date.now() + ms), note: `waiting ${step.amount} ${step.unit || 'days'}` };
    }
    case 'send_email': {
      const { createMessage, deliver } = require('./delivery');
      if (contact.status !== 'subscribed') return { stop: true, note: `contact ${contact.status}` };
      const template = db.get('SELECT * FROM templates WHERE id = ?', step.template_id);
      if (!template) throw new Error(`template ${step.template_id} not found`);
      let subject = step.subject || template.subject || '';
      let inReplyTo;
      // Optionally thread the email as a reply to the message that triggered the run.
      if (step.reply_in_thread && ctx.event?.messageId) {
        const orig = db.get('SELECT subject, message_id FROM messages WHERE id = ?', ctx.event.messageId);
        if (orig?.message_id) {
          inReplyTo = orig.message_id;
          if (!step.subject) subject = /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
        }
      }
      const msg = createMessage({ contactId: contact.id, templateId: template.id, subject, automationRunId: run.id });
      const status = await deliver(msg, { inReplyTo });
      if (status === 'failed') throw new Error(db.get('SELECT error FROM messages WHERE id = ?', msg.id).error);
      return { note: `email "${subject}" ${status}` };
    }
    case 'stop_if':
      return conditionMet(step.condition, run) ? { stop: true, note: `stopped: ${step.condition}` } : { note: `condition ${step.condition} not met` };
    case 'add_tag':
      contacts.addTag(contact.id, step.tag);
      return { note: `tag +${step.tag}` };
    case 'remove_tag':
      contacts.removeTag(contact.id, step.tag);
      return { note: `tag -${step.tag}` };
    case 'add_to_list':
      contacts.addToList(contact.id, step.list_id);
      return { note: `added to list ${step.list_id}` };
    case 'remove_from_list':
      contacts.removeFromList(contact.id, step.list_id);
      return { note: `removed from list ${step.list_id}` };
    case 'update_field': {
      const field = contacts.FIELDS.includes(step.field) || step.field === 'status' ? step.field : null;
      if (!field) throw new Error(`cannot update field ${step.field}`);
      db.run(`UPDATE contacts SET ${field} = ? WHERE id = ?`, step.value ?? '', contact.id);
      return { note: `${field} = ${step.value}` };
    }
    case 'notify': {
      const mailer = require('./mailer');
      const reply = ctx.event?.text ? `\n\nReply:\n${String(ctx.event.text).slice(0, 2000)}` : '';
      await mailer.send({
        to: step.email || db.getSetting('from_email'),
        subject: step.subject || `[Automation] ${ctx.automation_name}: ${contact.email}`,
        text: `Automation "${ctx.automation_name}" triggered by ${ctx.trigger} for ${contact.email} (${contact.first_name || ''} ${contact.last_name || ''}, ${contact.company || ''}).${reply}`,
      });
      return { note: `notified ${step.email || 'sender'}` };
    }
    case 'webhook': {
      const res = await fetch(step.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ automation: ctx.automation_name, trigger: ctx.trigger, event: ctx.event, contact }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      return { note: `webhook ${res.status}` };
    }
    default:
      throw new Error(`unknown step type ${step.type}`);
  }
}

async function processRun(run) {
  const automation = db.get('SELECT * FROM automations WHERE id = ?', run.automation_id);
  if (!automation) return;
  const { steps, name } = parse(automation);
  const ctx = db.json(run.context, {});
  ctx.automation_name = name;
  const log = db.json(run.log, []);
  const save = (fields) => {
    const keys = Object.keys(fields);
    db.run(
      `UPDATE automation_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, context = ?, log = ?, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => fields[k]), JSON.stringify(ctx), JSON.stringify(log.slice(-50)), db.now(), run.id,
    );
  };

  for (let guard = 0; guard < 50; guard++) {
    if (run.step_index >= steps.length) {
      save({ status: 'completed' });
      return;
    }
    const step = steps[run.step_index];
    try {
      const result = await executeStep(step, run, ctx);
      log.push({ at: db.now(), step: run.step_index, type: step.type, note: result.note });
      if (result.stop) {
        save({ status: 'stopped', step_index: run.step_index });
        return;
      }
      if (result.waitUntil) {
        save({ next_run_at: db.now(result.waitUntil), step_index: run.step_index });
        return;
      }
      run.step_index += 1;
      save({ step_index: run.step_index });
    } catch (err) {
      log.push({ at: db.now(), step: run.step_index, type: step.type, error: String(err.message || err) });
      save({ status: 'failed' });
      return;
    }
  }
}

let processing = null;

async function processAll() {
  for (let pass = 0; pass < 10; pass++) {
    const due = db.all(
      `SELECT r.* FROM automation_runs r JOIN automations a ON a.id = r.automation_id
       WHERE r.status = 'active' AND a.status = 'active' AND r.next_run_at <= ? ORDER BY r.next_run_at LIMIT 200`,
      db.now(),
    );
    if (!due.length) break;
    for (const run of due) await processRun(run);
  }
}

/** Advance every due run. Safe to call concurrently (calls are coalesced). */
function processDue() {
  if (!processing) {
    processing = processAll().finally(() => {
      processing = null;
    });
  }
  return processing;
}

module.exports = { TRIGGERS, STEP_TYPES, fire, startRun, processDue, processRun, matches, conditionMet, parse };
