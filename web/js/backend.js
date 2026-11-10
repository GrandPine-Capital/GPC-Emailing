/*
 * The dashboard's API client: App.api('GET', '/campaigns') calls the Go service at /api/…
 * with the signed-in person's token. A few calls stay in the browser because they need
 * nothing from the server: previewing a template, the static catalogue in /meta, and
 * reading a CSV file before it is imported.
 */
import { accessToken, onSignedOut } from './session.js';

const Core = window.EmailCore;
const Catalog = window.EmailCatalog;
const Render = window.EmailRender;

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function call(method, path, body) {
  const token = await accessToken();
  if (!token) {
    onSignedOut();
    throw httpError(401, 'Your session has ended: please sign in again.');
  }
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw httpError(0, 'Could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) onSignedOut();
  if (!res.ok) throw httpError(res.status, (data && data.error) || `The server answered HTTP ${res.status}.`);
  return data;
}

// ------------------------------------------------------------------ CSV (read in the browser)
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

// ------------------------------------------------------------------ calls handled here
function previewHtml(html, subject) {
  const vars = { ...Core.contactVars(Core.SAMPLE_CONTACT), unsubscribe_url: '#unsubscribe', sender_name: 'Your Company', company_address: '1 Example Street' };
  return { preview: Core.merge(html, vars, { html: true }), subject: Core.merge(subject || '', vars) };
}

/** Drag-and-drop designs are rendered to email HTML here; the server sends what is saved. */
function withHtml(body) {
  if (body && body.mode !== 'html') return { ...body, html: Render.renderDesign(body.design || { settings: {}, blocks: [] }) };
  return body;
}

const local = [
  ['POST', /^\/templates\/render$/, (b) => {
    const html = b.mode === 'html' ? String(b.html || '') : Render.renderDesign(b.design);
    return { html, ...previewHtml(html, b.subject) };
  }],
  ['GET', /^\/meta$/, async () => ({
    triggers: Catalog.TRIGGERS, stepTypes: Catalog.STEP_TYPES, countries: Catalog.COUNTRIES, industries: Catalog.INDUSTRIES,
    focusIndustries: Catalog.FOCUS_INDUSTRIES, mergeTags: Catalog.MERGE_TAGS, stopConditions: Catalog.STOP_CONDITIONS,
    ...(await call('GET', '/meta')),
  })],
  ['POST', /^\/templates$/, (b) => call('POST', '/templates', withHtml(b))],
  ['PUT', /^\/templates\/[\w-]+$/, (b, path) => call('PUT', path, withHtml(b))],
  ['POST', /^\/contacts\/import$/, async (form) => {
    const file = form.get('file');
    const csv = file ? await file.text() : String(form.get('csv') || '');
    if (!csv.trim()) throw httpError(400, 'Upload a CSV file or paste CSV text');
    return call('POST', '/contacts/import', {
      rows: parseCsv(csv).map(mapRow), list_id: form.get('list_id') || '', tags: form.get('tags') || '',
      country: form.get('country') || '', industry: form.get('industry') || '',
    });
  }],
  ['POST', /^\/uploads$/, (form) => {
    const file = form.get('file');
    if (!file) throw httpError(400, 'Choose an image');
    if (file.size > 5 * 1024 * 1024) throw httpError(400, 'Image is larger than 5 MB');
    return call('POST', '/uploads', form);
  }],
];

/** Dispatch an API call. `path` may include a query string. */
export async function handle(method, path, body) {
  const p = path.split('?')[0];
  for (const [m, re, fn] of local) if (m === method && re.test(p)) return fn(body, path);
  return call(method, path, body);
}

export const internals = { parseCsv, mapRow };
