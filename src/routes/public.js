/* Public (unauthenticated) endpoints: open/click tracking, unsubscribe, inbound reply webhook. */
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { verify, escapeHtml } = require('../lib/personalize');
const { recordEvent } = require('../lib/delivery');
const { recordReply } = require('../lib/replies');

const router = express.Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const automations = () => require('../lib/automations');

const byToken = (token) => db.get('SELECT * FROM messages WHERE token = ?', token);

function markOpened(m) {
  const first = !m.opened_at;
  db.run('UPDATE messages SET opened_at = COALESCE(opened_at, ?), open_count = open_count + 1 WHERE id = ?', db.now(), m.id);
  if (first) {
    recordEvent('open', { messageId: m.id, contactId: m.contact_id });
    automations().fire('email_opened', { contactId: m.contact_id, campaignId: m.campaign_id, templateId: m.template_id, messageId: m.id });
  }
}

router.get('/t/o/:file', (req, res) => {
  const m = byToken(req.params.file.replace(/\.gif$/, ''));
  if (m) markOpened(m);
  res.set({ 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, private', pragma: 'no-cache' });
  res.end(PIXEL);
});

router.get('/t/c/:token', (req, res) => {
  const url = String(req.query.u || '');
  if (!/^https?:\/\//i.test(url) || !verify(url, String(req.query.s || ''))) return res.status(400).send('Invalid link');
  const m = byToken(req.params.token);
  if (m) {
    if (!m.opened_at) markOpened(m); // a click implies an open (images may be blocked)
    db.run('UPDATE messages SET clicked_at = COALESCE(clicked_at, ?), click_count = click_count + 1 WHERE id = ?', db.now(), m.id);
    recordEvent('click', { messageId: m.id, contactId: m.contact_id, data: { url } });
    automations().fire('link_clicked', { contactId: m.contact_id, campaignId: m.campaign_id, templateId: m.template_id, messageId: m.id, url });
  }
  res.redirect(302, url);
});

const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f4f5f7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.card{background:#fff;padding:32px;border-radius:12px;max-width:440px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
button{background:#dc2626;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer}</style></head>
<body><div class="card">${body}</div></body></html>`;

router.get('/u/:token', (req, res) => {
  const m = byToken(req.params.token);
  const c = m && db.get('SELECT email, status FROM contacts WHERE id = ?', m.contact_id);
  if (!c) return res.send(page('Unsubscribe', '<h2>Unsubscribe</h2><p>This link is a preview or has expired.</p>'));
  if (c.status === 'unsubscribed') return res.send(page('Unsubscribed', `<h2>You're unsubscribed</h2><p>${escapeHtml(c.email)} will no longer receive our emails.</p>`));
  res.send(page('Unsubscribe', `<h2>Unsubscribe</h2><p>Stop sending emails to <strong>${escapeHtml(c.email)}</strong>?</p>
    <form method="post"><button type="submit">Unsubscribe me</button></form>`));
});

// Handles both the confirmation form and RFC 8058 one-click unsubscribe.
router.post('/u/:token', express.urlencoded({ extended: false }), (req, res) => {
  const m = byToken(req.params.token);
  if (m) {
    const c = db.get('SELECT status FROM contacts WHERE id = ?', m.contact_id);
    if (c && c.status !== 'unsubscribed') {
      db.run("UPDATE contacts SET status = 'unsubscribed' WHERE id = ?", m.contact_id);
      db.run("UPDATE automation_runs SET status = 'stopped' WHERE contact_id = ? AND status = 'active'", m.contact_id);
      recordEvent('unsubscribe', { messageId: m.id, contactId: m.contact_id });
    }
  }
  res.send(page('Unsubscribed', "<h2>You're unsubscribed</h2><p>You will no longer receive these emails.</p>"));
});

/*
 * Inbound reply webhook. Works with SendGrid Inbound Parse (multipart),
 * Mailgun Routes (form) and Postmark / custom JSON payloads.
 */
function headerFrom(raw, name) {
  if (Array.isArray(raw)) {
    const h = raw.find((x) => String(x.Name || x.name || x[0]).toLowerCase() === name.toLowerCase());
    return h ? h.Value || h.value || h[1] : undefined;
  }
  const m = String(raw || '').match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im'));
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : undefined;
}

router.post('/api/inbound/reply', multer().none(), (req, res) => {
  const { inboundKey } = require('./engage');
  if (req.query.key !== inboundKey()) return res.status(401).json({ error: 'Invalid key' });
  const b = req.body || {};
  const headers = b.headers || b.Headers || b['message-headers'];
  const pick = (...keys) => keys.map((k) => b[k]).find((v) => v != null && v !== '');
  const reply = recordReply({
    from: pick('from', 'From', 'sender'),
    subject: pick('subject', 'Subject') || '',
    text: pick('stripped-text', 'StrippedTextReply', 'text', 'TextBody', 'body-plain') || '',
    headerMessageId: pick('message_id', 'Message-Id', 'MessageID') || headerFrom(headers, 'Message-ID'),
    inReplyTo: pick('in_reply_to', 'In-Reply-To') || headerFrom(headers, 'In-Reply-To'),
    references: pick('references', 'References') || headerFrom(headers, 'References'),
  });
  res.json({ ok: true, matched: !!reply });
});

module.exports = router;
