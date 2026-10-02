/*
 * Sending through the owner's Gmail account using the Gmail advanced service
 * (raw MIME), which lets us set List-Unsubscribe and thread follow-ups.
 */
var Mailer = (function () {
  function encodeWord(s) {
    s = String(s || '');
    return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Utilities.base64Encode(Utilities.newBlob(s).getBytes()) + '?=';
  }

  function address(name, email) {
    if (!name) return email;
    const n = /^[\x20-\x7e]*$/.test(name) ? '"' + String(name).replace(/"/g, "'") + '"' : encodeWord(name);
    return n + ' <' + email + '>';
  }

  function b64Lines(s) {
    return Utilities.base64Encode(Utilities.newBlob(String(s || '')).getBytes()).replace(/(.{76})/g, '$1\r\n');
  }

  /** Build an RFC 2822 multipart/alternative message. */
  function buildMime(m) {
    const boundary = 'b_' + newToken();
    const headers = [
      'MIME-Version: 1.0',
      'From: ' + address(m.fromName, m.fromEmail),
      'To: ' + address(m.toName, m.to),
      'Subject: ' + encodeWord(m.subject),
    ];
    if (m.replyTo) headers.push('Reply-To: ' + m.replyTo);
    if (m.inReplyTo) headers.push('In-Reply-To: ' + m.inReplyTo, 'References: ' + m.inReplyTo);
    Object.keys(m.headers || {}).forEach(function (k) {
      headers.push(k + ': ' + m.headers[k]);
    });
    headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    const parts = [];
    if (m.text) parts.push('--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64Lines(m.text));
    if (m.html) parts.push('--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64Lines(m.html));
    return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n') + '\r\n--' + boundary + '--';
  }

  /**
   * Send an email. Returns { id, threadId, dryRun }.
   * m: { to, toName, subject, html, text, fromName, replyTo, headers, threadId, inReplyTo }
   */
  function send(m) {
    const s = CONFIG.settings();
    const msg = {};
    Object.keys(m).forEach(function (k) {
      if (m[k] !== undefined && m[k] !== null && m[k] !== '') msg[k] = m[k];
    });
    const from = resolveFrom(msg.fromEmail || s.default_from_email);
    msg.fromEmail = from.email;
    msg.fromName = msg.fromName || from.name || s.from_name;
    msg.replyTo = msg.replyTo || s.reply_to || undefined;
    if (s.dry_run && !m.force) return { id: 'dry-' + newToken(), threadId: 'dry-' + newToken(), dryRun: true };
    const raw = Utilities.base64EncodeWebSafe(Utilities.newBlob(buildMime(msg)).getBytes());
    const resource = { raw: raw };
    if (m.threadId) resource.threadId = m.threadId;
    const res = Gmail.Users.Messages.send(resource, 'me');
    return { id: res.id, threadId: res.threadId, dryRun: false };
  }

  let sendersCache = null;
  /**
   * Pick the From address. Any verified Gmail "Send mail as" alias of the
   * worker's account may be used; anything else is rejected by design
   * (Gmail would rewrite or refuse it).
   */
  function resolveFrom(requested) {
    const account = String(CONFIG.senderEmail()).toLowerCase();
    const want = String(requested || '').trim().toLowerCase();
    if (!want || want === account) return { email: account, name: '' };
    if (!sendersCache) sendersCache = Integrations.allowedSenders();
    if (sendersCache.emails.indexOf(want) < 0) {
      throw new Error(want + ' is not a verified "Send mail as" address of ' + account + ' (Settings → Sender identities)');
    }
    const entry = sendersCache.list.filter(function (x) { return x.email === want; })[0] || {};
    return { email: want, name: entry.name || '' };
  }

  /** RFC Message-ID header of a sent Gmail message (needed to thread replies). */
  function rfcMessageId(gmailId) {
    try {
      const msg = Gmail.Users.Messages.get('me', gmailId, { format: 'metadata', metadataHeaders: ['Message-ID', 'Message-Id'] });
      const h = (msg.payload.headers || []).filter(function (x) { return /^message-id$/i.test(x.name); })[0];
      return h ? h.value : '';
    } catch (e) {
      return '';
    }
  }

  /** Emails left today: the lower of Google's quota and the configured daily limit. */
  function remainingToday() {
    const limit = Number(CONFIG.settings().daily_limit) || 100;
    const day = FS.get('stats/daily-' + dayKey()) || {};
    const own = Math.max(0, limit - Number(day.sent || 0));
    let google = own;
    try {
      google = MailApp.getRemainingDailyQuota();
    } catch (e) {
      /* quota API unavailable */
    }
    return Math.max(0, Math.min(own, google));
  }

  function reset() {
    sendersCache = null;
  }

  return { reset: reset, resolveFrom: resolveFrom, send: send, buildMime: buildMime, rfcMessageId: rfcMessageId, remainingToday: remainingToday };
})();
