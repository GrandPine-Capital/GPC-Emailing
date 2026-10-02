/*
 * Inbound webhooks:  POST <web app URL>?a=hook&k=<webhook secret>[&src=chatdaddy][&event=name]
 *
 *  - ChatDaddy: add the URL with &src=chatdaddy as a webhook for the
 *    "message-insert" event. Incoming WhatsApp messages become replies on the
 *    contact's timeline and fire the `whatsapp_received` trigger.
 *  - Anything else (web forms, Zapier, Make, CRMs…): POST JSON such as
 *    { "email": "...", "phone": "...", "first_name": "...", "company": "...",
 *      "tags": ["webinar"], "list_id": "...", "event": "form_submitted", "text": "..." }
 *    The contact is created/updated and `webhook_received` fires.
 */
var Inbound = (function () {
  function cc() {
    return CONFIG.settings().default_country_code;
  }

  function byPhone(phone) {
    if (!phone) return null;
    return FS.query('contacts', { where: [['phone_key', '==', phone]], limit: 1 })[0] || null;
  }

  /** Create or update a contact from inbound data; returns the contact doc. */
  function upsertContact(d) {
    const email = EmailCore.isEmail(d.email) ? EmailCore.emailKey(d.email) : '';
    const phone = EmailCore.phoneKey(d.phone, cc());
    let contact = email ? FS.get('contacts/' + email) : null;
    if (!contact && phone) contact = byPhone(phone);
    let first = d.first_name || '';
    let last = d.last_name || '';
    if (!first && d.name) {
      const parts = String(d.name).trim().split(/\s+/);
      first = parts.shift() || '';
      last = last || parts.join(' ');
    }
    const fields = { first_name: first, last_name: last, company: d.company, website: d.website, country: d.country, industry: d.industry, phone: d.phone || (phone ? '+' + phone : '') };
    const tags = EmailCore.normaliseTags(d.tags);
    const listId = d.list_id ? String(d.list_id) : '';

    if (!contact) {
      if (!email && !phone) throw new Error('payload needs an email or phone');
      const id = email || 'wa-' + phone;
      const doc = { email: email, tags: tags, list_ids: listId ? [listId] : [], status: 'subscribed', source: d.source || 'webhook', created_at: nowIso(), phone_key: phone };
      EmailCore.CONTACT_FIELDS.forEach(function (f) { doc[f] = fields[f] ? String(fields[f]).trim() : ''; });
      doc.keywords = EmailCore.searchKeywords(doc);
      FS.set('contacts/' + id, doc);
      contact = Object.assign({ id: id }, doc);
      if (listId) Automations.fire('contact_added', { contactId: id, listId: listId });
      tags.forEach(function (t) { Automations.fire('tag_added', { contactId: id, tag: t }); });
      return contact;
    }

    const upd = {};
    EmailCore.CONTACT_FIELDS.forEach(function (f) {
      if (fields[f] && !contact[f]) upd[f] = String(fields[f]).trim();
    });
    if (email && !contact.email) upd.email = email;
    if (phone && !contact.phone_key) upd.phone_key = phone;
    const ops = [{ update: 'contacts/' + contact.id, data: upd }];
    const newTags = tags.filter(function (t) { return (contact.tags || []).indexOf(t) < 0; });
    if (newTags.length) ops[0].arrayUnion = { tags: newTags };
    const newList = listId && (contact.list_ids || []).indexOf(listId) < 0;
    if (newList) ops[0].arrayUnion = Object.assign(ops[0].arrayUnion || {}, { list_ids: [listId] });
    FS.commit(ops);
    if (newList) Automations.fire('contact_added', { contactId: contact.id, listId: listId });
    newTags.forEach(function (t) { Automations.fire('tag_added', { contactId: contact.id, tag: t }); });
    return Object.assign(contact, upd);
  }

  /** ChatDaddy "message-insert" webhook. */
  function chatdaddy(body) {
    let handled = 0;
    const items = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
    items.forEach(function (m) {
      if (!m || m.fromMe) return;
      const chatId = String(m.chatId || '');
      if (/@g\.us$/.test(chatId)) return; // group chats
      const phone = EmailCore.phoneKey(chatId, cc());
      if (!phone) return;
      const name = (m.sender && (m.sender.name || m.sender.pushName)) || '';
      const contact = upsertContact({ phone: '+' + phone, name: name, source: 'whatsapp' });
      receiveWhatsApp(contact, phone, m.text || '[attachment]', m.id);
      handled++;
    });
    return handled;
  }

  /** Record an incoming WhatsApp message and fire automations. */
  function receiveWhatsApp(contact, phone, text, externalId) {
    const id = externalId ? 'wa-' + String(externalId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) : undefined;
    const doc = FS.create('replies', {
      channel: 'whatsapp', contact_id: contact.id, message_id: null, campaign_id: null, campaign_name: null,
      from_email: contact.email || '', phone: phone, first_name: contact.first_name || '', last_name: contact.last_name || '',
      company: contact.company || '', subject: 'WhatsApp message', body: String(text).slice(0, 20000), received_at: nowIso(), created_at: nowIso(),
    }, id);
    if (!doc) return null; // duplicate delivery
    FS.create('whatsapp', { contact_id: contact.id, phone: phone, direction: 'in', text: String(text).slice(0, 4000), created_at: nowIso() });
    FS.update('contacts/' + contact.id, { replied_at: nowIso() });
    bumpDaily('replies');
    Automations.fire('whatsapp_received', { contactId: contact.id, text: text });
    return doc;
  }

  /** Generic JSON webhook. */
  function generic(body, eventParam) {
    const contact = upsertContact(body);
    const event = String(body.event || eventParam || '');
    Automations.fire('webhook_received', { contactId: contact.id, event: event, text: body.text ? String(body.text) : JSON.stringify(body).slice(0, 2000) });
    return contact.id;
  }

  function handle(p, raw) {
    const secret = CONFIG.secrets().webhook_secret;
    if (!secret || p.k !== secret) return { ok: false, error: 'invalid webhook key' };
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      // form-encoded posts arrive as parameters
      body = Object.assign({}, p);
    }
    if (p.src === 'chatdaddy' || body.event === 'message-insert') return { ok: true, handled: chatdaddy(body) };
    return { ok: true, contact: generic(body, p.event) };
  }

  return { handle: handle, upsertContact: upsertContact, receiveWhatsApp: receiveWhatsApp };
})();
