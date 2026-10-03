/* Personalise, track and send individual messages. */
var Delivery = (function () {
  const knownLinks = {};

  function templateHtml(t) {
    if (!t) return '';
    if (t.mode === 'dragdrop' && t.design) return EmailRender.renderDesign(t.design);
    return t.html || '';
  }

  function linkKey(url) {
    const key = hmac('link:' + url);
    if (!knownLinks[key]) {
      FS.set('links/' + key, { url: url, created_at: nowIso() });
      knownLinks[key] = true;
    }
    return key;
  }

  /**
   * Build the final email for one recipient: merge tags, unsubscribe link,
   * click-tracked links (via Firebase Hosting /r.html) and an open pixel.
   */
  function buildEmail(opts) {
    const s = CONFIG.settings();
    const site = CONFIG.siteUrl();
    const track = CONFIG.trackingUrl();
    const token = opts.token;
    const unsubscribeUrl = site + '/u.html?t=' + token;
    const vars = Object.assign(EmailCore.contactVars(opts.contact), {
      unsubscribe_url: unsubscribeUrl,
      company_address: s.company_address,
      sender_name: s.from_name,
    });
    let body = EmailCore.merge(opts.html, vars, { html: true });

    // Transactional mail (auto-replies) has no marketing unsubscribe footer.
    if (!opts.noUnsubscribe && body.indexOf(unsubscribeUrl) < 0) {
      const address = s.company_address ? EmailCore.escapeHtml(s.company_address) + '<br>' : '';
      const footer = '<div style="font:12px/1.5 Arial,sans-serif;color:#6b7280;text-align:center;padding:16px;">' + address +
        '<a href="' + unsubscribeUrl + '" style="color:#6b7280;">Unsubscribe</a></div>';
      body = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, footer + '</body>') : body + footer;
    }

    if (opts.track !== false) {
      body = body.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, function (match, rawUrl) {
        const url = rawUrl.replace(/&amp;/g, '&');
        if (url === unsubscribeUrl) return match;
        return 'href="' + site + '/r.html?t=' + token + '&amp;k=' + linkKey(url) + '"';
      });
      if (track) {
        const pixel = '<img src="' + track + '?a=o&amp;t=' + token + '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;">';
        body = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, pixel + '</body>') : body + pixel;
      }
    }

    const headers = {};
    const sender = CONFIG.senderEmail();
    const list = ['<mailto:' + sender + '?subject=unsubscribe%20' + token + '>'];
    if (track) {
      list.push('<' + track + '?a=u1&t=' + token + '>');
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    headers['List-Unsubscribe'] = list.join(', ');

    return {
      subject: EmailCore.merge(opts.subject, vars),
      html: body,
      text: EmailCore.htmlToText(EmailCore.merge(opts.html, vars)) + (opts.noUnsubscribe ? '' : '\n\nUnsubscribe: ' + unsubscribeUrl),
      headers: headers,
      unsubscribeUrl: unsubscribeUrl,
    };
  }

  function createMessage(o) {
    const token = newToken();
    const doc = {
      token: token,
      campaign_id: o.campaignId || null,
      campaign_name: o.campaignName || null,
      automation_id: o.automationId || null,
      automation_run_id: o.runId || null,
      contact_id: o.contact.id,
      email: o.contact.email,
      name: [o.contact.first_name, o.contact.last_name].filter(Boolean).join(' '),
      company: o.contact.company || '',
      template_id: o.templateId,
      from_email: o.fromEmail || null,
      subject: o.subject || '',
      status: 'queued',
      open_count: 0,
      click_count: 0,
      created_at: nowIso(),
    };
    return { op: { create: 'messages/' + token, data: doc }, doc: Object.assign({ id: token }, doc) };
  }

  const templateCache = {};
  function getTemplate(id) {
    if (!(id in templateCache)) templateCache[id] = FS.get('templates/' + id);
    return templateCache[id];
  }
  const campaignCache = {};
  function getCampaign(id) {
    if (!(id in campaignCache)) campaignCache[id] = FS.get('campaigns/' + id);
    return campaignCache[id];
  }

  /** Render + send one queued message. Never throws; returns the new status. */
  function deliver(message, extra) {
    extra = extra || {};
    const contact = FS.get('contacts/' + message.contact_id);
    const campaign = message.campaign_id ? getCampaign(message.campaign_id) : null;
    const campaignPath = campaign ? 'campaigns/' + campaign.id : null;
    const ops = [];
    const finish = function (status, fields, counters) {
      ops.push({ update: 'messages/' + message.id, data: Object.assign({ status: status }, fields) });
      if (campaignPath) {
        const inc = Object.assign({ 'stats.queued': -1 }, counters || {});
        ops.push({ transform: campaignPath, increment: inc });
      }
      FS.commit(ops);
      return status;
    };

    if (!contact || contact.status !== 'subscribed') {
      return finish('skipped', { error: contact ? 'contact ' + contact.status : 'contact missing' }, { 'stats.skipped': 1 });
    }
    const template = getTemplate(message.template_id);
    if (!template) return finish('failed', { error: 'template missing' }, { 'stats.failed': 1 });

    let html = templateHtml(template);
    if (campaign && campaign.preheader) {
      html = html.replace(/<body([^>]*)>/i, '<body$1><div style="display:none;max-height:0;overflow:hidden;">' + EmailCore.escapeHtml(campaign.preheader) + '</div>');
    }
    try {
      const email = buildEmail({
        html: html,
        subject: message.subject || (campaign && campaign.subject) || template.subject || '',
        contact: contact,
        token: message.token || message.id,
      });
      const res = Mailer.send({
        to: contact.email,
        toName: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
        subject: email.subject,
        html: email.html,
        text: email.text,
        fromName: (campaign && campaign.from_name) || undefined,
        fromEmail: (campaign && campaign.from_email) || message.from_email || undefined,
        replyTo: (campaign && campaign.reply_to) || undefined,
        headers: email.headers,
        threadId: extra.threadId,
        inReplyTo: extra.inReplyTo,
      });
      finish('sent', { gmail_id: res.id, thread_id: res.threadId, subject: email.subject, sent_at: nowIso(), error: null, dry_run: !!res.dryRun }, { 'stats.sent': 1 });
      bumpDaily('sent');
      Automations.fire('email_sent', {
        contactId: contact.id,
        campaignId: message.campaign_id,
        templateId: message.template_id,
        messageId: message.id,
        fromAutomation: message.automation_id,
      });
      return 'sent';
    } catch (e) {
      return finish('failed', { error: String(e.message || e).slice(0, 500) }, { 'stats.failed': 1 });
    }
  }

  return { buildEmail: buildEmail, templateHtml: templateHtml, createMessage: createMessage, deliver: deliver, getTemplate: getTemplate };
})();
