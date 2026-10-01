const db = require('../db');

const FIELDS = ['first_name', 'last_name', 'company', 'website', 'phone', 'country', 'industry'];

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());

function normaliseTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,;|]/);
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
}

function getContact(id) {
  const c = db.get('SELECT * FROM contacts WHERE id = ?', id);
  if (c) c.tags = db.json(c.tags, []);
  return c;
}

const automations = () => require('./automations');

/** Add a contact to a list and fire the `contact_added` automation trigger. */
function addToList(contactId, listId) {
  const res = db.run('INSERT OR IGNORE INTO list_contacts (list_id, contact_id) VALUES (?, ?)', listId, contactId);
  if (res.changes > 0) automations().fire('contact_added', { contactId, listId: Number(listId) });
  return res.changes > 0;
}

function removeFromList(contactId, listId) {
  db.run('DELETE FROM list_contacts WHERE list_id = ? AND contact_id = ?', listId, contactId);
}

/**
 * Create or update a contact by email. Existing non-empty fields are kept
 * unless `overwrite` is set; tags are merged. Returns { id, created }.
 */
function upsertContact(data, { listIds = [], source = 'manual', overwrite = false, tags = [] } = {}) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw Object.assign(new Error(`Invalid email: ${data.email}`), { status: 400 });

  const existing = db.get('SELECT * FROM contacts WHERE email = ?', email);
  const newTags = normaliseTags([...normaliseTags(data.tags), ...normaliseTags(tags)]);
  let id;
  let created = false;

  if (existing) {
    id = existing.id;
    const sets = [];
    const params = [];
    for (const f of FIELDS) {
      if (data[f] != null && data[f] !== '' && (overwrite || !existing[f])) {
        sets.push(`${f} = ?`);
        params.push(String(data[f]).trim());
      }
    }
    const merged = normaliseTags([...db.json(existing.tags, []), ...newTags]);
    sets.push('tags = ?');
    params.push(JSON.stringify(merged));
    if (data.status && overwrite) {
      sets.push('status = ?');
      params.push(data.status);
    }
    db.run(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  } else {
    const res = db.run(
      `INSERT INTO contacts (email, ${FIELDS.join(', ')}, tags, source, status) VALUES (?, ${FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`,
      email,
      ...FIELDS.map((f) => (data[f] == null ? '' : String(data[f]).trim())),
      JSON.stringify(newTags),
      data.source || source,
      data.status || 'subscribed',
    );
    id = Number(res.lastInsertRowid);
    created = true;
  }

  for (const listId of listIds) addToList(id, listId);
  return { id, created };
}

function addTag(contactId, tag) {
  const c = getContact(contactId);
  if (!c) return;
  db.run('UPDATE contacts SET tags = ? WHERE id = ?', JSON.stringify(normaliseTags([...c.tags, tag])), contactId);
}

function removeTag(contactId, tag) {
  const c = getContact(contactId);
  if (!c) return;
  db.run('UPDATE contacts SET tags = ? WHERE id = ?', JSON.stringify(c.tags.filter((t) => t !== tag)), contactId);
}

module.exports = { FIELDS, isEmail, normaliseTags, getContact, upsertContact, addToList, removeFromList, addTag, removeTag };
