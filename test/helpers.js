process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = '';

const db = require('../src/db');
const mailer = require('../src/lib/mailer');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

/** Fresh in-memory DB, seeded, with a capturing mail transport. */
function setup() {
  db.init(':memory:');
  seed();
  db.setSetting('base_url', 'http://test.local');
  db.setSetting('from_email', 'sender@acme.test');
  db.setSetting('send_rate_per_minute', '1000');
  const sent = [];
  mailer.setTransport({
    sendMail: async (msg) => {
      sent.push(msg);
      return { messageId: msg.messageId };
    },
  });
  return { db, sent };
}

async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };
  return { base, server, call, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { setup, startServer };
