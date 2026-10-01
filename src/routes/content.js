/* Templates, lists, contacts (incl. CSV import/export). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const config = require('../config');
const db = require('../db');
const mailer = require('../lib/mailer');
const contacts = require('../lib/contacts');
const { renderDesign } = require('../lib/render-blocks');
const { buildEmail, templateHtml } = require('../lib/personalize');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const httpError = (status, message) => Object.assign(new Error(message), { status });
const SAMPLE_CONTACT = {
  email: 'test@example.com', first_name: 'Alex', last_name: 'Tan', company: 'Sample Sdn Bhd',
  country: 'Malaysia', industry: 'Information Technology', website: 'https://example.com',
};

// ---------------------------------------------------------------- templates
function templateRow(t) {
  return t && { ...t, design: db.json(t.design, null) };
}

function templateFields(body) {
  const mode = body.mode === 'html' ? 'html' : 'dragdrop';
  const design = mode === 'dragdrop' ? body.design || { settings: {}, blocks: [] } : null;
  return {
    name: String(body.name || 'Untitled template'),
    category: String(body.category || 'custom'),
    mode,
    subject: String(body.subject || ''),
    design: design ? JSON.stringify(design) : null,
    html: mode === 'dragdrop' ? renderDesign(design) : String(body.html || ''),
  };
}

router.get('/templates', (req, res) => {
  res.json(db.all('SELECT id, name, category, mode, subject, is_standard, html, updated_at FROM templates ORDER BY is_standard DESC, updated_at DESC'));
});

router.get('/templates/:id', (req, res) => {
  const t = templateRow(db.get('SELECT * FROM templates WHERE id = ?', req.params.id));
  if (!t) throw httpError(404, 'Template not found');
  res.json(t);
});

router.post('/templates', (req, res) => {
  const f = templateFields(req.body);
  const r = db.run(
    'INSERT INTO templates (name, category, mode, subject, design, html) VALUES (?, ?, ?, ?, ?, ?)',
    f.name, f.category, f.mode, f.subject, f.design, f.html,
  );
  res.status(201).json(templateRow(db.get('SELECT * FROM templates WHERE id = ?', Number(r.lastInsertRowid))));
});

router.put('/templates/:id', (req, res) => {
  if (!db.get('SELECT id FROM templates WHERE id = ?', req.params.id)) throw httpError(404, 'Template not found');
  const f = templateFields(req.body);
  db.run(
    "UPDATE templates SET name = ?, category = ?, mode = ?, subject = ?, design = ?, html = ?, updated_at = datetime('now') WHERE id = ?",
    f.name, f.category, f.mode, f.subject, f.design, f.html, req.params.id,
  );
  res.json(templateRow(db.get('SELECT * FROM templates WHERE id = ?', req.params.id)));
});

router.post('/templates/:id/duplicate', (req, res) => {
  const t = db.get('SELECT * FROM templates WHERE id = ?', req.params.id);
  if (!t) throw httpError(404, 'Template not found');
  const r = db.run(
    'INSERT INTO templates (name, category, mode, subject, design, html) VALUES (?, ?, ?, ?, ?, ?)',
    `${t.name} (copy)`, t.category, t.mode, t.subject, t.design, t.html,
  );
  res.status(201).json(templateRow(db.get('SELECT * FROM templates WHERE id = ?', Number(r.lastInsertRowid))));
});

router.delete('/templates/:id', (req, res) => {
  db.run('DELETE FROM templates WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

/** Render an unsaved design (used for previews). */
router.post('/templates/render', (req, res) => {
  const html = req.body.mode === 'html' ? String(req.body.html || '') : renderDesign(req.body.design);
  const preview = buildEmail({ html, subject: req.body.subject || '', contact: SAMPLE_CONTACT, token: 'preview', track: false });
  res.json({ html, preview: preview.html, subject: preview.subject });
});

router.post('/templates/:id/test', async (req, res) => {
  const t = db.get('SELECT * FROM templates WHERE id = ?', req.params.id);
  if (!t) throw httpError(404, 'Template not found');
  if (!contacts.isEmail(req.body.email)) throw httpError(400, 'Enter a valid email address');
  const contact = db.get('SELECT * FROM contacts WHERE email = ?', req.body.email) || { ...SAMPLE_CONTACT, email: req.body.email };
  const email = buildEmail({ html: templateHtml(t), subject: `[TEST] ${t.subject || t.name}`, contact, token: 'test', track: false });
  const r = await mailer.send({ to: req.body.email, subject: email.subject, html: email.html, text: email.text });
  res.json({ ok: true, dryRun: r.dryRun });
});

// ------------------------------------------------------------------ uploads
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/uploads', imageUpload.single('file'), (req, res) => {
  const ext = req.file && IMAGE_TYPES[req.file.mimetype];
  if (!ext) throw httpError(400, 'Upload a PNG, JPG, GIF or WebP image (max 5 MB)');
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(config.uploadsDir, name), req.file.buffer);
  res.status(201).json({ url: `${db.getSetting('base_url').replace(/\/+$/, '')}/uploads/${name}` });
});

// -------------------------------------------------------------------- lists
router.get('/lists', (req, res) => {
  res.json(db.all(
    `SELECT l.*, COUNT(lc.contact_id) contacts,
       SUM(CASE WHEN c.status = 'subscribed' THEN 1 ELSE 0 END) subscribed
     FROM lists l LEFT JOIN list_contacts lc ON lc.list_id = l.id LEFT JOIN contacts c ON c.id = lc.contact_id
     GROUP BY l.id ORDER BY l.name`,
  ));
});

router.post('/lists', (req, res) => {
  if (!req.body.name) throw httpError(400, 'Name is required');
  const r = db.run('INSERT INTO lists (name, description) VALUES (?, ?)', req.body.name, req.body.description || '');
  res.status(201).json(db.get('SELECT * FROM lists WHERE id = ?', Number(r.lastInsertRowid)));
});

router.put('/lists/:id', (req, res) => {
  db.run('UPDATE lists SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?', req.body.name, req.body.description, req.params.id);
  res.json(db.get('SELECT * FROM lists WHERE id = ?', req.params.id));
});

router.delete('/lists/:id', (req, res) => {
  db.run('DELETE FROM lists WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

router.post('/lists/:id/contacts', (req, res) => {
  let added = 0;
  for (const id of req.body.contact_ids || []) if (contacts.addToList(Number(id), Number(req.params.id))) added++;
  res.json({ added });
});

router.post('/lists/:id/remove-contacts', (req, res) => {
  for (const id of req.body.contact_ids || []) contacts.removeFromList(Number(id), Number(req.params.id));
  res.json({ ok: true });
});

// ----------------------------------------------------------------- contacts
function contactFilter(q) {
  const where = [];
  const params = [];
  if (q.q) {
    where.push('(c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.company LIKE ?)');
    params.push(...Array(4).fill(`%${q.q}%`));
  }
  for (const f of ['status', 'country', 'industry']) {
    if (q[f]) {
      where.push(`c.${f} = ?`);
      params.push(q[f]);
    }
  }
  if (q.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(c.tags) WHERE value = ?)');
    params.push(q.tag);
  }
  if (q.list_id) {
    where.push('EXISTS (SELECT 1 FROM list_contacts lc WHERE lc.contact_id = c.id AND lc.list_id = ?)');
    params.push(q.list_id);
  }
  if (q.replied === '1') where.push('c.replied_at IS NOT NULL');
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/contacts', (req, res) => {
  const { sql, params } = contactFilter(req.query);
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, (Number(req.query.page) || 1) - 1) * limit;
  const total = db.get(`SELECT COUNT(*) n FROM contacts c ${sql}`, ...params).n;
  const rows = db.all(
    `SELECT c.*, (SELECT group_concat(list_id) FROM list_contacts WHERE contact_id = c.id) list_ids
     FROM contacts c ${sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  ).map((c) => ({ ...c, tags: db.json(c.tags, []), list_ids: c.list_ids ? String(c.list_ids).split(',').map(Number) : [] }));
  res.json({ total, rows });
});

router.get('/contacts/facets', (req, res) => {
  res.json({
    countries: db.all("SELECT country v, COUNT(*) n FROM contacts WHERE country != '' GROUP BY country ORDER BY n DESC").map((r) => r.v),
    industries: db.all("SELECT industry v, COUNT(*) n FROM contacts WHERE industry != '' GROUP BY industry ORDER BY n DESC").map((r) => r.v),
    tags: db.all('SELECT DISTINCT j.value v FROM contacts, json_each(contacts.tags) j ORDER BY v').map((r) => r.v),
  });
});

router.get('/contacts/:id', (req, res) => {
  const c = contacts.getContact(req.params.id);
  if (!c) throw httpError(404, 'Contact not found');
  c.list_ids = db.all('SELECT list_id FROM list_contacts WHERE contact_id = ?', c.id).map((r) => r.list_id);
  c.messages = db.all(
    `SELECT m.id, m.subject, m.status, m.sent_at, m.opened_at, m.clicked_at, m.replied_at, cp.name campaign
     FROM messages m LEFT JOIN campaigns cp ON cp.id = m.campaign_id WHERE m.contact_id = ? ORDER BY m.id DESC LIMIT 50`,
    c.id,
  );
  c.replies = db.all('SELECT id, subject, body, received_at FROM replies WHERE contact_id = ? ORDER BY id DESC LIMIT 20', c.id);
  res.json(c);
});

router.post('/contacts', (req, res) => {
  const { id, created } = contacts.upsertContact(req.body, { listIds: req.body.list_ids || [], overwrite: true });
  res.status(created ? 201 : 200).json(contacts.getContact(id));
});

router.put('/contacts/:id', (req, res) => {
  const c = contacts.getContact(req.params.id);
  if (!c) throw httpError(404, 'Contact not found');
  const sets = [];
  const params = [];
  for (const f of [...contacts.FIELDS, 'email', 'status']) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(String(req.body[f]).trim());
    }
  }
  if (req.body.tags !== undefined) {
    sets.push('tags = ?');
    params.push(JSON.stringify(contacts.normaliseTags(req.body.tags)));
  }
  if (sets.length) db.run(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`, ...params, c.id);
  if (Array.isArray(req.body.list_ids)) {
    const wanted = new Set(req.body.list_ids.map(Number));
    for (const { list_id } of db.all('SELECT list_id FROM list_contacts WHERE contact_id = ?', c.id)) {
      if (!wanted.has(list_id)) contacts.removeFromList(c.id, list_id);
    }
    for (const id of wanted) contacts.addToList(c.id, id);
  }
  res.json(contacts.getContact(c.id));
});

router.delete('/contacts/:id', (req, res) => {
  db.run('DELETE FROM contacts WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

router.post('/contacts/bulk', (req, res) => {
  const ids = (req.body.ids || []).map(Number);
  const action = req.body.action;
  for (const id of ids) {
    if (action === 'delete') db.run('DELETE FROM contacts WHERE id = ?', id);
    else if (action === 'unsubscribe') db.run("UPDATE contacts SET status = 'unsubscribed' WHERE id = ?", id);
    else if (action === 'resubscribe') db.run("UPDATE contacts SET status = 'subscribed' WHERE id = ?", id);
    else if (action === 'add_tag') contacts.addTag(id, req.body.tag);
    else if (action === 'add_to_list') contacts.addToList(id, Number(req.body.list_id));
    else if (action === 'remove_from_list') contacts.removeFromList(id, Number(req.body.list_id));
    else throw httpError(400, `Unknown action ${action}`);
  }
  res.json({ ok: true, count: ids.length });
});

const HEADER_MAP = {
  email: ['email', 'e-mail', 'email address', 'emailaddress', 'mail'],
  first_name: ['first name', 'firstname', 'first_name', 'given name', 'fname'],
  last_name: ['last name', 'lastname', 'last_name', 'surname', 'family name', 'lname'],
  name: ['name', 'full name', 'fullname', 'contact name'],
  company: ['company', 'company name', 'organization', 'organisation', 'business', 'account'],
  website: ['website', 'url', 'web', 'domain', 'site'],
  phone: ['phone', 'phone number', 'mobile', 'tel', 'telephone', 'whatsapp'],
  country: ['country', 'nation', 'location'],
  industry: ['industry', 'sector', 'category', 'vertical'],
  tags: ['tags', 'tag', 'labels', 'groups'],
};

function mapRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const k = key.trim().toLowerCase().replace(/\s+/g, ' ');
    const field = Object.keys(HEADER_MAP).find((f) => HEADER_MAP[f].includes(k));
    if (field && value !== '' && out[field] === undefined) out[field] = String(value).trim();
  }
  if (out.name && !out.first_name) {
    const [first, ...rest] = out.name.split(/\s+/);
    out.first_name = first;
    out.last_name = out.last_name || rest.join(' ');
  }
  delete out.name;
  return out;
}

router.post('/contacts/import', upload.single('file'), (req, res) => {
  const csv = req.file ? req.file.buffer.toString('utf8') : String(req.body.csv || '');
  if (!csv.trim()) throw httpError(400, 'Upload a CSV file or paste CSV text');
  const firstLine = csv.split(/\r?\n/)[0];
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  let rows;
  try {
    rows = parseCsv(csv.replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, delimiter });
  } catch (err) {
    throw httpError(400, `Could not parse CSV: ${err.message}`);
  }
  const listIds = [].concat(req.body.list_id || req.body.list_ids || []).flatMap((v) => String(v).split(',')).map(Number).filter(Boolean);
  const tags = contacts.normaliseTags(req.body.tags);
  const defaults = { country: req.body.country || '', industry: req.body.industry || '' };
  const result = { total: rows.length, created: 0, updated: 0, skipped: 0, errors: [] };
  db.transaction(() => {
    rows.forEach((row, i) => {
      const data = { ...defaults, ...mapRow(row) };
      if (!contacts.isEmail(data.email)) {
        result.skipped++;
        if (result.errors.length < 20) result.errors.push(`Row ${i + 2}: invalid or missing email "${data.email || ''}"`);
        return;
      }
      const r = contacts.upsertContact(data, { listIds, tags, source: 'import' });
      r.created ? result.created++ : result.updated++;
    });
  });
  res.json(result);
});

router.get('/contacts-export.csv', (req, res) => {
  const { sql, params } = contactFilter(req.query);
  const rows = db.all(`SELECT * FROM contacts c ${sql} ORDER BY c.id`, ...params);
  const cols = ['email', 'first_name', 'last_name', 'company', 'website', 'phone', 'country', 'industry', 'tags', 'status', 'source', 'replied_at', 'created_at'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => q(c === 'tags' ? db.json(r.tags, []).join(';') : r[c])).join(','))];
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="contacts.csv"');
  res.send(lines.join('\n'));
});

module.exports = router;
