/*
 * Runs the Apps Script project (apps-script/*.js) inside a Node vm context
 * with mocked Google services, so the worker can be tested end to end.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { FakeFirestore } = require('./fake-firestore');

const DIR = path.join(__dirname, '..', '..', 'apps-script');
const OWNER = 'owner@gmail.test';
const WEBAPP = 'https://script.google.com/macros/s/TEST/exec';

const toBuf = (x) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(Array.from(x, (b) => b & 255)));
const toBytes = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));

function response(code, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text, getHeaders: () => headers };
}

function parseMime(raw) {
  const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const [head] = mime.split('\r\n\r\n');
  const headers = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const part = (type) => {
    const m = mime.match(new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`));
    return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
  };
  const decodeWord = (s) => String(s || '').replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  return { headers, subject: decodeWord(headers.subject), to: headers.to, html: part('text/html'), text: part('text/plain') };
}

/** Synchronous HTTP (Apps Script's UrlFetchApp is synchronous) via curl - used against the Firestore emulator. */
function curlSync(method, url, payload, headers = {}) {
  const { execFileSync } = require('node:child_process');
  const args = ['-s', '-X', method.toUpperCase(), url, '-w', '\n%{http_code}', '--noproxy', '*'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (payload !== undefined) args.push('-H', 'content-type: application/json', '--data-binary', '@-');
  const out = execFileSync('curl', args, { input: payload || '', maxBuffer: 64 * 1024 * 1024 }).toString();
  const i = out.lastIndexOf('\n');
  return { code: Number(out.slice(i + 1)), body: out.slice(0, i) };
}

/**
 * options.web(url, opts)      -> fake responses for non-Google URLs
 * options.firestoreEmulator   -> e.g. http://127.0.0.1:8080 to use the real emulator instead of the in-memory fake
 * options.trustJwt            -> accept any (emulator) Firebase ID token and read the email from it
 */
function createGas({ web, firestoreEmulator, trustJwt } = {}) {
  const store = new FakeFirestore('emailing-portal');
  const props = new Map();
  const sent = [];
  const triggers = [];
  const inbox = []; // threads returned by GmailApp.search
  const idTokens = new Map([['admin-token', OWNER], ['stranger-token', 'stranger@gmail.test']]);
  const files = [];
  let gmailSeq = 0;

  const fetch = (url, opts = {}) => {
    const method = String(opts.method || 'get').toLowerCase();
    if (url.startsWith(store.prefix)) {
      if (firestoreEmulator) {
        const r = curlSync(method, firestoreEmulator + url.slice('https://firestore.googleapis.com'.length), opts.payload, { Authorization: 'Bearer owner' });
        return response(r.code, r.body);
      }
      const r = store.handle(method, url, opts.payload);
      return response(r.code, r.body);
    }
    if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
      const tok = JSON.parse(opts.payload).idToken;
      let email = idTokens.get(tok);
      if (!email && trustJwt && tok) {
        try { email = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).email; } catch { email = null; }
      }
      return email ? response(200, { users: [{ email, emailVerified: true }] }) : response(400, { error: { message: 'INVALID_ID_TOKEN' } });
    }
    if (url.endsWith('/__/firebase/init.json')) return response(200, { apiKey: 'test-api-key', projectId: 'emailing-portal' });
    const r = web ? web(url, opts) : null;
    if (!r) return response(404, 'not found');
    return response(r.code || 200, r.body || '', r.headers || { 'Content-Type': 'text/html' });
  };

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    UrlFetchApp: { fetch, fetchAll: (reqs) => reqs.map((r) => fetch(r.url, r)) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Encode: (x) => toBuf(x).toString('base64'),
      base64EncodeWebSafe: (x) => toBuf(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Decode: (s) => toBytes(Buffer.from(s, 'base64')),
      newBlob: (data, mime, name) => ({ getBytes: () => toBytes(toBuf(data)), getDataAsString: () => toBuf(data).toString('utf8'), mime, name }),
      computeHmacSha256Signature: (value, key) => toBytes(crypto.createHmac('sha256', key).update(value).digest()),
      sleep() {},
    },
    ScriptApp: {
      getOAuthToken: () => 'oauth-token',
      getService: () => ({ getUrl: () => WEBAPP }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => triggers.push({ fn, n, getHandlerFunction: () => fn }) }) }) }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: (content) => ({ content, setMimeType(m) { this.mime = m; return this; } }),
    },
    HtmlService: { createHtmlOutput: (content) => ({ content }) },
    MailApp: { getRemainingDailyQuota: () => 100 },
    Gmail: {
      Users: {
        Messages: {
          send: (resource) => {
            gmailSeq++;
            const msg = { id: 'g' + gmailSeq, threadId: resource.threadId || 't' + gmailSeq, ...parseMime(resource.raw) };
            sent.push(msg);
            return { id: msg.id, threadId: msg.threadId };
          },
          get: (user, id) => ({ payload: { headers: [{ name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } }),
        },
      },
    },
    GmailApp: { search: () => inbox.slice() },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'anyone' },
      Permission: { VIEW: 'view' },
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({
        createFile: (blob) => {
          const f = { id: 'file' + files.length, blob, getId() { return this.id; }, setSharing() {} };
          files.push(f);
          return f;
        },
      }),
    },
  };
  const context = vm.createContext(sandbox);
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), context, { filename: f });
  }

  /** Simulate an incoming email in the Gmail inbox. */
  function receive({ threadId, from, subject, body, date = new Date() }) {
    const id = 'in' + crypto.randomBytes(4).toString('hex');
    const tid = threadId || 'th' + crypto.randomBytes(4).toString('hex');
    const msg = { getId: () => id, getFrom: () => from, getSubject: () => subject, getPlainBody: () => body, getDate: () => date };
    inbox.push({ getId: () => tid, getMessages: () => [msg] });
  }

  return { gas: context, store, sent, triggers, inbox, receive, props, files, OWNER, WEBAPP };
}

module.exports = { createGas, parseMime, curlSync };
