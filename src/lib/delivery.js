const crypto = require('node:crypto');
const db = require('../db');
const mailer = require('./mailer');
const { buildEmail, templateHtml, escapeHtml } = require('./personalize');
const { getContact } = require('./contacts');

const newToken = () => crypto.randomBytes(12).toString('hex');

function recordEvent(type, { messageId = null, contactId = null, data = {} } = {}) {
  db.run('INSERT INTO events (type, message_id, contact_id, data) VALUES (?, ?, ?, ?)', type, messageId, contactId, JSON.stringify(data));
}

function createMessage({ contactId, templateId, subject, campaignId = null, automationRunId = null }) {
  const res = db.run(
    'INSERT INTO messages (token, campaign_id, automation_run_id, contact_id, template_id, subject) VALUES (?, ?, ?, ?, ?, ?)',
    newToken(), campaignId, automationRunId, contactId, templateId, subject,
  );
  return db.get('SELECT * FROM messages WHERE id = ?', Number(res.lastInsertRowid));
}

/** Render and send one queued message row. Never throws; returns the new status. */
async function deliver(message, { inReplyTo } = {}) {
  const contact = getContact(message.contact_id);
  if (!contact || contact.status !== 'subscribed') {
    db.run("UPDATE messages SET status = 'skipped', error = ? WHERE id = ?", contact ? `contact ${contact.status}` : 'contact missing', message.id);
    return 'skipped';
  }
  const campaign = message.campaign_id ? db.get('SELECT * FROM campaigns WHERE id = ?', message.campaign_id) : null;
  const template = db.get('SELECT * FROM templates WHERE id = ?', message.template_id);
  if (!template) {
    db.run("UPDATE messages SET status = 'failed', error = 'template missing' WHERE id = ?", message.id);
    return 'failed';
  }

  let html = templateHtml(template);
  if (campaign?.preheader) {
    html = html.replace(/<body([^>]*)>/i, `<body$1><div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(campaign.preheader)}</div>`);
  }
  const email = buildEmail({
    html,
    subject: message.subject || template.subject || campaign?.subject || '',
    contact,
    token: message.token,
  });

  try {
    const { messageId } = await mailer.send({
      to: contact.first_name ? { name: `${contact.first_name} ${contact.last_name || ''}`.trim(), address: contact.email } : contact.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      fromName: campaign?.from_name,
      fromEmail: campaign?.from_email,
      replyTo: campaign?.reply_to,
      token: message.token,
      unsubscribeUrl: email.unsubscribeUrl,
      inReplyTo,
    });
    db.run("UPDATE messages SET status = 'sent', message_id = ?, subject = ?, sent_at = ?, error = NULL WHERE id = ?", messageId, email.subject, db.now(), message.id);
    recordEvent('sent', { messageId: message.id, contactId: contact.id, data: { campaignId: message.campaign_id } });
    require('./automations').fire('email_sent', {
      contactId: contact.id,
      campaignId: message.campaign_id,
      messageId: message.id,
      templateId: message.template_id,
      fromAutomationRun: message.automation_run_id,
    });
    return 'sent';
  } catch (err) {
    db.run("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", String(err.message || err).slice(0, 500), message.id);
    recordEvent('failed', { messageId: message.id, contactId: contact.id, data: { error: String(err.message || err) } });
    return 'failed';
  }
}

module.exports = { deliver, createMessage, recordEvent, newToken };
