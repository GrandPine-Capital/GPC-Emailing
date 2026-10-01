/*
 * Minimal Cloud Firestore REST client for Apps Script.
 *
 * Runs with the script owner's OAuth token (scope: datastore), so it has
 * owner access to the Firebase project and is not subject to security rules.
 * Documents are plain objects; `id` holds the document id on reads.
 */
var FS = (function () {
  function projectId() {
    return CONFIG.projectId();
  }
  function root() {
    return 'https://firestore.googleapis.com/v1/projects/' + projectId() + '/databases/(default)/documents';
  }
  function docName(path) {
    return 'projects/' + projectId() + '/databases/(default)/documents/' + path;
  }

  function call(method, url, payload) {
    const res = UrlFetchApp.fetch(url, {
      method: method,
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        // Bill quota to the Firebase project rather than the hidden Apps Script project.
        'x-goog-user-project': projectId(),
      },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code === 404 && method === 'get') return null;
    if (code >= 300) {
      const err = new Error('Firestore ' + method.toUpperCase() + ' ' + code + ': ' + text.slice(0, 500));
      err.code = code;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  // ------------------------------------------------------------- value codec
  function encode(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
    if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
    return { stringValue: String(v) };
  }
  function encodeFields(obj) {
    const out = {};
    Object.keys(obj).forEach(function (k) {
      if (obj[k] !== undefined) out[k] = encode(obj[k]);
    });
    return out;
  }
  function decode(v) {
    if (!v || 'nullValue' in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('stringValue' in v) return v.stringValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
    if ('referenceValue' in v) return v.referenceValue;
    return null;
  }
  function decodeFields(fields) {
    const out = {};
    Object.keys(fields || {}).forEach(function (k) {
      out[k] = decode(fields[k]);
    });
    return out;
  }
  function fromDoc(doc) {
    if (!doc || !doc.name) return null;
    const data = decodeFields(doc.fields);
    data.id = doc.name.split('/').pop();
    data._path = doc.name.split('/documents/')[1];
    return data;
  }

  // Turn {"a.b": 1, c: 2} into nested fields + field paths for an update mask.
  function maskAndFields(data) {
    const nested = {};
    const paths = [];
    Object.keys(data).forEach(function (key) {
      if (key === 'id' || key === '_path' || data[key] === undefined) return;
      paths.push(fieldPath(key));
      const parts = key.split('.');
      let node = nested;
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = node[parts[i]] || {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = data[key];
    });
    return { fields: encodeFields(nested), paths: paths };
  }
  // Dotted path with each segment quoted when needed (e.g. links.`0abc`.clicks).
  function fieldPath(key) {
    return String(key).split('.').map(quotePath).join('.');
  }
  function quotePath(p) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? p : '`' + p.replace(/`/g, '\\`') + '`';
  }
  function maskQuery(paths) {
    return paths.map(function (p) { return 'updateMask.fieldPaths=' + encodeURIComponent(p); }).join('&');
  }

  // ---------------------------------------------------------------- CRUD
  function get(path) {
    return fromDoc(call('get', root() + '/' + path));
  }

  /** Replace a document (or merge top-level / dotted keys when opts.merge). */
  function set(path, data, opts) {
    if (opts && opts.merge) return update(path, data, { mustExist: false });
    return fromDoc(call('patch', root() + '/' + path, { fields: encodeFields(strip(data)) }));
  }

  /** Update the given (possibly dotted) fields. Fails if the doc is missing unless mustExist === false. */
  function update(path, data, opts) {
    const mf = maskAndFields(data);
    const exists = !(opts && opts.mustExist === false);
    const qs = maskQuery(mf.paths) + (exists ? '&currentDocument.exists=true' : '');
    return fromDoc(call('patch', root() + '/' + path + '?' + qs, { fields: mf.fields }));
  }

  /** Create a document; returns null when `id` is given and already exists. */
  function create(collectionPath, data, id) {
    const url = root() + '/' + collectionPath + (id ? '?documentId=' + encodeURIComponent(id) : '');
    try {
      return fromDoc(call('post', url, { fields: encodeFields(strip(data)) }));
    } catch (e) {
      if (e.code === 409) return null;
      throw e;
    }
  }

  function remove(path) {
    call('delete', root() + '/' + path);
  }

  function strip(data) {
    const out = {};
    Object.keys(data).forEach(function (k) {
      if (k !== 'id' && k !== '_path') out[k] = data[k];
    });
    return out;
  }

  // ---------------------------------------------------------------- queries
  const OPS = {
    '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN',
    '>=': 'GREATER_THAN_OR_EQUAL', 'array-contains': 'ARRAY_CONTAINS', in: 'IN', 'array-contains-any': 'ARRAY_CONTAINS_ANY',
  };

  /**
   * query('messages', { where: [['status', '==', 'queued']], orderBy: [['created_at', 'asc']], limit: 50, parent: 'leadSearches/x' })
   */
  function query(collectionId, q) {
    q = q || {};
    const sq = { from: [{ collectionId: collectionId }] };
    const filters = (q.where || []).map(function (w) {
      return { fieldFilter: { field: { fieldPath: w[0] }, op: OPS[w[1]], value: encode(w[2]) } };
    });
    if (filters.length === 1) sq.where = filters[0];
    else if (filters.length > 1) sq.where = { compositeFilter: { op: 'AND', filters: filters } };
    if (q.orderBy) {
      sq.orderBy = q.orderBy.map(function (o) {
        return { field: { fieldPath: o[0] }, direction: o[1] === 'desc' ? 'DESCENDING' : 'ASCENDING' };
      });
    }
    if (q.limit) sq.limit = q.limit;
    const url = root() + (q.parent ? '/' + q.parent : '') + ':runQuery';
    const rows = call('post', url, { structuredQuery: sq }) || [];
    return rows.filter(function (r) { return r.document; }).map(function (r) { return fromDoc(r.document); });
  }

  // ---------------------------------------------------------------- batched writes
  /**
   * Atomic batch. Each op: { set: path, data } | { update: path, data, mustExist } |
   * { create: path, data } | { delete: path } and optional { increment: {field: n}, arrayUnion: {field: [..]}, arrayRemove: {...} }
   */
  function commit(ops) {
    for (let i = 0; i < ops.length; i += 450) {
      const writes = ops.slice(i, i + 450).map(toWrite);
      call('post', root() + ':commit', { writes: writes });
    }
  }

  function toWrite(op) {
    let w;
    if (op.delete) return { delete: docName(op.delete) };
    const path = op.set || op.update || op.create || op.transform;
    if (op.set) w = { update: { name: docName(path), fields: encodeFields(strip(op.data || {})) } };
    else if (op.create) w = { update: { name: docName(path), fields: encodeFields(strip(op.data || {})) }, currentDocument: { exists: false } };
    else if (op.update) {
      const mf = maskAndFields(op.data || {});
      w = { update: { name: docName(path), fields: mf.fields }, updateMask: { fieldPaths: mf.paths } };
      if (op.mustExist !== false) w.currentDocument = { exists: true };
    } else {
      // transform-only write on a document that may not exist yet
      w = { update: { name: docName(path), fields: {} }, updateMask: { fieldPaths: [] } };
    }
    const t = [];
    Object.keys(op.increment || {}).forEach(function (f) {
      t.push({ fieldPath: fieldPath(f), increment: encode(op.increment[f]) });
    });
    Object.keys(op.arrayUnion || {}).forEach(function (f) {
      t.push({ fieldPath: fieldPath(f), appendMissingElements: { values: op.arrayUnion[f].map(encode) } });
    });
    Object.keys(op.arrayRemove || {}).forEach(function (f) {
      t.push({ fieldPath: fieldPath(f), removeAllFromArray: { values: op.arrayRemove[f].map(encode) } });
    });
    if (t.length) w.updateTransforms = t;
    return w;
  }

  /** Convenience: increment counters on one document (creating it if needed). */
  function increment(path, counters, extra) {
    commit([{ transform: path, update: extra ? path : undefined, data: extra, mustExist: false, increment: counters }]);
  }

  return { get: get, set: set, update: update, create: create, remove: remove, query: query, commit: commit, increment: increment, encode: encode, decode: decode };
})();
