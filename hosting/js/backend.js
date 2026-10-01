/*
 * Client-side "API": implements the dashboard's REST-style calls
 * (App.api('GET', '/campaigns') ...) directly on Cloud Firestore, and hands
 * work that needs Gmail / the network to the Apps Script worker.
 */
import { db, auth, fs } from './firebase.js';

const {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, query, where, orderBy, limit, startAfter,
  writeBatch, increment, arrayUnion, arrayRemove, getCountFromServer, documentId,
} = fs;
const Core = window.EmailCore;
const Catalog = window.EmailCatalog;
const Render = window.EmailRender;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const nowIso = () => new Date().toISOString();
const col = (name) => collection(db, name);
const ref = (path) => doc(db, path);
const data = (snap) => (snap.exists() ? { id: snap.id, ...snap.data() } : null);
const rows = async (q) => (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
const count = async (q) => (await getCountFromServer(q)).data().count;
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sortBy = (arr, key, desc = true) => arr.sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || '')) * (desc ? -1 : 1));

async function mustGet(path, what) {
  const d = data(await getDoc(ref(path)));
  if (!d) throw httpError(404, `${what} not found`);
  return d;
}

/** Run writes in batches of 450 (Firestore's limit is 500 per batch). */
async function commitOps(ops) {
  for (const part of chunk(ops, 450)) {
    const b = writeBatch(db);
    for (const op of part) {
      if (op.type === 'set') b.set(op.ref, op.data, op.merge ? { merge: true } : undefined);
      else if (op.type === 'update') b.update(op.ref, op.data);
      else if (op.type === 'delete') b.delete(op.ref);
    }
    await b.commit();
  }
}

async function deleteWhere(q) {
  const snap = await getDocs(q);
  await commitOps(snap.docs.map((d) => ({ type: 'delete', ref: d.ref })));
}

// ------------------------------------------------------------------ settings & worker
let settingsCache = null;
async function settings(force = false) {
  if (!settingsCache || force) settingsCache = (data(await getDoc(ref('settings/app'))) || {});
  return settingsCache;
}

/** Call the Apps Script web app (authenticated with the user's Firebase ID token). */
async function worker(action, payload = {}) {
  const url = (await settings()).tracking_url;
  if (!url) throw httpError(400, 'The Apps Script worker is not connected yet. Run setup() in Apps Script (see README) and reload.');
  const idToken = await auth.currentUser.getIdToken();
  // text/plain keeps this a "simple" CORS request (no preflight), which Apps Script requires.
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ action, idToken, ...payload }) });
  const out = await res.json().catch(() => ({ ok: false, error: `Worker responded ${res.status}` }));
  if (!out.ok) throw httpError(400, out.error || 'Worker error');
  return out;
}

/** Ask the worker to process queues now instead of waiting for its 5-minute trigger. */
function kick() {
  worker('kick', { maxMs: 90000 }).catch((e) => console.warn('[worker]', e.message));
}

async function job(type, payload) {
  await addDoc(col('jobs'), { type, payload, status: 'pending', created_at: nowIso() });
  kick();
}

// ------------------------------------------------------------------ contacts core
async function getMany(colName, ids) {
  const out = new Map();
  for (const part of chunk([...new Set(ids)], 30)) {
    const snap = await getDocs(query(col(colName), where(documentId(), 'in', part)));
    snap.docs.forEach((d) => out.set(d.id, { id: d.id, ...d.data() }));
  }
  return out;
}

async function hasActiveTrigger(type) {
  return (await count(query(col('automations'), where('status', '==', 'active'), where('trigger_type', '==', type)))) > 0;
}

/** Queue `contact_added` automation events for newly added list memberships. */
async function fireContactAdded(items) {
  if (!items.length || !(await hasActiveTrigger('contact_added'))) return;
  for (const part of chunk(items, 500)) await addDoc(col('jobs'), { type: 'contacts_added', payload: { items: part.map((i) => ({ contact_id: i[0], list_id: i[1] })) }, status: 'pending', created_at: nowIso() });
  kick();
}

/**
 * Create or update contacts by email (doc id = lower-case email). Existing
 * non-empty fields are kept unless `overwrite`; tags and lists are merged.
 */
async function upsertContacts(list, { listIds = [], tags = [], source = 'manual', overwrite = false } = {}) {
  const valid = list.filter((c) => Core.isEmail(c.email)).map((c) => ({ ...c, email: Core.emailKey(c.email) }));
  const existing = await getMany('contacts', valid.map((c) => c.email));
  const ops = [];
  const added = [];
  const facets = { countries: new Set(), industries: new Set(), tags: new Set() };
  const result = { created: 0, updated: 0, ids: [] };
  const base = Date.now();
  const seen = new Set();
  valid.forEach((c, i) => {
    if (seen.has(c.email)) return;
    seen.add(c.email);
    const old = existing.get(c.email);
    const rowTags = Core.normaliseTags([...Core.normaliseTags(c.tags), ...tags]);
    const rowLists = [...new Set([...(c.list_ids || []), ...listIds].map(String))];
    const doc0 = old ? { ...old } : { email: c.email, tags: [], list_ids: [], status: 'subscribed', source: c.source || source, created_at: new Date(base - i).toISOString() };
    for (const f of Core.CONTACT_FIELDS) {
      const v = c[f] == null ? '' : String(c[f]).trim();
      if (v && (overwrite || !doc0[f])) doc0[f] = v;
      else if (doc0[f] == null) doc0[f] = '';
    }
    if (c.status && (overwrite || !old)) doc0.status = c.status;
    doc0.tags = Core.normaliseTags([...(doc0.tags || []), ...rowTags]);
    const newLists = rowLists.filter((l) => !(doc0.list_ids || []).includes(l));
    doc0.list_ids = [...(doc0.list_ids || []), ...newLists];
    doc0.keywords = Core.searchKeywords(doc0);
    delete doc0.id;
    ops.push({ type: 'set', ref: ref(`contacts/${c.email}`), data: doc0 });
    newLists.forEach((l) => added.push([c.email, l]));
    if (doc0.country) facets.countries.add(doc0.country);
    if (doc0.industry) facets.industries.add(doc0.industry);
    doc0.tags.forEach((t) => facets.tags.add(t));
    old ? result.updated++ : result.created++;
    result.ids.push(c.email);
  });
  await commitOps(ops);
  await addFacets(facets);
  await fireContactAdded(added);
  return result;
}

async function addFacets(f) {
  const upd = {};
  for (const k of ['countries', 'industries', 'tags']) if (f[k] && f[k].size) upd[k] = arrayUnion(...f[k]);
  if (Object.keys(upd).length) await setDoc(ref('meta/facets'), upd, { merge: true });
}

async function addToList(contactIds, listId) {
  const current = await getMany('contacts', contactIds);
  const ops = [];
  const added = [];
  for (const [id, c] of current) {
    if ((c.list_ids || []).includes(String(listId))) continue;
    ops.push({ type: 'update', ref: ref(`contacts/${id}`), data: { list_ids: arrayUnion(String(listId)) } });
    added.push([id, String(listId)]);
  }
  await commitOps(ops);
  await fireContactAdded(added);
  return added.length;
}

// ------------------------------------------------------------------ CSV
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const out = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim() !== '')) out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) out.push(row);
  const [header, ...body] = out;
  return (body || []).map((r) => Object.fromEntries((header || []).map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

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

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ------------------------------------------------------------------ contacts listing
const pageCursors = new Map();

async function listContacts(qp) {
  const pageSize = Math.min(Number(qp.limit) || 50, 500);
  const page = Math.max(1, Number(qp.page) || 1);
  const cons = [];
  const post = []; // client-side filters
  let arrayUsed = false;
  const q = String(qp.q || '').trim().toLowerCase();
  if (q) {
    cons.push(where('keywords', 'array-contains', q.split(/\s+/)[0]));
    arrayUsed = true;
    if (q.includes(' ')) post.push((c) => JSON.stringify([c.email, c.first_name, c.last_name, c.company]).toLowerCase().includes(q));
  }
  if (qp.list_id) {
    if (arrayUsed) post.push((c) => (c.list_ids || []).includes(String(qp.list_id)));
    else { cons.push(where('list_ids', 'array-contains', String(qp.list_id))); arrayUsed = true; }
  }
  if (qp.tag) {
    if (arrayUsed) post.push((c) => (c.tags || []).includes(qp.tag));
    else { cons.push(where('tags', 'array-contains', qp.tag)); arrayUsed = true; }
  }
  for (const f of ['status', 'country', 'industry']) if (qp[f]) cons.push(where(f, '==', qp[f]));
  if (qp.replied === '1') post.push((c) => !!c.replied_at);

  // Sort server-side only for query shapes covered by firestore.indexes.json.
  const simple = cons.length === 0 || (cons.length === 1 && (qp.list_id || qp.status) && !q && !qp.tag);
  const order = simple ? [orderBy('created_at', 'desc')] : [];

  if (post.length) {
    let all = (await rows(query(col('contacts'), ...cons, ...order, limit(2000)))).filter((c) => post.every((fn) => fn(c)));
    if (!simple) sortBy(all, 'created_at');
    return { total: all.length, rows: all.slice((page - 1) * pageSize, page * pageSize) };
  }
  const key = JSON.stringify([cons.length, qp.q, qp.list_id, qp.tag, qp.status, qp.country, qp.industry, pageSize]);
  const cursors = pageCursors.get(key) || [];
  pageCursors.set(key, cursors);
  const total = await count(query(col('contacts'), ...cons));
  let start = page > 1 ? cursors[page - 2] : null;
  if (page > 1 && !start) return { total, rows: [] };
  const snap = await getDocs(query(col('contacts'), ...cons, ...order, ...(start ? [startAfter(start)] : []), limit(pageSize)));
  if (snap.docs.length) cursors[page - 1] = snap.docs[snap.docs.length - 1];
  let out = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!simple) sortBy(out, 'created_at');
  return { total, rows: out };
}

// ------------------------------------------------------------------ helpers for views
function templateFields(body) {
  const mode = body.mode === 'html' ? 'html' : 'dragdrop';
  const design = mode === 'dragdrop' ? body.design || { settings: {}, blocks: [] } : null;
  return {
    name: String(body.name || 'Untitled template'),
    category: String(body.category || 'custom'),
    mode,
    subject: String(body.subject || ''),
    design: design ? JSON.parse(JSON.stringify(design)) : null,
    html: mode === 'dragdrop' ? Render.renderDesign(design) : String(body.html || ''),
    updated_at: nowIso(),
  };
}

function previewHtml(html, subject) {
  const vars = { ...Core.contactVars(Core.SAMPLE_CONTACT), unsubscribe_url: '#unsubscribe', sender_name: 'Your Company', company_address: '1 Example Street' };
  return { preview: Core.merge(html, vars, { html: true }), subject: Core.merge(subject || '', vars) };
}

function campaignStats(c) {
  const s = { total: 0, queued: 0, sent: 0, failed: 0, skipped: 0, opened: 0, clicked: 0, replied: 0, unsubscribed: 0, ...(c.stats || {}) };
  const pct = (n) => (s.sent ? Math.round((n / s.sent) * 1000) / 10 : 0);
  return { ...s, open_rate: pct(s.opened), click_rate: pct(s.clicked), reply_rate: pct(s.replied) };
}

const CAMPAIGN_FIELDS = ['name', 'subject', 'preheader', 'template_id', 'from_name', 'reply_to'];

function validateAutomation(b) {
  if (!Catalog.TRIGGERS[b.trigger_type]) throw httpError(400, 'Choose a valid trigger');
  (b.steps || []).forEach((s, i) => {
    if (!Catalog.STEP_TYPES[s.type]) throw httpError(400, `Step ${i + 1}: unknown type`);
    if (s.type === 'send_email' && !s.template_id) throw httpError(400, `Step ${i + 1}: choose a template`);
    if (s.type === 'webhook' && !/^https?:\/\//.test(s.url || '')) throw httpError(400, `Step ${i + 1}: webhook URL required`);
  });
}

const SECRET_KEYS = ['hunter_api_key', 'apollo_api_key', 'google_cse_key', 'google_cse_cx'];
const NUMERIC_SETTINGS = ['daily_limit', 'per_run_limit'];

// ------------------------------------------------------------------ routes
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, pattern, fn });

on('GET', /^\/meta$/, async () => {
  const s = await settings(true);
  const status = data(await getDoc(ref('settings/status'))) || {};
  const last = status.last_tick ? Date.parse(status.last_tick) : 0;
  return {
    triggers: Catalog.TRIGGERS, stepTypes: Catalog.STEP_TYPES, countries: Catalog.COUNTRIES, industries: Catalog.INDUSTRIES,
    mergeTags: Catalog.MERGE_TAGS, dryRun: !!s.dry_run, workerConfigured: !!s.tracking_url,
    workerOnline: Date.now() - last < 15 * 60e3, lastTick: status.last_tick || null, account: status.account || '',
    remainingToday: status.remaining_today ?? null,
  };
});

on('GET', /^\/stats$/, async () => {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  const [contacts, subscribed, lists, campaigns, activeAutomations, queued, daily, recentReplies] = await Promise.all([
    count(col('contacts')),
    count(query(col('contacts'), where('status', '==', 'subscribed'))),
    count(col('lists')),
    count(col('campaigns')),
    count(query(col('automations'), where('status', '==', 'active'))),
    count(query(col('messages'), where('status', '==', 'queued'))),
    rows(query(col('stats'), where('day', '>=', since), orderBy('day'))),
    rows(query(col('replies'), orderBy('received_at', 'desc'), limit(5))),
  ]);
  const sum = (k) => daily.reduce((n, d) => n + Number(d[k] || 0), 0);
  const sent30 = sum('sent');
  const pct = (x) => (sent30 ? Math.round((x / sent30) * 1000) / 10 : 0);
  return {
    contacts, subscribed, lists, campaigns, activeAutomations, queued, sent30,
    opened30: sum('opens'), clicked30: sum('clicks'), replied30: sum('replies'),
    openRate: pct(sum('opens')), clickRate: pct(sum('clicks')), replyRate: pct(sum('replies')),
    daily: daily.map((d) => ({ day: d.day, sent: d.sent || 0, opens: d.opens || 0, clicks: d.clicks || 0, replies: d.replies || 0 })),
    recentReplies,
  };
});

// templates
on('GET', /^\/templates$/, async () => {
  const list = await rows(col('templates'));
  return list.sort((a, b) => Number(!!b.is_standard) - Number(!!a.is_standard) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
});
on('GET', /^\/templates\/([\w-]+)$/, ([id]) => mustGet(`templates/${id}`, 'Template'));
on('POST', /^\/templates$/, async (_, body) => {
  const r = await addDoc(col('templates'), { ...templateFields(body), is_standard: false, created_at: nowIso() });
  return mustGet(`templates/${r.id}`, 'Template');
});
on('PUT', /^\/templates\/([\w-]+)$/, async ([id], body) => {
  await updateDoc(ref(`templates/${id}`), templateFields(body));
  return mustGet(`templates/${id}`, 'Template');
});
on('POST', /^\/templates\/([\w-]+)\/duplicate$/, async ([id]) => {
  const t = await mustGet(`templates/${id}`, 'Template');
  delete t.id;
  const r = await addDoc(col('templates'), { ...t, name: `${t.name} (copy)`, is_standard: false, created_at: nowIso(), updated_at: nowIso() });
  return { id: r.id };
});
on('DELETE', /^\/templates\/([\w-]+)$/, async ([id]) => { await deleteDoc(ref(`templates/${id}`)); return { ok: true }; });
on('POST', /^\/templates\/render$/, (_, b) => {
  const html = b.mode === 'html' ? String(b.html || '') : Render.renderDesign(b.design);
  return { html, ...previewHtml(html, b.subject) };
});
on('POST', /^\/templates\/([\w-]+)\/test$/, async ([id], b) => {
  if (!Core.isEmail(b.email)) throw httpError(400, 'Enter a valid email address');
  return worker('test_email', { template_id: id, email: b.email });
});

// uploads (images are stored in Google Drive by the worker)
on('POST', /^\/uploads$/, async (_, form) => {
  const file = form.get('file');
  if (!file) throw httpError(400, 'Choose an image');
  if (file.size > 5 * 1024 * 1024) throw httpError(400, 'Image is larger than 5 MB');
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return worker('upload', { name: file.name, mimeType: file.type, data: btoa(bin) });
});

// lists
on('GET', /^\/lists$/, async () => {
  const lists = await rows(col('lists'));
  await Promise.all(lists.map(async (l) => {
    [l.contacts, l.subscribed] = await Promise.all([
      count(query(col('contacts'), where('list_ids', 'array-contains', l.id))),
      count(query(col('contacts'), where('list_ids', 'array-contains', l.id), where('status', '==', 'subscribed'))),
    ]);
  }));
  return lists.sort((a, b) => String(a.name).localeCompare(String(b.name)));
});
on('POST', /^\/lists$/, async (_, b) => {
  if (!b.name) throw httpError(400, 'Name is required');
  const r = await addDoc(col('lists'), { name: b.name, description: b.description || '', created_at: nowIso() });
  return { id: r.id, name: b.name, description: b.description || '' };
});
on('PUT', /^\/lists\/([\w-]+)$/, async ([id], b) => {
  const upd = {};
  if (b.name != null) upd.name = b.name;
  if (b.description != null) upd.description = b.description;
  await updateDoc(ref(`lists/${id}`), upd);
  return mustGet(`lists/${id}`, 'List');
});
on('DELETE', /^\/lists\/([\w-]+)$/, async ([id]) => {
  const members = await getDocs(query(col('contacts'), where('list_ids', 'array-contains', id)));
  await commitOps(members.docs.map((d) => ({ type: 'update', ref: d.ref, data: { list_ids: arrayRemove(id) } })));
  await deleteDoc(ref(`lists/${id}`));
  return { ok: true };
});
on('POST', /^\/lists\/([\w-]+)\/contacts$/, async ([id], b) => ({ added: await addToList(b.contact_ids || [], id) }));
on('POST', /^\/lists\/([\w-]+)\/remove-contacts$/, async ([id], b) => {
  await commitOps((b.contact_ids || []).map((c) => ({ type: 'update', ref: ref(`contacts/${c}`), data: { list_ids: arrayRemove(id) } })));
  return { ok: true };
});

// contacts
on('GET', /^\/contacts$/, (_, __, qp) => listContacts(qp));
on('GET', /^\/contacts\/facets$/, async () => {
  const f = data(await getDoc(ref('meta/facets'))) || {};
  const s = (a) => [...new Set(a || [])].sort((x, y) => String(x).localeCompare(String(y)));
  return { countries: s(f.countries), industries: s(f.industries), tags: s(f.tags) };
});
on('GET', /^\/contacts\/([^/]+)$/, async ([id]) => {
  const c = await mustGet(`contacts/${decodeURIComponent(id)}`, 'Contact');
  const [messages, replies] = await Promise.all([
    rows(query(col('messages'), where('contact_id', '==', c.id), orderBy('created_at', 'desc'), limit(50))),
    rows(query(col('replies'), where('contact_id', '==', c.id), orderBy('received_at', 'desc'), limit(20))),
  ]);
  c.tags = c.tags || [];
  c.list_ids = c.list_ids || [];
  c.messages = messages.map((m) => ({ ...m, campaign: m.campaign_name }));
  c.replies = replies;
  return c;
});
on('POST', /^\/contacts$/, async (_, b) => {
  if (!Core.isEmail(b.email)) throw httpError(400, `Invalid email: ${b.email || ''}`);
  const r = await upsertContacts([{ ...b, tags: Core.normaliseTags(b.tags) }], { listIds: b.list_ids || [], overwrite: true });
  return mustGet(`contacts/${r.ids[0]}`, 'Contact');
});
on('PUT', /^\/contacts\/([^/]+)$/, async ([raw], b) => {
  const id = decodeURIComponent(raw);
  const c = await mustGet(`contacts/${id}`, 'Contact');
  const next = { ...c };
  delete next.id;
  for (const f of [...Core.CONTACT_FIELDS, 'status']) if (b[f] !== undefined) next[f] = String(b[f]).trim();
  if (b.tags !== undefined) next.tags = Core.normaliseTags(b.tags);
  let added = [];
  if (Array.isArray(b.list_ids)) {
    const wanted = b.list_ids.map(String);
    added = wanted.filter((l) => !(c.list_ids || []).includes(l));
    next.list_ids = wanted;
  }
  const newId = b.email && Core.emailKey(b.email) !== id ? Core.emailKey(b.email) : id;
  if (!Core.isEmail(newId)) throw httpError(400, 'Invalid email');
  next.email = newId;
  next.keywords = Core.searchKeywords(next);
  if (newId !== id) {
    if ((await getDoc(ref(`contacts/${newId}`))).exists()) throw httpError(400, 'Another contact already uses that email');
    await setDoc(ref(`contacts/${newId}`), next);
    await deleteDoc(ref(`contacts/${id}`));
  } else await setDoc(ref(`contacts/${id}`), next);
  await addFacets({ countries: new Set([next.country].filter(Boolean)), industries: new Set([next.industry].filter(Boolean)), tags: new Set(next.tags) });
  await fireContactAdded(added.map((l) => [newId, l]));
  return mustGet(`contacts/${newId}`, 'Contact');
});
on('DELETE', /^\/contacts\/([^/]+)$/, async ([id]) => { await deleteDoc(ref(`contacts/${decodeURIComponent(id)}`)); return { ok: true }; });
on('POST', /^\/contacts\/bulk$/, async (_, b) => {
  const ids = b.ids || [];
  const listId = String(b.list_id || '');
  if (b.action === 'add_to_list') { await addToList(ids, listId); return { ok: true, count: ids.length }; }
  const make = {
    delete: (r) => ({ type: 'delete', ref: r }),
    unsubscribe: (r) => ({ type: 'update', ref: r, data: { status: 'unsubscribed' } }),
    resubscribe: (r) => ({ type: 'update', ref: r, data: { status: 'subscribed' } }),
    add_tag: (r) => ({ type: 'update', ref: r, data: { tags: arrayUnion(b.tag) } }),
    remove_from_list: (r) => ({ type: 'update', ref: r, data: { list_ids: arrayRemove(listId) } }),
  }[b.action];
  if (!make) throw httpError(400, `Unknown action ${b.action}`);
  if (b.action === 'add_tag' && !b.tag) throw httpError(400, 'Enter a tag');
  await commitOps(ids.map((id) => make(ref(`contacts/${id}`))));
  if (b.action === 'add_tag') await addFacets({ tags: new Set([b.tag]) });
  return { ok: true, count: ids.length };
});
on('POST', /^\/contacts\/import$/, async (_, form) => {
  const file = form.get('file');
  const csv = file ? await file.text() : String(form.get('csv') || '');
  if (!csv.trim()) throw httpError(400, 'Upload a CSV file or paste CSV text');
  const parsed = parseCsv(csv);
  const defaults = { country: form.get('country') || '', industry: form.get('industry') || '' };
  const result = { total: parsed.length, created: 0, updated: 0, skipped: 0, errors: [] };
  const good = [];
  parsed.forEach((row, i) => {
    const d = { ...defaults, ...mapRow(row) };
    if (!Core.isEmail(d.email)) {
      result.skipped++;
      if (result.errors.length < 20) result.errors.push(`Row ${i + 2}: invalid or missing email "${d.email || ''}"`);
    } else good.push({ ...d, source: 'import' });
  });
  const listId = form.get('list_id');
  for (const part of chunk(good, 400)) {
    const r = await upsertContacts(part, { listIds: listId ? [String(listId)] : [], tags: Core.normaliseTags(form.get('tags')), source: 'import' });
    result.created += r.created;
    result.updated += r.updated;
  }
  return result;
});
on('POST', /^\/contacts\/export$/, async (_, b) => {
  const qp = { ...(b || {}), page: 1, limit: 500 };
  const all = [];
  for (let p = 1; ; p++) {
    const r = await listContacts({ ...qp, page: p });
    all.push(...r.rows);
    if (r.rows.length < 500 || all.length >= r.total) break;
  }
  const cols = ['email', 'first_name', 'last_name', 'company', 'website', 'phone', 'country', 'industry', 'tags', 'status', 'source', 'replied_at', 'created_at'];
  const csv = [cols.join(','), ...all.map((c) => cols.map((k) => csvCell(k === 'tags' ? (c.tags || []).join(';') : c[k])).join(','))].join('\n');
  return { csv, count: all.length };
});

// campaigns
on('GET', /^\/campaigns$/, async () => {
  const [list, templates] = await Promise.all([rows(query(col('campaigns'), orderBy('created_at', 'desc'))), rows(col('templates'))]);
  const names = Object.fromEntries(templates.map((t) => [t.id, t.name]));
  return list.map((c) => ({ ...c, list_ids: c.list_ids || [], template_name: names[c.template_id] || '', stats: campaignStats(c) }));
});
on('GET', /^\/campaigns\/([\w-]+)$/, async ([id]) => {
  const c = await mustGet(`campaigns/${id}`, 'Campaign');
  c.list_ids = c.list_ids || [];
  c.stats = campaignStats(c);
  c.links = Object.values(c.links || {}).map((l) => ({ url: l.url, clicks: l.clicks || 0, people: '' })).sort((a, b) => b.clicks - a.clicks);
  const counts = await Promise.all(c.list_ids.map((l) => count(query(col('contacts'), where('list_ids', 'array-contains', l), where('status', '==', 'subscribed')))));
  c.recipients = counts.reduce((a, b) => a + b, 0);
  c.recipients_estimate = c.list_ids.length > 1;
  return c;
});
on('GET', /^\/campaigns\/([\w-]+)\/messages$/, async ([id], _, qp) => {
  let list = await rows(query(col('messages'), where('campaign_id', '==', id), limit(2000)));
  const filter = { opened: (m) => m.opened_at, clicked: (m) => m.clicked_at, replied: (m) => m.replied_at, failed: (m) => m.status === 'failed' }[qp.filter];
  if (filter) list = list.filter(filter);
  return sortBy(list, 'created_at', false).map((m) => ({ ...m, first_name: m.name || '', last_name: '' }));
});
on('POST', /^\/campaigns$/, async (_, b) => {
  const doc0 = {
    name: b.name || 'Untitled campaign', subject: b.subject || '', preheader: b.preheader || '', template_id: b.template_id || null,
    from_name: b.from_name || '', reply_to: b.reply_to || '', list_ids: (b.list_ids || []).map(String),
    status: 'draft', stats: {}, created_at: nowIso(),
  };
  const r = await addDoc(col('campaigns'), doc0);
  return { id: r.id, ...doc0, stats: campaignStats(doc0) };
});
on('PUT', /^\/campaigns\/([\w-]+)$/, async ([id], b) => {
  const c = await mustGet(`campaigns/${id}`, 'Campaign');
  if (!['draft', 'scheduled'].includes(c.status)) throw httpError(400, `Cannot edit a ${c.status} campaign`);
  const upd = {};
  for (const f of CAMPAIGN_FIELDS) if (b[f] !== undefined) upd[f] = f === 'template_id' && !b[f] ? null : b[f];
  if (b.list_ids) upd.list_ids = b.list_ids.map(String);
  await updateDoc(ref(`campaigns/${id}`), upd);
  const out = await mustGet(`campaigns/${id}`, 'Campaign');
  return { ...out, stats: campaignStats(out) };
});
on('DELETE', /^\/campaigns\/([\w-]+)$/, async ([id]) => {
  await deleteWhere(query(col('messages'), where('campaign_id', '==', id)));
  await deleteDoc(ref(`campaigns/${id}`));
  return { ok: true };
});
on('POST', /^\/campaigns\/([\w-]+)\/send$/, async ([id]) => {
  const c = await mustGet(`campaigns/${id}`, 'Campaign');
  if (!c.template_id) throw httpError(400, 'Choose a template first');
  if (!(c.list_ids || []).length) throw httpError(400, 'Choose at least one list');
  if (!['draft', 'scheduled'].includes(c.status)) throw httpError(400, `Campaign is already ${c.status}`);
  await updateDoc(ref(`campaigns/${id}`), { status: 'launching', error: null });
  kick();
  return { ok: true };
});
on('POST', /^\/campaigns\/([\w-]+)\/schedule$/, async ([id], b) => {
  const when = new Date(b.scheduled_at);
  if (Number.isNaN(when.getTime())) throw httpError(400, 'Invalid date');
  const c = await mustGet(`campaigns/${id}`, 'Campaign');
  if (!['draft', 'scheduled'].includes(c.status)) throw httpError(400, 'Only draft campaigns can be scheduled');
  if (!c.template_id) throw httpError(400, 'Choose a template first');
  await updateDoc(ref(`campaigns/${id}`), { status: 'scheduled', scheduled_at: when.toISOString() });
  return { ok: true };
});
const setStatus = (from, to) => async ([id]) => {
  const c = await mustGet(`campaigns/${id}`, 'Campaign');
  if (c.status === from) await updateDoc(ref(`campaigns/${id}`), { status: to, ...(to === 'draft' ? { scheduled_at: null } : {}) });
  if (to === 'sending') kick();
  return { ok: true };
};
on('POST', /^\/campaigns\/([\w-]+)\/unschedule$/, setStatus('scheduled', 'draft'));
on('POST', /^\/campaigns\/([\w-]+)\/pause$/, setStatus('sending', 'paused'));
on('POST', /^\/campaigns\/([\w-]+)\/resume$/, setStatus('paused', 'sending'));
on('POST', /^\/campaigns\/([\w-]+)\/duplicate$/, async ([id]) => {
  const c = await mustGet(`campaigns/${id}`, 'Campaign');
  const r = await addDoc(col('campaigns'), {
    name: `${c.name} (copy)`, subject: c.subject || '', preheader: c.preheader || '', template_id: c.template_id || null,
    from_name: c.from_name || '', reply_to: c.reply_to || '', list_ids: c.list_ids || [], status: 'draft', stats: {}, created_at: nowIso(),
  });
  return { id: r.id };
});
on('POST', /^\/campaigns\/([\w-]+)\/test$/, async ([id], b) => {
  if (!Core.isEmail(b.email)) throw httpError(400, 'Enter a valid email address');
  return worker('test_email', { campaign_id: id, email: b.email });
});

// automations
const automationOut = (a) => ({ ...a, trigger_config: a.trigger_config || {}, steps: a.steps || [], runs: Object.fromEntries(Object.entries(a.runs || {}).filter(([, v]) => v > 0)) });
on('GET', /^\/automations$/, async () => sortBy(await rows(col('automations')), 'created_at').map(automationOut));
on('GET', /^\/automations\/([\w-]+)$/, async ([id]) => {
  const a = automationOut(await mustGet(`automations/${id}`, 'Automation'));
  a.recent = (await rows(query(col('runs'), where('automation_id', '==', id), orderBy('created_at', 'desc'), limit(50)))).map((r) => ({ ...r, log: r.log || [] }));
  return a;
});
const automationDoc = (b) => ({
  name: b.name || 'Untitled automation', trigger_type: b.trigger_type, trigger_config: b.trigger_config || {}, steps: b.steps || [],
  status: b.status === 'active' ? 'active' : 'paused', allow_reentry: !!b.allow_reentry,
});
on('POST', /^\/automations$/, async (_, b) => {
  validateAutomation(b);
  const r = await addDoc(col('automations'), { ...automationDoc(b), runs: {}, created_at: nowIso() });
  return { id: r.id, ...automationDoc(b) };
});
on('PUT', /^\/automations\/([\w-]+)$/, async ([id], b) => {
  validateAutomation(b);
  await updateDoc(ref(`automations/${id}`), automationDoc(b));
  return { id, ...automationDoc(b) };
});
on('POST', /^\/automations\/([\w-]+)\/activate$/, async ([id]) => { await updateDoc(ref(`automations/${id}`), { status: 'active' }); return { ok: true }; });
on('POST', /^\/automations\/([\w-]+)\/pause$/, async ([id]) => { await updateDoc(ref(`automations/${id}`), { status: 'paused' }); return { ok: true }; });
on('DELETE', /^\/automations\/([\w-]+)$/, async ([id]) => {
  await deleteWhere(query(col('runs'), where('automation_id', '==', id)));
  await deleteDoc(ref(`automations/${id}`));
  return { ok: true };
});
on('POST', /^\/automations\/([\w-]+)\/enroll$/, async ([id], b) => {
  if (!b.list_id && !(b.contact_ids || []).length) throw httpError(400, 'Choose a list');
  await job('enroll', { automation_id: id, list_id: b.list_id || null, contact_ids: b.contact_ids || [] });
  return { queued: true };
});
on('POST', /^\/automation-runs\/([\w-]+)\/stop$/, async ([id]) => {
  const r = await mustGet(`runs/${id}`, 'Run');
  if (r.status !== 'active') return { ok: true };
  const b = writeBatch(db);
  b.update(ref(`runs/${id}`), { status: 'stopped', updated_at: nowIso() });
  b.set(ref(`automations/${r.automation_id}`), { runs: { active: increment(-1), stopped: increment(1) } }, { merge: true });
  await b.commit();
  return { ok: true };
});

// replies
on('GET', /^\/replies$/, async () => (await rows(query(col('replies'), orderBy('received_at', 'desc'), limit(200)))).map((r) => ({ ...r, campaign: r.campaign_name })));
on('POST', /^\/replies\/poll$/, async () => {
  const r = await worker('kick', { maxMs: 90000 });
  return { found: typeof r.summary?.replies === 'number' ? r.summary.replies : 0, summary: r.summary };
});
on('POST', /^\/replies$/, async (_, b) => {
  if (!Core.isEmail(Core.addressOf(b.from))) throw httpError(400, 'Enter the contact email');
  await job('log_reply', { from: b.from, subject: b.subject || '', text: b.text || '' });
  return { queued: true };
});

// lead finder
on('POST', /^\/leads\/search$/, async (_, b) => {
  const params = {
    countries: [].concat(b.countries || []).filter(Boolean),
    industries: [].concat(b.industries || []).filter(Boolean),
    keywords: String(b.keywords || '').trim(),
    sources: [].concat(b.sources || ['web']),
    urls: String(b.urls || '').split(/[\s,]+/).filter(Boolean),
    limit: Math.min(Number(b.limit) || 100, 1000),
    perSiteMaxEmails: Number(b.perSiteMaxEmails) || 3,
    pages: Math.min(Number(b.pages) || 2, 5),
  };
  if (!params.countries.length && !params.industries.length && !params.keywords && !params.urls.length) {
    throw httpError(400, 'Choose at least one country, industry, keyword or URL');
  }
  const r = await addDoc(col('leadSearches'), { params, status: 'queued', progress: 'Waiting for the worker to start…', results_count: 0, created_at: nowIso() });
  kick();
  return { id: r.id };
});
on('GET', /^\/leads\/searches$/, async () => rows(query(col('leadSearches'), orderBy('created_at', 'desc'), limit(50))));
on('GET', /^\/leads\/searches\/([\w-]+)$/, async ([id]) => {
  const s = await mustGet(`leadSearches/${id}`, 'Search');
  delete s.state;
  const leads = sortBy(await rows(collection(db, 'leadSearches', id, 'leads')), 'created_at', false);
  const known = await getMany('contacts', leads.map((l) => l.email));
  s.leads = leads.map((l) => ({ ...l, in_contacts: known.has(l.email) }));
  return s;
});
on('DELETE', /^\/leads\/searches\/([\w-]+)$/, async ([id]) => {
  await deleteWhere(collection(db, 'leadSearches', id, 'leads'));
  await deleteDoc(ref(`leadSearches/${id}`));
  return { ok: true };
});
on('POST', /^\/leads\/searches\/([\w-]+)\/import$/, async ([id], b) => {
  const leads = await getMany(`leadSearches/${id}/leads`, b.lead_ids || []);
  const r = await upsertContacts([...leads.values()].map((l) => ({
    email: l.email, first_name: l.first_name, last_name: l.last_name, company: l.company, website: l.website,
    country: l.country, industry: l.industry, source: `lead:${l.source}`,
  })), { listIds: b.list_id ? [String(b.list_id)] : [], tags: [...Core.normaliseTags(b.tags), 'lead-finder'] });
  await commitOps([...leads.keys()].map((k) => ({ type: 'update', ref: doc(db, 'leadSearches', id, 'leads', k), data: { imported: true } })));
  return r;
});

// settings
on('GET', /^\/settings$/, async () => {
  const [app, secrets, status] = await Promise.all([settings(true), getDoc(ref('settings/secrets')), getDoc(ref('settings/status'))]);
  const sec = data(secrets) || {};
  const out = { ...app, status: data(status) || {} };
  for (const k of SECRET_KEYS) out[k] = sec[k] ? (k === 'google_cse_cx' ? sec[k] : '********') : '';
  return out;
});
on('PUT', /^\/settings$/, async (_, b) => {
  const app = {};
  const sec = {};
  for (const [k, v] of Object.entries(b)) {
    if (SECRET_KEYS.includes(k)) { if (v !== '********') sec[k] = v; }
    else if (NUMERIC_SETTINGS.includes(k)) app[k] = Number(v) || 0;
    else if (k === 'dry_run') app[k] = v === true || v === 'true';
    else if (['from_name', 'reply_to', 'company_address', 'site_url', 'tracking_url', 'crawler_user_agent'].includes(k)) app[k] = String(v).trim();
  }
  await setDoc(ref('settings/app'), app, { merge: true });
  if (Object.keys(sec).length) await setDoc(ref('settings/secrets'), sec, { merge: true });
  await settings(true);
  return { ok: true };
});
on('POST', /^\/settings\/check$/, async () => {
  try {
    const r = await worker('status');
    return { ok: true, message: `Connected. Sending as ${r.account}; ${r.remaining_today} emails left today.` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

/** Dispatch an API call. `path` may include a query string. */
export async function handle(method, path, body) {
  const [p, qs] = path.split('?');
  const qp = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = p.match(r.pattern);
    if (m) return r.fn(m.slice(1), body, qp);
  }
  throw httpError(404, `No handler for ${method} ${p}`);
}

export const internals = { parseCsv, mapRow, upsertContacts, worker, kick, settings };
