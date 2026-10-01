/*
 * In-memory implementation of the subset of the Cloud Firestore REST API
 * used by apps-script/Firestore.js (get, patch, create, delete, runQuery, commit).
 */
const crypto = require('node:crypto');

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: encodeFields(v) } };
}
const encodeFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encode(v)]));
function decode(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
const decodeFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, decode(v)]));

// Like Firestore: unquoted segments must match [a-zA-Z_][a-zA-Z_0-9]*, others need backticks.
const splitPath = (p) => (p.match(/(`[^`]*`|[^.]+)/g) || []).map((s) => {
  if (/^`.*`$/.test(s)) return s.slice(1, -1);
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(s)) throw Object.assign(new Error(`Invalid property path "${p}"`), { code: 400 });
  return s;
});
function getPath(obj, path) {
  let node = obj;
  for (const k of splitPath(path)) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[k];
  }
  return node;
}
function setPath(obj, path, value) {
  const parts = splitPath(path);
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  if (value === undefined) delete node[parts[parts.length - 1]];
  else node[parts[parts.length - 1]] = value;
}

// Mirror Firestore: "Property ... contains an invalid nested entity" for arrays of arrays.
function assertNoNestedArrays(v, inArray = false) {
  if (Array.isArray(v)) {
    if (inArray) throw Object.assign(new Error('invalid nested entity (array of arrays)'), { code: 400 });
    v.forEach((x) => assertNoNestedArrays(x, true));
  } else if (v && typeof v === 'object') Object.values(v).forEach((x) => assertNoNestedArrays(x, false));
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

class FakeFirestore {
  constructor(projectId) {
    this.projectId = projectId;
    this.docs = new Map(); // path -> data
    this.prefix = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    this.requests = 0;
  }

  // Helpers for tests
  put(path, data) { this.docs.set(path, clone(data)); }
  doc(path) { return this.docs.has(path) ? { id: path.split('/').pop(), ...clone(this.docs.get(path)) } : null; }
  collection(col) {
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(col + '/') && !p.slice(col.length + 1).includes('/'))
      .map(([p, d]) => ({ id: p.split('/').pop(), ...clone(d) }));
  }

  name(path) { return `projects/${this.projectId}/databases/(default)/documents/${path}`; }
  out(path) { return { name: this.name(path), fields: encodeFields(this.docs.get(path)) }; }
  pathFromName(name) { return name.split('/documents/')[1]; }

  applyUpdate(path, fields, mask, precondition) {
    assertNoNestedArrays(decodeFields(fields));
    const exists = this.docs.has(path);
    if (precondition && precondition.exists === true && !exists) throw Object.assign(new Error('NOT_FOUND'), { code: 404 });
    if (precondition && precondition.exists === false && exists) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 409 });
    const data = decodeFields(fields);
    if (!mask) {
      this.docs.set(path, data);
      return;
    }
    const cur = exists ? this.docs.get(path) : {};
    for (const p of mask) setPath(cur, p, getPath(data, p));
    this.docs.set(path, cur);
  }

  applyTransforms(path, transforms) {
    const cur = this.docs.get(path) || {};
    for (const t of transforms || []) {
      const old = getPath(cur, t.fieldPath);
      if (t.increment) setPath(cur, t.fieldPath, (typeof old === 'number' ? old : 0) + decode(t.increment));
      if (t.appendMissingElements) {
        const arr = Array.isArray(old) ? old : [];
        for (const v of t.appendMissingElements.values.map(decode)) if (!arr.some((x) => eq(x, v))) arr.push(v);
        setPath(cur, t.fieldPath, arr);
      }
      if (t.removeAllFromArray) {
        const rm = t.removeAllFromArray.values.map(decode);
        setPath(cur, t.fieldPath, (Array.isArray(old) ? old : []).filter((x) => !rm.some((v) => eq(v, x))));
      }
    }
    this.docs.set(path, cur);
  }

  matches(data, f) {
    if (!f) return true;
    if (f.compositeFilter) return f.compositeFilter.filters.every((x) => this.matches(data, x));
    const { field, op, value } = f.fieldFilter;
    const v = getPath(data, field.fieldPath);
    const want = decode(value);
    switch (op) {
      case 'EQUAL': return eq(v, want);
      case 'NOT_EQUAL': return v !== undefined && !eq(v, want);
      case 'LESS_THAN': return v !== undefined && v !== null && cmp(v, want) < 0;
      case 'LESS_THAN_OR_EQUAL': return v !== undefined && v !== null && cmp(v, want) <= 0;
      case 'GREATER_THAN': return v !== undefined && v !== null && cmp(v, want) > 0;
      case 'GREATER_THAN_OR_EQUAL': return v !== undefined && v !== null && cmp(v, want) >= 0;
      case 'ARRAY_CONTAINS': return Array.isArray(v) && v.some((x) => eq(x, want));
      case 'IN': return want.some((x) => eq(x, v));
      case 'ARRAY_CONTAINS_ANY': return Array.isArray(v) && v.some((x) => want.some((w) => eq(x, w)));
      default: throw new Error('op ' + op);
    }
  }

  runQuery(parent, sq) {
    const col = sq.from[0].collectionId;
    const base = parent ? `${parent}/${col}/` : `${col}/`;
    let rows = [...this.docs.keys()].filter((p) => p.startsWith(base) && !p.slice(base.length).includes('/'));
    rows = rows.filter((p) => this.matches(this.docs.get(p), sq.where));
    for (const o of [...(sq.orderBy || [])].reverse()) {
      rows = rows.filter((p) => getPath(this.docs.get(p), o.field.fieldPath) !== undefined);
      rows.sort((a, b) => {
        const r = cmp(getPath(this.docs.get(a), o.field.fieldPath), getPath(this.docs.get(b), o.field.fieldPath));
        return o.direction === 'DESCENDING' ? -r : r;
      });
    }
    if (sq.limit) rows = rows.slice(0, sq.limit);
    return rows.length ? rows.map((p) => ({ document: this.out(p) })) : [{ readTime: new Date().toISOString() }];
  }

  /** Handle one HTTP request. Returns { code, body }. */
  handle(method, url, payload) {
    this.requests++;
    const [pathPart, qs] = url.slice(this.prefix.length).split('?');
    const params = new URLSearchParams(qs || '');
    const body = payload ? JSON.parse(payload) : {};
    try {
      if (pathPart.endsWith(':runQuery')) {
        const parent = pathPart.slice(0, -':runQuery'.length).replace(/^\//, '');
        return { code: 200, body: this.runQuery(parent, body.structuredQuery) };
      }
      if (pathPart === ':commit') {
        for (const w of body.writes) {
          if (w.delete) {
            this.docs.delete(this.pathFromName(w.delete));
            continue;
          }
          const path = this.pathFromName(w.update.name);
          this.applyUpdate(path, w.update.fields, w.updateMask ? w.updateMask.fieldPaths : null, w.currentDocument);
          if (w.updateTransforms) this.applyTransforms(path, w.updateTransforms);
        }
        return { code: 200, body: {} };
      }
      const path = decodeURIComponent(pathPart.replace(/^\//, ''));
      const isDoc = path.split('/').length % 2 === 0;
      if (method === 'get') {
        return this.docs.has(path) ? { code: 200, body: this.out(path) } : { code: 404, body: { error: { code: 404 } } };
      }
      if (method === 'delete') {
        this.docs.delete(path);
        return { code: 200, body: {} };
      }
      if (method === 'post' && !isDoc) {
        const id = params.get('documentId') || crypto.randomBytes(10).toString('hex');
        const docPath = `${path}/${id}`;
        if (this.docs.has(docPath)) return { code: 409, body: { error: { code: 409, status: 'ALREADY_EXISTS' } } };
        assertNoNestedArrays(decodeFields(body.fields));
        this.docs.set(docPath, decodeFields(body.fields));
        return { code: 200, body: this.out(docPath) };
      }
      if (method === 'patch') {
        const mask = params.getAll('updateMask.fieldPaths');
        const pre = params.get('currentDocument.exists');
        this.applyUpdate(path, body.fields, mask.length ? mask : null, pre ? { exists: pre === 'true' } : null);
        return { code: 200, body: this.out(path) };
      }
      return { code: 400, body: { error: 'unsupported ' + method + ' ' + url } };
    } catch (e) {
      return { code: e.code || 500, body: { error: { message: e.message } } };
    }
  }
}

module.exports = { FakeFirestore, encode, decode };
