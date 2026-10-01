/*
 * Opens (pixel served by this web app), clicks and unsubscribes.
 * Clicks and unsubscribe-page submissions are written straight to Firestore
 * by the public Hosting pages (r.html / u.html) and processed here.
 */
var Tracking = (function () {
  function message(token) {
    return token && /^[a-f0-9]{24}$/.test(token) ? FS.get('messages/' + token) : null;
  }

  function markOpened(m) {
    if (!m) return;
    const ops = [{ update: 'messages/' + m.id, data: m.opened_at ? {} : { opened_at: nowIso() }, increment: { open_count: 1 } }];
    if (!m.opened_at && m.campaign_id) ops.push({ transform: 'campaigns/' + m.campaign_id, increment: { 'stats.opened': 1 } });
    FS.commit(ops);
    if (!m.opened_at) {
      m.opened_at = nowIso();
      bumpDaily('opens');
      Automations.fire('email_opened', { contactId: m.contact_id, campaignId: m.campaign_id, templateId: m.template_id, messageId: m.id });
    }
  }

  function open(token) {
    markOpened(message(token));
  }

  function click(token, key) {
    const m = message(token);
    const link = key ? FS.get('links/' + key) : null;
    if (!m || !link) return;
    if (!m.opened_at) markOpened(m); // a click implies an open (images may be blocked)
    const ops = [{ update: 'messages/' + m.id, data: m.clicked_at ? {} : { clicked_at: nowIso() }, increment: { click_count: 1 } }];
    if (m.campaign_id) {
      const inc = {};
      inc['links.' + key + '.clicks'] = 1;
      if (!m.clicked_at) inc['stats.clicked'] = 1;
      const data = {};
      data['links.' + key + '.url'] = link.url;
      ops.push({ update: 'campaigns/' + m.campaign_id, data: data, mustExist: false, increment: inc });
    }
    FS.commit(ops);
    bumpDaily('clicks');
    Automations.fire('link_clicked', { contactId: m.contact_id, campaignId: m.campaign_id, templateId: m.template_id, messageId: m.id, url: link.url });
  }

  function unsubscribeContact(contactId, messageDoc) {
    const c = FS.get('contacts/' + contactId);
    if (!c || c.status === 'unsubscribed') return false;
    const ops = [{ update: 'contacts/' + contactId, data: { status: 'unsubscribed', unsubscribed_at: nowIso() } }];
    if (messageDoc && messageDoc.campaign_id) ops.push({ transform: 'campaigns/' + messageDoc.campaign_id, increment: { 'stats.unsubscribed': 1 } });
    FS.commit(ops);
    Automations.stopRunsFor(contactId);
    return true;
  }

  function unsubscribe(token) {
    const m = message(token);
    return m ? unsubscribeContact(m.contact_id, m) : false;
  }

  /** Process click / unsubscribe events written by the public pages. */
  function processEvents(hasTime) {
    let n = 0;
    // One bad event must not block the rest (e.g. unsubscribes after a failing click).
    const each = function (collection, fn) {
      FS.query(collection, { orderBy: [['created_at', 'asc']], limit: 300 }).forEach(function (doc) {
        if (!hasTime()) return;
        try {
          fn(doc);
        } catch (e) {
          console.error(collection, doc.id, e);
        }
        FS.remove(collection + '/' + doc.id);
        n++;
      });
    };
    each('unsubscribes', function (u) { unsubscribe(u.token); });
    each('clicks', function (c) { click(c.token, c.k); });
    return n;
  }

  return { open: open, click: click, unsubscribe: unsubscribe, unsubscribeContact: unsubscribeContact, processEvents: processEvents };
})();
