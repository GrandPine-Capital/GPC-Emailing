/*
 * Messaging integrations used by automations:
 *  - ChatDaddy (WhatsApp): https://api.chatdaddy.tech/im  (API token from app.chatdaddy.tech → Settings → API)
 *  - WhatsApp Cloud API (Meta): https://graph.facebook.com/<version>/<phone-number-id>/messages
 * plus Gmail "Send mail as" sender identities.
 */
var Integrations = (function () {
  const CHATDADDY = 'https://api.chatdaddy.tech/im';
  const GRAPH = 'https://graph.facebook.com/v21.0';

  function phoneOf(contactOrPhone) {
    const raw = typeof contactOrPhone === 'string' ? contactOrPhone : (contactOrPhone && (contactOrPhone.phone_key || contactOrPhone.phone)) || '';
    return EmailCore.phoneKey(raw, CONFIG.settings().default_country_code);
  }

  function call(url, opts, name) {
    const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, contentType: 'application/json' }, opts));
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code >= 300) throw new Error(name + ' error ' + code + ': ' + text.slice(0, 300));
    try { return text ? JSON.parse(text) : {}; } catch (e) { return {}; }
  }

  // ------------------------------------------------------------- ChatDaddy
  function chatdaddyToken() {
    const t = CONFIG.secrets().chatdaddy_token;
    if (!t) throw new Error('ChatDaddy API token is not set (Settings → Integrations)');
    return t;
  }

  /** Send a WhatsApp text through ChatDaddy. chatId = the phone number in international format. */
  function chatdaddySend(phone, text) {
    const to = phoneOf(phone);
    if (!to) throw new Error('contact has no valid phone number');
    const account = CONFIG.settings().chatdaddy_account_id || 'random';
    return call(CHATDADDY + '/messages/' + encodeURIComponent(account) + '/' + encodeURIComponent(to), {
      method: 'post',
      headers: { Authorization: 'Bearer ' + chatdaddyToken() },
      payload: JSON.stringify({ text: text }),
    }, 'ChatDaddy');
  }

  /** Create or update the contact in ChatDaddy (by phone) and add tags. */
  function chatdaddyUpsert(contact, tags) {
    const to = phoneOf(contact);
    if (!to) throw new Error('contact has no valid phone number');
    const c = {
      phoneNumber: to,
      name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.company || to,
      tags: (tags || []).filter(Boolean).map(function (t) { return { name: t }; }),
    };
    if (contact.email) c.email = contact.email;
    return call(CHATDADDY + '/contacts/upsert', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + chatdaddyToken() },
      payload: JSON.stringify({ contacts: [c] }),
    }, 'ChatDaddy');
  }

  // ------------------------------------------------------------- WhatsApp Cloud API
  /**
   * Free-form text only works within 24h of the contact's last message; outside
   * that window Meta requires an approved template (template + params).
   */
  function cloudSend(phone, opts) {
    const s = CONFIG.settings();
    const token = CONFIG.secrets().whatsapp_token;
    if (!token || !s.whatsapp_phone_number_id) throw new Error('WhatsApp Cloud API is not configured (Settings → Integrations)');
    const to = phoneOf(phone);
    if (!to) throw new Error('contact has no valid phone number');
    const body = { messaging_product: 'whatsapp', to: to };
    if (opts.template) {
      body.type = 'template';
      body.template = { name: opts.template, language: { code: opts.language || s.whatsapp_template_language || 'en' } };
      if (opts.params && opts.params.length) {
        body.template.components = [{ type: 'body', parameters: opts.params.map(function (p) { return { type: 'text', text: String(p) }; }) }];
      }
    } else {
      body.type = 'text';
      body.text = { body: opts.text, preview_url: true };
    }
    return call(GRAPH + '/' + encodeURIComponent(s.whatsapp_phone_number_id) + '/messages', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(body),
    }, 'WhatsApp');
  }

  /** Send a WhatsApp message with the configured / chosen provider. */
  function sendWhatsApp(phone, opts) {
    const provider = opts.provider || CONFIG.settings().whatsapp_provider || 'chatdaddy';
    if (provider === 'cloud') return cloudSend(phone, opts);
    return chatdaddySend(phone, opts.text);
  }

  // ------------------------------------------------------------- Gmail sender identities
  /** Read the Gmail "Send mail as" addresses and store them in settings/senders. */
  function refreshSenders() {
    const res = Gmail.Users.Settings.SendAs.list('me');
    const list = (res.sendAs || []).map(function (s) {
      return {
        email: String(s.sendAsEmail || '').toLowerCase(),
        name: s.displayName || '',
        primary: !!s.isPrimary,
        is_default: !!s.isDefault,
        verified: !!s.isPrimary || s.verificationStatus === 'accepted',
      };
    });
    FS.set('settings/senders', { list: list, updated_at: nowIso() });
    return list;
  }

  /** Verified sender addresses (the account itself is always allowed). */
  function allowedSenders() {
    const doc = FS.get('settings/senders') || {};
    const out = [String(CONFIG.senderEmail()).toLowerCase()];
    (doc.list || []).forEach(function (s) {
      if (s.verified && out.indexOf(s.email) < 0) out.push(s.email);
    });
    return { emails: out, list: doc.list || [] };
  }

  return { sendWhatsApp: sendWhatsApp, chatdaddySend: chatdaddySend, chatdaddyUpsert: chatdaddyUpsert, cloudSend: cloudSend, refreshSenders: refreshSenders, allowedSenders: allowedSenders, phoneOf: phoneOf };
})();
