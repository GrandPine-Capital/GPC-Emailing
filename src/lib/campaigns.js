const db = require('../db');
const { createMessage, deliver } = require('./delivery');

function recipients(campaign) {
  const listIds = db.json(campaign.list_ids, []).map(Number).filter(Boolean);
  if (!listIds.length) return [];
  return db.all(
    `SELECT DISTINCT c.id FROM contacts c JOIN list_contacts lc ON lc.contact_id = c.id
     WHERE lc.list_id IN (${listIds.map(() => '?').join(',')}) AND c.status = 'subscribed'`,
    ...listIds,
  );
}

/** Queue one message per subscribed recipient and mark the campaign as sending. */
function launch(campaignId) {
  const campaign = db.get('SELECT * FROM campaigns WHERE id = ?', campaignId);
  if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  if (!campaign.template_id) throw Object.assign(new Error('Choose a template first'), { status: 400 });
  if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
    throw Object.assign(new Error(`Campaign is already ${campaign.status}`), { status: 400 });
  }
  return db.transaction(() => {
    let queued = 0;
    for (const { id } of recipients(campaign)) {
      if (db.get('SELECT id FROM messages WHERE campaign_id = ? AND contact_id = ?', campaignId, id)) continue;
      createMessage({ contactId: id, templateId: campaign.template_id, subject: campaign.subject, campaignId });
      queued++;
    }
    db.run("UPDATE campaigns SET status = 'sending', started_at = COALESCE(started_at, ?) WHERE id = ?", db.now(), campaignId);
    return { queued };
  });
}

function sentInLastMinute() {
  return db.get("SELECT COUNT(*) n FROM messages WHERE sent_at >= ?", db.now(new Date(Date.now() - 60e3))).n;
}

/** Called by the scheduler: start due scheduled campaigns and send queued mail within the rate limit. */
async function processQueue() {
  for (const c of db.all("SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?", db.now())) {
    try {
      launch(c.id);
    } catch (err) {
      console.error(`[campaigns] launch ${c.id} failed:`, err.message);
    }
  }

  const rate = Math.max(1, Number(db.getSetting('send_rate_per_minute')) || 60);
  let budget = rate - sentInLastMinute();
  let sent = 0;
  if (budget > 0) {
    const queued = db.all(
      `SELECT m.* FROM messages m JOIN campaigns c ON c.id = m.campaign_id
       WHERE m.status = 'queued' AND c.status = 'sending' ORDER BY m.id LIMIT ?`,
      budget,
    );
    for (const m of queued) {
      // Re-check in case the campaign was paused mid-batch.
      if (db.get('SELECT status FROM campaigns WHERE id = ?', m.campaign_id).status !== 'sending') continue;
      if ((await deliver(m)) === 'sent') sent++;
      budget--;
    }
  }

  for (const c of db.all("SELECT id FROM campaigns WHERE status = 'sending'")) {
    const left = db.get("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND status = 'queued'", c.id).n;
    if (!left) db.run("UPDATE campaigns SET status = 'sent', finished_at = ? WHERE id = ?", db.now(), c.id);
  }
  return { sent };
}

function stats(campaignId) {
  const s = db.get(
    `SELECT COUNT(*) total,
      SUM(status = 'queued') queued, SUM(status = 'sent') sent, SUM(status = 'failed') failed, SUM(status = 'skipped') skipped,
      SUM(opened_at IS NOT NULL) opened, SUM(clicked_at IS NOT NULL) clicked, SUM(replied_at IS NOT NULL) replied
     FROM messages WHERE campaign_id = ?`,
    campaignId,
  );
  for (const k of Object.keys(s)) s[k] = Number(s[k] || 0);
  s.unsubscribed = db.get(
    "SELECT COUNT(*) n FROM events e JOIN messages m ON m.id = e.message_id WHERE e.type = 'unsubscribe' AND m.campaign_id = ?",
    campaignId,
  ).n;
  const pct = (n) => (s.sent ? Math.round((n / s.sent) * 1000) / 10 : 0);
  s.open_rate = pct(s.opened);
  s.click_rate = pct(s.clicked);
  s.reply_rate = pct(s.replied);
  return s;
}

module.exports = { launch, processQueue, recipients, stats };
