/*
 * Reply detection straight from the Gmail inbox (no IMAP needed).
 * Replies are matched to the email they answer by Gmail thread id, falling
 * back to the sender's address. Also handles "unsubscribe" mailto requests
 * and bounce notifications.
 */
var Replies = (function () {
  const LAST_POLL = 'REPLIES_LAST_POLL';

  function messageForThread(threadId) {
    const rows = FS.query('messages', { where: [['thread_id', '==', threadId]] });
    rows.sort(function (a, b) { return String(b.sent_at || '').localeCompare(String(a.sent_at || '')); });
    return rows[0] || null;
  }

  /**
   * Store a reply, link it to the original message/contact and fire the
   * reply_received trigger. Returns the reply doc, or null when ignored.
   */
  function record(r) {
    const fromEmail = EmailCore.addressOf(r.from);
    if (!fromEmail || fromEmail === String(CONFIG.senderEmail()).toLowerCase()) return null;

    let message = r.threadId ? messageForThread(r.threadId) : null;
    let contact = message ? FS.get('contacts/' + message.contact_id) : FS.get('contacts/' + EmailCore.emailKey(fromEmail));
    if (!contact) return null; // not someone we emailed
    if (!message) {
      const sent = FS.query('messages', { where: [['contact_id', '==', contact.id]] }).filter(function (m) { return m.status === 'sent'; });
      sent.sort(function (a, b) { return String(b.sent_at).localeCompare(String(a.sent_at)); });
      message = sent[0] || null;
    }

    const body = EmailCore.stripQuoted(r.text).slice(0, 20000);
    const doc = FS.create('replies', {
      contact_id: contact.id,
      message_id: message ? message.id : null,
      campaign_id: message ? message.campaign_id : null,
      campaign_name: message ? message.campaign_name : null,
      original_subject: message ? message.subject : null,
      from_email: fromEmail,
      first_name: contact.first_name || '',
      last_name: contact.last_name || '',
      company: contact.company || '',
      subject: r.subject || '',
      body: body,
      received_at: r.date || nowIso(),
      created_at: nowIso(),
    }, r.id || undefined);
    if (!doc) return null; // duplicate

    const ts = nowIso();
    const ops = [{ update: 'contacts/' + contact.id, data: { replied_at: ts } }];
    if (message) {
      ops.push({ update: 'messages/' + message.id, data: message.replied_at ? {} : { replied_at: ts } });
      if (!message.replied_at && message.campaign_id) ops.push({ transform: 'campaigns/' + message.campaign_id, increment: { 'stats.replied': 1 } });
    }
    FS.commit(ops);
    bumpDaily('replies');

    Automations.fire('reply_received', {
      contactId: contact.id,
      campaignId: message ? message.campaign_id : null,
      templateId: message ? message.template_id : null,
      messageId: message ? message.id : null,
      text: (r.subject || '') + '\n' + body,
    });
    return doc;
  }

  function handleUnsubscribeRequest(subject, fromEmail) {
    const m = String(subject || '').match(/^\s*unsubscribe\s+([a-f0-9]{24})\b/i);
    if (m) return Tracking.unsubscribe(m[1]);
    if (/^\s*unsubscribe\s*$/i.test(subject || '')) return Tracking.unsubscribeContact(EmailCore.emailKey(fromEmail));
    return false;
  }

  function handleBounce(msg) {
    const body = msg.getPlainBody() || '';
    const m = body.match(/Final-Recipient:\s*rfc822;\s*([^\s]+)/i) ||
      body.match(/(?:wasn't delivered to|couldn't be delivered to|delivery to the following recipient failed[^:]*:)\s*<?([^\s>]+@[^\s>]+)>?/i);
    if (!m) return false;
    const key = EmailCore.emailKey(m[1]);
    const c = FS.get('contacts/' + key);
    if (!c || c.status === 'bounced') return false;
    FS.update('contacts/' + key, { status: 'bounced', bounced_at: nowIso() });
    Automations.stopRunsFor(key);
    Automations.fire('bounced', { contactId: key });
    return true;
  }

  /** Scan recent inbox mail for replies, unsubscribe requests and bounces. */
  function poll(hasTime) {
    const props = PropertiesService.getScriptProperties();
    const last = Number(props.getProperty(LAST_POLL) || 0) || Date.now() - 2 * 86400e3;
    const started = Date.now();
    const since = Math.floor((last - 10 * 60e3) / 1000); // overlap; duplicates are ignored
    const me = String(CONFIG.senderEmail()).toLowerCase();
    let found = 0;
    const threads = GmailApp.search('in:inbox after:' + since, 0, 100);
    for (let i = 0; i < threads.length && hasTime(); i++) {
      const thread = threads[i];
      thread.getMessages().forEach(function (msg) {
        if (msg.getDate().getTime() < since * 1000) return;
        const from = msg.getFrom();
        const fromEmail = EmailCore.addressOf(from);
        if (fromEmail === me) return;
        if (/mailer-daemon|postmaster/i.test(fromEmail)) {
          handleBounce(msg);
          return;
        }
        if (handleUnsubscribeRequest(msg.getSubject(), fromEmail)) return;
        const doc = record({
          id: msg.getId(),
          threadId: thread.getId(),
          from: from,
          subject: msg.getSubject(),
          text: msg.getPlainBody(),
          date: msg.getDate().toISOString(),
        });
        if (doc) found++;
      });
    }
    props.setProperty(LAST_POLL, String(started));
    FS.set('settings/status', { last_reply_poll: nowIso() }, { merge: true });
    return found;
  }

  return { record: record, poll: poll };
})();
