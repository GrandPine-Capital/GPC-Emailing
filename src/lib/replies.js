/*
 * Reply detection. Replies come in either by polling an IMAP mailbox or via
 * the inbound webhook (/api/inbound/reply) that providers such as SendGrid
 * Inbound Parse, Mailgun Routes or Postmark can call.
 */
const db = require('../db');
const { recordEvent } = require('./delivery');

const extractIds = (value) => (Array.isArray(value) ? value.join(' ') : String(value || '')).match(/<[^<>\s]+>/g) || [];

const addressOf = (from) => {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};

/** Strip quoted history so keyword triggers only see what the contact wrote. */
function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From:\s/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Store a reply, link it to the original message/contact and fire the
 * `reply_received` automation trigger. Returns the reply row or null if
 * it was a duplicate / unrelated mail.
 */
function recordReply({ from, subject = '', text = '', headerMessageId, inReplyTo, references }) {
  const fromEmail = addressOf(from);
  if (!fromEmail) return null;
  if (fromEmail === String(db.getSetting('from_email')).toLowerCase()) return null; // our own mail
  if (headerMessageId && db.get('SELECT id FROM replies WHERE header_message_id = ?', headerMessageId)) return null;

  // 1) Thread match on Message-ID; 2) fall back to the latest mail we sent to that address.
  let message = null;
  for (const id of [...extractIds(inReplyTo), ...extractIds(references)].reverse()) {
    message = db.get('SELECT * FROM messages WHERE message_id = ?', id);
    if (message) break;
  }
  let contact = message
    ? db.get('SELECT * FROM contacts WHERE id = ?', message.contact_id)
    : db.get('SELECT * FROM contacts WHERE email = ?', fromEmail);
  if (!message && contact) {
    message = db.get("SELECT * FROM messages WHERE contact_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1", contact.id);
  }
  if (!contact) return null; // not someone we emailed

  const body = stripQuoted(text);
  const res = db.run(
    'INSERT INTO replies (contact_id, message_id, from_email, subject, body, header_message_id) VALUES (?, ?, ?, ?, ?, ?)',
    contact.id, message?.id ?? null, fromEmail, subject, body.slice(0, 20000), headerMessageId || null,
  );
  const ts = db.now();
  db.run('UPDATE contacts SET replied_at = ? WHERE id = ?', ts, contact.id);
  if (message) db.run('UPDATE messages SET replied_at = COALESCE(replied_at, ?) WHERE id = ?', ts, message.id);
  recordEvent('reply', { messageId: message?.id ?? null, contactId: contact.id, data: { subject } });

  require('./automations').fire('reply_received', {
    contactId: contact.id,
    campaignId: message?.campaign_id ?? null,
    templateId: message?.template_id ?? null,
    messageId: message?.id ?? null,
    text: `${subject}\n${body}`,
  });
  return db.get('SELECT * FROM replies WHERE id = ?', Number(res.lastInsertRowid));
}

let polling = false;

/** Fetch new mail from IMAP since the last seen UID. */
async function pollImap() {
  const s = db.getSettings();
  if (!s.imap_host || !s.imap_user || polling) return { skipped: true };
  polling = true;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({
    host: s.imap_host,
    port: Number(s.imap_port || 993),
    secure: String(s.imap_secure) !== 'false',
    auth: { user: s.imap_user, pass: s.imap_pass },
    logger: false,
  });
  let found = 0;
  try {
    await client.connect();
    const box = await client.mailboxOpen(s.imap_mailbox || 'INBOX');
    const validity = String(box.uidValidity);
    let lastUid = Number(db.getSetting('imap_last_uid') || 0);
    if (db.getSetting('imap_uid_validity') !== validity) {
      // First run (or mailbox reset): only look at the most recent mail.
      lastUid = Math.max(0, Number(box.uidNext || 1) - 200);
      db.setSetting('imap_uid_validity', validity);
    }
    let maxUid = lastUid;
    for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= lastUid) continue;
      maxUid = Math.max(maxUid, msg.uid);
      const parsed = await simpleParser(msg.source);
      const reply = recordReply({
        from: parsed.from?.text,
        subject: parsed.subject,
        text: parsed.text || '',
        headerMessageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
      });
      if (reply) found++;
    }
    db.setSetting('imap_last_uid', maxUid);
    db.setSetting('imap_last_poll', db.now());
    return { found };
  } finally {
    polling = false;
    await client.logout().catch(() => {});
  }
}

module.exports = { recordReply, pollImap, stripQuoted, addressOf };
