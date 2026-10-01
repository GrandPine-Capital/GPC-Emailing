/* Campaigns, automations, replies, lead finder, settings, dashboard stats. */
const express = require('express');
const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const mailer = require('../lib/mailer');
const campaigns = require('../lib/campaigns');
const automations = require('../lib/automations');
const replies = require('../lib/replies');
const leads = require('../lib/leads');
const contacts = require('../lib/contacts');
const { COUNTRIES, INDUSTRIES } = require('../lib/leads/countries');
const { buildEmail, templateHtml } = require('../lib/personalize');

const router = express.Router();
const httpError = (status, message) => Object.assign(new Error(message), { status });

// --------------------------------------------------------------------- meta
router.get('/meta', (req, res) => {
  res.json({
    triggers: automations.TRIGGERS,
    stepTypes: automations.STEP_TYPES,
    countries: COUNTRIES,
    industries: INDUSTRIES,
    mergeTags: ['first_name', 'last_name', 'full_name', 'email', 'company', 'website', 'phone', 'country', 'industry', 'sender_name', 'company_address', 'unsubscribe_url'],
    dryRun: mailer.isDryRun(),
    imapConfigured: !!(db.getSetting('imap_host') && db.getSetting('imap_user')),
  });
});

router.get('/stats', (req, res) => {
  const n = (sql, ...p) => Number(db.get(sql, ...p).n || 0);
  const since = db.now(new Date(Date.now() - 30 * 86400e3));
  const sent30 = n("SELECT COUNT(*) n FROM messages WHERE status = 'sent' AND sent_at >= ?", since);
  const opened30 = n('SELECT COUNT(*) n FROM messages WHERE opened_at IS NOT NULL AND sent_at >= ?', since);
  const clicked30 = n('SELECT COUNT(*) n FROM messages WHERE clicked_at IS NOT NULL AND sent_at >= ?', since);
  const replied30 = n('SELECT COUNT(*) n FROM messages WHERE replied_at IS NOT NULL AND sent_at >= ?', since);
  const pct = (x) => (sent30 ? Math.round((x / sent30) * 1000) / 10 : 0);
  res.json({
    contacts: n('SELECT COUNT(*) n FROM contacts'),
    subscribed: n("SELECT COUNT(*) n FROM contacts WHERE status = 'subscribed'"),
    lists: n('SELECT COUNT(*) n FROM lists'),
    campaigns: n('SELECT COUNT(*) n FROM campaigns'),
    activeAutomations: n("SELECT COUNT(*) n FROM automations WHERE status = 'active'"),
    queued: n("SELECT COUNT(*) n FROM messages WHERE status = 'queued'"),
    sent30, opened30, clicked30, replied30,
    openRate: pct(opened30), clickRate: pct(clicked30), replyRate: pct(replied30),
    daily: db.all(
      `SELECT substr(created_at, 1, 10) day, SUM(type = 'sent') sent, SUM(type = 'open') opens, SUM(type = 'click') clicks, SUM(type = 'reply') replies
       FROM events WHERE created_at >= ? GROUP BY day ORDER BY day`,
      since,
    ),
    recentReplies: db.all(
      `SELECT r.id, r.from_email, r.subject, r.body, r.received_at, c.first_name, c.company
       FROM replies r LEFT JOIN contacts c ON c.id = r.contact_id ORDER BY r.id DESC LIMIT 5`,
    ),
  });
});

// ---------------------------------------------------------------- campaigns
const CAMPAIGN_FIELDS = ['name', 'subject', 'preheader', 'template_id', 'from_name', 'from_email', 'reply_to'];

function campaignRow(c) {
  return c && { ...c, list_ids: db.json(c.list_ids, []), stats: campaigns.stats(c.id) };
}

router.get('/campaigns', (req, res) => {
  res.json(db.all(
    'SELECT c.*, t.name template_name FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id ORDER BY c.id DESC',
  ).map(campaignRow));
});

router.get('/campaigns/:id', (req, res) => {
  const c = campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id));
  if (!c) throw httpError(404, 'Campaign not found');
  c.recipients = campaigns.recipients({ list_ids: JSON.stringify(c.list_ids) }).length;
  c.links = db.all(
    `SELECT json_extract(e.data, '$.url') url, COUNT(*) clicks, COUNT(DISTINCT e.contact_id) people
     FROM events e JOIN messages m ON m.id = e.message_id WHERE e.type = 'click' AND m.campaign_id = ? GROUP BY url ORDER BY clicks DESC LIMIT 20`,
    c.id,
  );
  res.json(c);
});

router.get('/campaigns/:id/messages', (req, res) => {
  const filter = { opened: 'AND m.opened_at IS NOT NULL', clicked: 'AND m.clicked_at IS NOT NULL', replied: 'AND m.replied_at IS NOT NULL', failed: "AND m.status = 'failed'" }[req.query.filter] || '';
  res.json(db.all(
    `SELECT m.id, m.status, m.error, m.sent_at, m.opened_at, m.open_count, m.clicked_at, m.click_count, m.replied_at,
            c.id contact_id, c.email, c.first_name, c.last_name, c.company
     FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.campaign_id = ? ${filter} ORDER BY m.id LIMIT 1000`,
    req.params.id,
  ));
});

router.post('/campaigns', (req, res) => {
  const b = req.body;
  const r = db.run(
    'INSERT INTO campaigns (name, subject, preheader, template_id, from_name, from_email, reply_to, list_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    b.name || 'Untitled campaign', b.subject || '', b.preheader || '', b.template_id || null,
    b.from_name || '', b.from_email || '', b.reply_to || '', JSON.stringify((b.list_ids || []).map(Number)),
  );
  res.status(201).json(campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', Number(r.lastInsertRowid))));
});

router.put('/campaigns/:id', (req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) throw httpError(404, 'Campaign not found');
  if (!['draft', 'scheduled', 'paused'].includes(c.status)) throw httpError(400, `Cannot edit a ${c.status} campaign`);
  const sets = [];
  const params = [];
  for (const f of CAMPAIGN_FIELDS) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(req.body[f] === '' && f === 'template_id' ? null : req.body[f]);
    }
  }
  if (req.body.list_ids) {
    sets.push('list_ids = ?');
    params.push(JSON.stringify(req.body.list_ids.map(Number)));
  }
  if (sets.length) db.run(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`, ...params, c.id);
  res.json(campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', c.id)));
});

router.delete('/campaigns/:id', (req, res) => {
  db.run('DELETE FROM campaigns WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

router.post('/campaigns/:id/send', (req, res) => {
  const result = campaigns.launch(Number(req.params.id));
  campaigns.processQueue().catch((e) => console.error('[campaigns]', e));
  res.json(result);
});

router.post('/campaigns/:id/schedule', (req, res) => {
  const when = new Date(req.body.scheduled_at);
  if (Number.isNaN(when.getTime())) throw httpError(400, 'Invalid date');
  const c = db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c || !['draft', 'scheduled'].includes(c.status)) throw httpError(400, 'Only draft campaigns can be scheduled');
  if (!c.template_id) throw httpError(400, 'Choose a template first');
  db.run("UPDATE campaigns SET status = 'scheduled', scheduled_at = ? WHERE id = ?", db.now(when), c.id);
  res.json(campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', c.id)));
});

router.post('/campaigns/:id/unschedule', (req, res) => {
  db.run("UPDATE campaigns SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'", req.params.id);
  res.json(campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id)));
});

router.post('/campaigns/:id/pause', (req, res) => {
  db.run("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'sending'", req.params.id);
  res.json(campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id)));
});

router.post('/campaigns/:id/resume', (req, res) => {
  db.run("UPDATE campaigns SET status = 'sending' WHERE id = ? AND status = 'paused'", req.params.id);
  res.json(campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id)));
});

router.post('/campaigns/:id/duplicate', (req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  if (!c) throw httpError(404, 'Campaign not found');
  const r = db.run(
    'INSERT INTO campaigns (name, subject, preheader, template_id, from_name, from_email, reply_to, list_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `${c.name} (copy)`, c.subject, c.preheader, c.template_id, c.from_name, c.from_email, c.reply_to, c.list_ids,
  );
  res.status(201).json(campaignRow(db.get('SELECT * FROM campaigns WHERE id = ?', Number(r.lastInsertRowid))));
});

router.post('/campaigns/:id/test', async (req, res) => {
  const c = db.get('SELECT * FROM campaigns WHERE id = ?', req.params.id);
  const t = c && db.get('SELECT * FROM templates WHERE id = ?', c.template_id);
  if (!t) throw httpError(400, 'Choose a template first');
  if (!contacts.isEmail(req.body.email)) throw httpError(400, 'Enter a valid email address');
  const contact = db.get('SELECT * FROM contacts WHERE email = ?', req.body.email) || { email: req.body.email, first_name: 'Alex', company: 'Sample Co' };
  const email = buildEmail({ html: templateHtml(t), subject: `[TEST] ${c.subject || t.subject}`, contact, token: 'test', track: false });
  const r = await mailer.send({ to: req.body.email, subject: email.subject, html: email.html, text: email.text, fromName: c.from_name, fromEmail: c.from_email, replyTo: c.reply_to });
  res.json({ ok: true, dryRun: r.dryRun });
});

// -------------------------------------------------------------- automations
function automationRow(a) {
  if (!a) return a;
  const out = automations.parse(a);
  const counts = db.all('SELECT status, COUNT(*) n FROM automation_runs WHERE automation_id = ? GROUP BY status', a.id);
  out.runs = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  return out;
}

function validateAutomation(b) {
  if (!automations.TRIGGERS[b.trigger_type]) throw httpError(400, 'Choose a valid trigger');
  for (const [i, s] of (b.steps || []).entries()) {
    if (!automations.STEP_TYPES[s.type]) throw httpError(400, `Step ${i + 1}: unknown type`);
    if (s.type === 'send_email' && !s.template_id) throw httpError(400, `Step ${i + 1}: choose a template`);
    if (s.type === 'webhook' && !/^https?:\/\//.test(s.url || '')) throw httpError(400, `Step ${i + 1}: webhook URL required`);
  }
}

router.get('/automations', (req, res) => {
  res.json(db.all('SELECT * FROM automations ORDER BY id DESC').map(automationRow));
});

router.get('/automations/:id', (req, res) => {
  const a = automationRow(db.get('SELECT * FROM automations WHERE id = ?', req.params.id));
  if (!a) throw httpError(404, 'Automation not found');
  a.recent = db.all(
    `SELECT r.id, r.status, r.step_index, r.next_run_at, r.log, r.created_at, c.email
     FROM automation_runs r JOIN contacts c ON c.id = r.contact_id WHERE r.automation_id = ? ORDER BY r.id DESC LIMIT 50`,
    a.id,
  ).map((r) => ({ ...r, log: db.json(r.log, []) }));
  res.json(a);
});

router.post('/automations', (req, res) => {
  const b = req.body;
  validateAutomation(b);
  const r = db.run(
    'INSERT INTO automations (name, trigger_type, trigger_config, steps, status, allow_reentry) VALUES (?, ?, ?, ?, ?, ?)',
    b.name || 'Untitled automation', b.trigger_type, JSON.stringify(b.trigger_config || {}), JSON.stringify(b.steps || []),
    b.status === 'active' ? 'active' : 'paused', b.allow_reentry ? 1 : 0,
  );
  res.status(201).json(automationRow(db.get('SELECT * FROM automations WHERE id = ?', Number(r.lastInsertRowid))));
});

router.put('/automations/:id', (req, res) => {
  const b = req.body;
  validateAutomation(b);
  db.run(
    'UPDATE automations SET name = ?, trigger_type = ?, trigger_config = ?, steps = ?, status = ?, allow_reentry = ? WHERE id = ?',
    b.name, b.trigger_type, JSON.stringify(b.trigger_config || {}), JSON.stringify(b.steps || []),
    b.status === 'active' ? 'active' : 'paused', b.allow_reentry ? 1 : 0, req.params.id,
  );
  res.json(automationRow(db.get('SELECT * FROM automations WHERE id = ?', req.params.id)));
});

for (const [action, status] of [['activate', 'active'], ['pause', 'paused']]) {
  router.post(`/automations/:id/${action}`, (req, res) => {
    db.run('UPDATE automations SET status = ? WHERE id = ?', status, req.params.id);
    res.json(automationRow(db.get('SELECT * FROM automations WHERE id = ?', req.params.id)));
  });
}

router.delete('/automations/:id', (req, res) => {
  db.run('DELETE FROM automations WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

/** Manually enrol contacts (or a whole list) into an automation. */
router.post('/automations/:id/enroll', (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id = ?', req.params.id);
  if (!a) throw httpError(404, 'Automation not found');
  let ids = (req.body.contact_ids || []).map(Number);
  if (req.body.list_id) {
    ids = ids.concat(db.all("SELECT c.id FROM contacts c JOIN list_contacts lc ON lc.contact_id = c.id WHERE lc.list_id = ? AND c.status = 'subscribed'", req.body.list_id).map((r) => r.id));
  }
  let enrolled = 0;
  for (const id of new Set(ids)) {
    if (db.get("SELECT id FROM automation_runs WHERE automation_id = ? AND contact_id = ? AND status = 'active'", a.id, id)) continue;
    automations.startRun(a.id, id, { trigger: 'manual', event: { contactId: id } });
    enrolled++;
  }
  automations.processDue().catch((e) => console.error('[automations]', e));
  res.json({ enrolled });
});

router.post('/automation-runs/:id/stop', (req, res) => {
  db.run("UPDATE automation_runs SET status = 'stopped' WHERE id = ? AND status = 'active'", req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ replies
router.get('/replies', (req, res) => {
  res.json(db.all(
    `SELECT r.*, c.first_name, c.last_name, c.company, m.subject original_subject, cp.name campaign
     FROM replies r LEFT JOIN contacts c ON c.id = r.contact_id LEFT JOIN messages m ON m.id = r.message_id
     LEFT JOIN campaigns cp ON cp.id = m.campaign_id ORDER BY r.id DESC LIMIT 200`,
  ));
});

router.post('/replies/poll', async (req, res) => {
  res.json(await replies.pollImap());
});

/** Manually log a reply (e.g. a reply received on another channel). */
router.post('/replies', (req, res) => {
  const reply = replies.recordReply({ from: req.body.from, subject: req.body.subject, text: req.body.text });
  if (!reply) throw httpError(400, 'No contact found with that email address');
  res.status(201).json(reply);
});

// -------------------------------------------------------------- lead finder
router.post('/leads/search', (req, res) => {
  const b = req.body;
  const params = {
    countries: [].concat(b.countries || []).filter(Boolean),
    industries: [].concat(b.industries || []).filter(Boolean),
    keywords: String(b.keywords || '').trim(),
    sources: [].concat(b.sources || ['web']),
    urls: String(b.urls || '').split(/[\s,]+/).filter(Boolean),
    limit: Number(b.limit) || 100,
    perSiteMaxEmails: Number(b.perSiteMaxEmails) || 3,
    pages: Math.min(Number(b.pages) || 2, 5),
  };
  if (!params.countries.length && !params.industries.length && !params.keywords && !params.urls.length) {
    throw httpError(400, 'Choose at least one country, industry, keyword or URL');
  }
  const id = leads.createSearch(params);
  leads.runSearch(id, params).catch((e) => console.error('[leads]', e));
  res.status(202).json({ id });
});

router.get('/leads/searches', (req, res) => {
  res.json(db.all('SELECT * FROM lead_searches ORDER BY id DESC LIMIT 50').map((s) => ({ ...s, params: db.json(s.params, {}) })));
});

router.get('/leads/searches/:id', (req, res) => {
  const s = db.get('SELECT * FROM lead_searches WHERE id = ?', req.params.id);
  if (!s) throw httpError(404, 'Search not found');
  s.params = db.json(s.params, {});
  s.leads = db.all(
    `SELECT l.*, EXISTS (SELECT 1 FROM contacts c WHERE c.email = l.email) in_contacts FROM leads l WHERE l.search_id = ? ORDER BY l.id`,
    s.id,
  );
  res.json(s);
});

router.delete('/leads/searches/:id', (req, res) => {
  db.run('DELETE FROM lead_searches WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

router.post('/leads/import', (req, res) => {
  const ids = (req.body.lead_ids || []).map(Number);
  const listIds = req.body.list_id ? [Number(req.body.list_id)] : [];
  const tags = contacts.normaliseTags(req.body.tags);
  const result = { created: 0, updated: 0, skipped: 0 };
  db.transaction(() => {
    for (const id of ids) {
      const l = db.get('SELECT * FROM leads WHERE id = ?', id);
      if (!l || !contacts.isEmail(l.email)) {
        result.skipped++;
        continue;
      }
      const r = contacts.upsertContact(
        { email: l.email, first_name: l.first_name, last_name: l.last_name, company: l.company, website: l.website, country: l.country, industry: l.industry },
        { listIds, tags: [...tags, 'lead-finder'], source: `lead:${l.source}` },
      );
      r.created ? result.created++ : result.updated++;
      db.run('UPDATE leads SET imported = 1 WHERE id = ?', id);
    }
  });
  res.json(result);
});

// ----------------------------------------------------------------- settings
router.get('/settings', (req, res) => {
  const s = db.getSettings();
  for (const k of config.secretSettings) s[k] = s[k] ? '********' : '';
  delete s.imap_last_uid;
  delete s.imap_uid_validity;
  res.json({ ...s, inbound_webhook_url: `${s.base_url.replace(/\/+$/, '')}/api/inbound/reply?key=${inboundKey()}` });
});

router.put('/settings', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (!(k in config.settingDefaults)) continue;
    if (config.secretSettings.includes(k) && v === '********') continue; // unchanged secret
    db.setSetting(k, v);
  }
  res.json({ ok: true });
});

router.post('/settings/test-smtp', async (req, res) => {
  try {
    res.json(await mailer.verifyConnection());
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.post('/settings/test-imap', async (req, res) => {
  try {
    const r = await replies.pollImap();
    res.json(r.skipped ? { ok: false, message: 'IMAP is not configured (or a poll is in progress).' } : { ok: true, message: `Connected. ${r.found} new repl${r.found === 1 ? 'y' : 'ies'} found.` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

function inboundKey() {
  return crypto.createHmac('sha256', config.appSecret).update('inbound-reply').digest('hex').slice(0, 24);
}

module.exports = { router, inboundKey };
