const nodemailer = require('nodemailer');
const db = require('../db');

let cached = { key: null, transport: null };
let override = null;

function smtpSettings() {
  const s = db.getSettings();
  return {
    host: s.smtp_host,
    port: Number(s.smtp_port || 587),
    secure: String(s.smtp_secure) === 'true',
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
  };
}

const isDryRun = () => !override && !db.getSetting('smtp_host');

function transport() {
  if (override) return override;
  const opts = smtpSettings();
  if (!opts.host) {
    // Dry-run mode: render the full MIME message but don't deliver it.
    if (cached.key !== 'json') cached = { key: 'json', transport: nodemailer.createTransport({ jsonTransport: true }) };
    return cached.transport;
  }
  const key = JSON.stringify(opts);
  if (cached.key !== key) {
    cached = { key, transport: nodemailer.createTransport({ ...opts, pool: true, maxConnections: 3 }) };
  }
  return cached.transport;
}

/** Use a custom nodemailer-compatible transport (tests, or a provider SDK). */
function setTransport(t) {
  override = t;
}

function fromAddress(name, email) {
  const s = db.getSettings();
  return { name: name || s.from_name, address: email || s.from_email };
}

function domainOf(email) {
  return (String(email).split('@')[1] || 'localhost').trim();
}

/**
 * Send one email. `token` keeps the Message-ID stable and recognisable so that
 * replies (In-Reply-To / References) can be matched back to the message.
 */
async function send({ to, subject, html, text, fromName, fromEmail, replyTo, token, unsubscribeUrl, headers = {}, inReplyTo }) {
  const from = fromAddress(fromName, fromEmail);
  const messageId = `<${token || Date.now().toString(36)}@${domainOf(from.address)}>`;
  const allHeaders = { ...headers };
  if (unsubscribeUrl) {
    allHeaders['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    allHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const info = await transport().sendMail({
    from,
    to,
    subject,
    html,
    text,
    replyTo: replyTo || db.getSetting('reply_to') || undefined,
    messageId,
    inReplyTo,
    references: inReplyTo,
    headers: allHeaders,
  });
  return { messageId, dryRun: isDryRun(), info };
}

async function verifyConnection() {
  if (isDryRun()) return { ok: true, dryRun: true, message: 'No SMTP host configured - running in dry-run mode.' };
  await transport().verify();
  return { ok: true, dryRun: false, message: 'SMTP connection OK.' };
}

module.exports = { send, setTransport, isDryRun, verifyConnection };
