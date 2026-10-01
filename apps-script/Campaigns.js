/* Campaign queueing and rate-limited sending. */
var Campaigns = (function () {
  /** Subscribed contacts across the campaign's lists (deduplicated). */
  function recipients(campaign) {
    const seen = {};
    const out = [];
    (campaign.list_ids || []).forEach(function (listId) {
      FS.query('contacts', { where: [['list_ids', 'array-contains', String(listId)]] }).forEach(function (c) {
        if (c.status === 'subscribed' && !seen[c.id]) {
          seen[c.id] = true;
          out.push(c);
        }
      });
    });
    return out;
  }

  /** Create queued message docs for every recipient and mark the campaign "sending". */
  function launch(campaign) {
    if (!campaign.template_id) {
      FS.update('campaigns/' + campaign.id, { status: 'draft', error: 'Choose a template first' });
      return 0;
    }
    const already = {};
    FS.query('messages', { where: [['campaign_id', '==', campaign.id]] }).forEach(function (m) {
      already[m.contact_id] = true;
    });
    const ops = [];
    recipients(campaign).forEach(function (contact) {
      if (already[contact.id]) return;
      ops.push(Delivery.createMessage({
        contact: contact, templateId: campaign.template_id, subject: campaign.subject,
        campaignId: campaign.id, campaignName: campaign.name,
      }).op);
    });
    ops.push({
      update: 'campaigns/' + campaign.id,
      data: { status: 'sending', started_at: campaign.started_at || nowIso(), error: null },
      increment: { 'stats.total': ops.length, 'stats.queued': ops.length },
    });
    FS.commit(ops);
    return ops.length - 1;
  }

  /** Start campaigns the user launched or whose schedule is due. */
  function startDue() {
    const now = nowIso();
    const due = FS.query('campaigns', { where: [['status', '==', 'launching']] })
      .concat(FS.query('campaigns', { where: [['status', '==', 'scheduled']] }).filter(function (c) {
        return c.scheduled_at && c.scheduled_at <= now;
      }));
    due.forEach(launch);
    return due.length;
  }

  /** Send queued messages within the per-run and daily limits. */
  function processQueue(hasTime) {
    startDue();
    const perRun = Number(CONFIG.settings().per_run_limit) || 40;
    let budget = Math.min(perRun, Mailer.remainingToday());
    let sent = 0;
    if (budget > 0) {
      const sending = {};
      FS.query('campaigns', { where: [['status', '==', 'sending']] }).forEach(function (c) { sending[c.id] = true; });
      const queued = FS.query('messages', { where: [['status', '==', 'queued']], orderBy: [['created_at', 'asc']], limit: budget * 2 });
      for (let i = 0; i < queued.length && budget > 0 && hasTime(); i++) {
        const m = queued[i];
        if (m.campaign_id && !sending[m.campaign_id]) continue; // paused campaign
        if (Delivery.deliver(m) === 'sent') sent++;
        budget--;
      }
    }
    // Mark finished campaigns.
    FS.query('campaigns', { where: [['status', '==', 'sending']] }).forEach(function (c) {
      const left = FS.query('messages', { where: [['campaign_id', '==', c.id], ['status', '==', 'queued']], limit: 1 });
      if (!left.length) FS.update('campaigns/' + c.id, { status: 'sent', finished_at: nowIso() });
    });
    return sent;
  }

  return { launch: launch, startDue: startDue, processQueue: processQueue, recipients: recipients };
})();
