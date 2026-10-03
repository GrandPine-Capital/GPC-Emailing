/*
 * Auto-reply rules (collection `autoreplies`), evaluated for every new email
 * that arrives in the connected Gmail inbox - including email sent to your
 * other addresses that forward into it.
 *
 * Rule fields:
 *   name, enabled, order
 *   to_address      '' = any of my addresses, else only email sent to this address
 *   audience        'all' | 'new' (not yet a contact) | 'contacts'
 *   keywords        reply only if subject/body contains one of these (comma separated)
 *   exclude         skip senders whose address contains one of these
 *   template_id     reply content; keep_thread (default true) replies as "Re: <subject>"
 *   from_mode       'recipient' (reply from the address they wrote to) | 'default' | 'custom' (+ from_email)
 *   cooldown_hours  reply to the same sender at most once per N hours (min 1)
 *   schedule        { mode: 'always' | 'outside' | 'inside', days: [1..7], start: '09:00', end: '18:00' }, timezone
 *   create_contact, list_id, tags, notify_email
 *
 * Safety: never replies to yourself, bounces, no-reply addresses, mailing
 * lists / newsletters, or other auto-responders (RFC 3834).
 */
var AutoReply = (function () {
  const SKIP_SENDER = /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([._-]|@)/i;
  let rulesCache = null;

  function rules() {
    if (!rulesCache) {
      rulesCache = FS.query('autoreplies', { where: [['enabled', '==', true]] });
      rulesCache.sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.created_at).localeCompare(String(b.created_at)); });
    }
    return rulesCache;
  }
  function reset() {
    rulesCache = null;
  }

  /** True when the message is itself automated (list mail, newsletters, auto-replies). */
  function isAutomated(m) {
    const h = m.header;
    const auto = String(h('Auto-Submitted') || '').toLowerCase();
    if (auto && auto !== 'no') return 'auto-submitted';
    if (/^(bulk|list|junk|auto_reply)$/i.test(String(h('Precedence') || '').trim())) return 'bulk/list mail';
    if (h('List-Id') || h('List-Unsubscribe')) return 'mailing list or newsletter';
    if (h('X-Autoreply') || h('X-Autorespond') || h('X-Auto-Response-Suppress')) return 'auto-responder';
    if (SKIP_SENDER.test(m.fromEmail)) return 'no-reply sender';
    return '';
  }

  function inSchedule(rule, date) {
    const sch = rule.schedule || {};
    if (!sch.mode || sch.mode === 'always') return true;
    const tz = rule.timezone || CONFIG.settings().timezone || 'Etc/UTC';
    const parts = Utilities.formatDate(date, tz, 'u HH:mm').split(' ');
    const day = Number(parts[0]);
    const time = parts[1];
    const days = (sch.days && sch.days.length ? sch.days : [1, 2, 3, 4, 5]).map(Number);
    const start = sch.start || '09:00';
    const end = sch.end || '18:00';
    const open = days.indexOf(day) >= 0 && time >= start && time < end;
    return sch.mode === 'inside' ? open : !open;
  }

  function words(list) {
    return String(list || '').split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean);
  }

  /** Why this rule does not apply ('' when it does). */
  function mismatch(rule, m, contact) {
    if (rule.to_address && m.recipients.indexOf(String(rule.to_address).toLowerCase()) < 0) return 'sent to another address';
    if (rule.audience === 'new' && contact) return 'sender is already a contact';
    if (rule.audience === 'contacts' && !contact) return 'sender is not a contact';
    const ex = words(rule.exclude);
    if (ex.some(function (w) { return m.fromEmail.indexOf(w) >= 0; })) return 'sender excluded';
    const kw = words(rule.keywords);
    const text = (m.subject + '\n' + m.text).toLowerCase();
    if (kw.length && !kw.some(function (w) { return text.indexOf(w) >= 0; })) return 'no keyword match';
    if (!inSchedule(rule, m.date)) return 'outside the rule schedule';
    return '';
  }

  function recentlyReplied(rule, fromEmail) {
    const hours = Math.max(1, Number(rule.cooldown_hours) || 24);
    const cutoff = nowIso(new Date(Date.now() - hours * 3600e3));
    return FS.query('inbound', { where: [['autoreply_rule', '==', rule.id], ['from_email', '==', fromEmail]] })
      .some(function (d) { return d.replied_at && d.replied_at >= cutoff; });
  }

  function fromFor(rule, m) {
    const allowed = Integrations.allowedSenders().emails;
    if (rule.from_mode === 'custom' && rule.from_email) return rule.from_email;
    if (rule.from_mode === 'default') return undefined;
    // Reply from the address they wrote to, when it is one of ours.
    for (let i = 0; i < m.recipients.length; i++) if (allowed.indexOf(m.recipients[i]) >= 0) return m.recipients[i];
    return undefined;
  }

  function nameParts(from) {
    const name = String(from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
    if (!name || name.indexOf('@') >= 0) return { first_name: '', last_name: '' };
    const p = name.split(/\s+/);
    return { first_name: p.shift() || '', last_name: p.join(' ') };
  }

  /**
   * Evaluate the rules for one inbound message.
   * m: { id, threadId, rfcMessageId, from, fromEmail, subject, text, date, recipients, header(name) }
   * Returns { status: 'replied' | 'skipped' | 'no_rule', rule, reason, contactId }.
   */
  function handle(m) {
    const all = rules();
    if (!all.length) return { status: 'no_rule', reason: 'no auto-reply rules enabled' };
    const automated = isAutomated(m);
    if (automated) return { status: 'skipped', reason: automated };

    let contact = FS.get('contacts/' + EmailCore.emailKey(m.fromEmail));
    let lastReason = '';
    for (let i = 0; i < all.length; i++) {
      const rule = all[i];
      const why = mismatch(rule, m, contact);
      if (why) { lastReason = rule.name + ': ' + why; continue; }
      if (recentlyReplied(rule, m.fromEmail)) return { status: 'skipped', rule: rule.id, reason: 'already auto-replied to this sender recently' };
      if (Mailer.remainingToday() <= 0) return { status: 'skipped', rule: rule.id, reason: 'daily sending limit reached' };
      const template = Delivery.getTemplate(rule.template_id);
      if (!template) return { status: 'skipped', rule: rule.id, reason: 'template missing' };

      const person = Object.assign({ email: m.fromEmail }, nameParts(m.from), contact || {});
      const keepThread = rule.keep_thread !== false;
      const baseSubject = String(m.subject || '').replace(/^\s*(re|aw|fw|fwd)\s*:\s*/i, '');
      const email = Delivery.buildEmail({
        html: Delivery.templateHtml(template),
        subject: keepThread ? 'Re: ' + (baseSubject || template.subject) : template.subject || 'Re: ' + baseSubject,
        contact: person,
        token: 'auto',
        track: false,
        noUnsubscribe: true,
      });
      Mailer.send({
        to: m.fromEmail,
        toName: [person.first_name, person.last_name].filter(Boolean).join(' '),
        subject: email.subject,
        html: email.html,
        text: email.text,
        fromEmail: fromFor(rule, m),
        threadId: keepThread ? m.threadId : undefined,
        inReplyTo: keepThread ? m.rfcMessageId : undefined,
        headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
      });
      bumpDaily('sent');
      FS.commit([{ update: 'autoreplies/' + rule.id, data: { last_replied_at: nowIso() }, increment: { replied_count: 1 } }]);

      if (rule.create_contact || rule.list_id || (rule.tags && String(rule.tags).trim())) {
        contact = Inbound.upsertContact(Object.assign({ email: m.fromEmail, source: 'email' }, nameParts(m.from), {
          tags: EmailCore.normaliseTags(rule.tags), list_id: rule.list_id || '',
        }));
      }
      if (rule.notify_email) {
        Mailer.send({
          to: rule.notify_email, force: true,
          subject: '[Auto-reply] ' + m.fromEmail + ': ' + (m.subject || '(no subject)'),
          text: 'Rule "' + rule.name + '" auto-replied to ' + m.from + '.\n\nTheir message:\n' + String(m.text || '').slice(0, 3000),
        });
      }
      return { status: 'replied', rule: rule.id, reason: rule.name, contactId: contact ? contact.id : null };
    }
    return { status: 'skipped', reason: lastReason || 'no rule matched' };
  }

  return { handle: handle, reset: reset, isAutomated: isAutomated, inSchedule: inSchedule };
})();
