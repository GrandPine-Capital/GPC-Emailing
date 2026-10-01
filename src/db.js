const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'custom',
  mode TEXT NOT NULL DEFAULT 'dragdrop',      -- dragdrop | html
  subject TEXT DEFAULT '',
  design TEXT,                               -- JSON {settings, blocks} for dragdrop mode
  html TEXT DEFAULT '',                      -- source for html mode / rendered output for dragdrop
  is_standard INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  company TEXT DEFAULT '',
  website TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  country TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'subscribed',          -- subscribed | unsubscribed | bounced
  replied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_contacts (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  preheader TEXT DEFAULT '',
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  from_name TEXT DEFAULT '',
  from_email TEXT DEFAULT '',
  reply_to TEXT DEFAULT '',
  list_ids TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',               -- draft | scheduled | sending | sent | paused
  scheduled_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  automation_run_id INTEGER REFERENCES automation_runs(id) ON DELETE SET NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  template_id INTEGER,
  subject TEXT DEFAULT '',
  message_id TEXT,                           -- RFC 5322 Message-ID header
  status TEXT DEFAULT 'queued',              -- queued | sent | failed | skipped
  error TEXT,
  sent_at TEXT,
  opened_at TEXT,
  open_count INTEGER DEFAULT 0,
  clicked_at TEXT,
  click_count INTEGER DEFAULT 0,
  replied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                        -- sent | open | click | reply | unsubscribe | failed
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  data TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,                -- email_sent | email_opened | link_clicked | reply_received | contact_added | manual
  trigger_config TEXT DEFAULT '{}',
  steps TEXT DEFAULT '[]',
  status TEXT DEFAULT 'paused',              -- active | paused
  allow_reentry INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  step_index INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',              -- active | completed | stopped | failed
  next_run_at TEXT DEFAULT (datetime('now')),
  context TEXT DEFAULT '{}',
  log TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_due ON automation_runs(status, next_run_at);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  from_email TEXT,
  subject TEXT,
  body TEXT,
  header_message_id TEXT UNIQUE,
  received_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  params TEXT DEFAULT '{}',
  status TEXT DEFAULT 'running',             -- running | done | failed
  progress TEXT DEFAULT '',
  results_count INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER REFERENCES lead_searches(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  position TEXT DEFAULT '',
  company TEXT DEFAULT '',
  website TEXT DEFAULT '',
  country TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  source TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  imported INTEGER DEFAULT 0,
  UNIQUE (search_id, email)
);
`;

let db;

function init(file = config.databasePath) {
  if (db) db.close();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function conn() {
  if (!db) init();
  return db;
}

// node:sqlite does not accept `undefined` or booleans as bind values.
function clean(params) {
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
}

const all = (sql, ...params) => conn().prepare(sql).all(...clean(params));
const get = (sql, ...params) => conn().prepare(sql).get(...clean(params));
const run = (sql, ...params) => conn().prepare(sql).run(...clean(params));

function transaction(fn) {
  conn().exec('BEGIN');
  try {
    const result = fn();
    conn().exec('COMMIT');
    return result;
  } catch (err) {
    conn().exec('ROLLBACK');
    throw err;
  }
}

function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (row && row.value !== null && row.value !== '') return row.value;
  return config.settingDefaults[key] ?? '';
}

function getSettings() {
  const out = { ...config.settingDefaults };
  for (const row of all('SELECT key, value FROM settings')) {
    if (row.value !== null && row.value !== '') out[row.key] = row.value;
  }
  return out;
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value == null ? '' : String(value),
  );
}

const json = (value, fallback) => {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

// SQLite-compatible UTC timestamp ("YYYY-MM-DD HH:MM:SS").
const now = (date = new Date()) => date.toISOString().replace('T', ' ').slice(0, 19);

module.exports = { init, conn, all, get, run, transaction, getSetting, getSettings, setSetting, json, now };
