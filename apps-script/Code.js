/*
 * Entry points:
 *   setup()   run once from the Apps Script editor (creates admin, settings,
 *             standard templates, example automations and the 5-minute trigger)
 *   tick()    background worker, runs every 5 minutes
 *   doGet()   public web app: open pixel, unsubscribe link fallback, health check
 *   doPost()  public web app: one-click unsubscribe + authenticated admin actions
 */

// ------------------------------------------------------------------ worker
/** Per-execution caches (settings, active automations, sender identities). */
function resetCaches() {
  CONFIG.reset();
  Automations.reset();
  Mailer.reset();
  AutoReply.reset();
}

function tick(maxMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { skipped: 'busy' };
  const hasTime = deadline(typeof maxMs === 'number' ? maxMs : 4.5 * 60e3);
  const summary = {};
  try {
    resetCaches();
    autoUpgrade();
    const step = function (name, fn) {
      if (!hasTime()) return;
      try {
        summary[name] = fn();
      } catch (e) {
        summary[name] = 'error: ' + (e.message || e);
        console.error(name, e);
      }
    };
    step('events', function () { return Tracking.processEvents(hasTime); });
    step('jobs', function () { return Jobs.process(hasTime); });
    step('replies', function () { return Replies.poll(hasTime); });
    step('campaigns', function () { return Campaigns.processQueue(hasTime); });
    step('automations', function () { return Automations.processDue(hasTime); });
    step('leads', function () { return Leads.process(hasTime); });
    FS.set('settings/status', {
      last_tick: nowIso(),
      account: CONFIG.senderEmail(),
      remaining_today: Mailer.remainingToday(),
      last_summary: JSON.stringify(summary).slice(0, 1000),
    }, { merge: true });
  } finally {
    lock.releaseLock();
  }
  return summary;
}

// ------------------------------------------------------------------ jobs
var Jobs = (function () {
  function run(job) {
    const p = job.payload || {};
    switch (job.type) {
      case 'test_email':
        return sendTest(p);
      case 'enroll':
        return { enrolled: Automations.enroll(p.automation_id, p.contact_ids, p.list_id) };
      case 'contacts_added':
        // items: [{ contact_id, list_id }] (Firestore cannot store nested arrays)
        (p.items || []).forEach(function (it) { Automations.fire('contact_added', { contactId: it.contact_id, listId: String(it.list_id) }); });
        return { fired: (p.items || []).length };
      case 'tags_added':
        // items: [{ contact_id, tag }]
        (p.items || []).forEach(function (it) { Automations.fire('tag_added', { contactId: it.contact_id, tag: String(it.tag) }); });
        return { fired: (p.items || []).length };
      case 'log_reply': {
        const r = Replies.record({ from: p.from, subject: p.subject, text: p.text });
        if (!r) throw new Error('No contact found with that email address');
        return { reply: r.id };
      }
      default:
        throw new Error('unknown job ' + job.type);
    }
  }

  function process(hasTime) {
    const jobs = FS.query('jobs', { where: [['status', '==', 'pending']], limit: 50 });
    jobs.sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
    let n = 0;
    for (let i = 0; i < jobs.length && hasTime(); i++) {
      try {
        FS.update('jobs/' + jobs[i].id, { status: 'done', result: run(jobs[i]), finished_at: nowIso() });
      } catch (e) {
        FS.update('jobs/' + jobs[i].id, { status: 'failed', error: String(e.message || e), finished_at: nowIso() });
      }
      n++;
    }
    return n;
  }

  return { process: process, run: run };
})();

/** Send a template (optionally with a campaign's sender settings) to one address, untracked. */
function sendTest(p) {
  if (!EmailCore.isEmail(p.email)) throw new Error('Enter a valid email address');
  const campaign = p.campaign_id ? FS.get('campaigns/' + p.campaign_id) : null;
  const template = FS.get('templates/' + (p.template_id || (campaign && campaign.template_id)));
  if (!template) throw new Error('Choose a template first');
  const contact = FS.get('contacts/' + EmailCore.emailKey(p.email)) || Object.assign({}, EmailCore.SAMPLE_CONTACT, { email: p.email });
  const email = Delivery.buildEmail({
    html: Delivery.templateHtml(template),
    subject: '[TEST] ' + ((campaign && campaign.subject) || template.subject || template.name),
    contact: contact,
    token: 'test',
    track: false,
  });
  const r = Mailer.send({
    to: p.email, subject: email.subject, html: email.html, text: email.text,
    fromName: campaign && campaign.from_name, fromEmail: (campaign && campaign.from_email) || p.from_email,
    replyTo: campaign && campaign.reply_to, force: true,
  });
  return { ok: true, dryRun: r.dryRun };
}

// ------------------------------------------------------------------ web app
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  resetCaches();
  const p = (e && e.parameter) || {};
  try {
    if (p.a === 'o') {
      Tracking.open(p.t);
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }
    if (p.a === 'u1') {
      const url = CONFIG.siteUrl() + '/u.html?t=' + encodeURIComponent(p.t || '');
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">To unsubscribe, <a href="' + url + '" target="_top">click here</a>.</p>');
    }
  } catch (err) {
    console.error(err);
  }
  return json({ ok: true, service: 'emailing-worker' });
}

function doPost(e) {
  resetCaches();
  const p = (e && e.parameter) || {};
  // Inbound webhooks (ChatDaddy, forms, Zapier…), authenticated by the webhook secret.
  if (p.a === 'hook') {
    try {
      return json(Inbound.handle(p, e && e.postData ? e.postData.contents : ''));
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) });
    }
  }
  // RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) from mailbox providers.
  if (p.a === 'u1') {
    Tracking.unsubscribe(p.t);
    return ContentService.createTextOutput('unsubscribed');
  }
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'Invalid JSON' });
  }
  try {
    const user = verifyAdmin(body.idToken);
    const admin = user.email;
    const requireAdmin = function () {
      if (user.role === 'member') throw new Error('Only admins can do this');
    };
    switch (body.action) {
      case 'senders':
        requireAdmin();
        return json({ ok: true, senders: Integrations.refreshSenders() });
      case 'test_whatsapp':
        requireAdmin();
        Integrations.sendWhatsApp(body.phone, { provider: body.provider, text: body.text || 'Test message from your Emailing Portal ✅' });
        return json({ ok: true });
      case 'kick':
        return json({ ok: true, summary: tick(Math.min(Number(body.maxMs) || 60e3, 4.5 * 60e3)) });
      case 'test_email':
        return json(sendTest(body));
      case 'upload':
        return json({ ok: true, url: upload(body) });
      case 'status':
        return json({
          ok: true, admin: admin, account: CONFIG.senderEmail(), remaining_today: Mailer.remainingToday(),
          tracking_url: CONFIG.trackingUrl(), site_url: CONFIG.siteUrl(),
        });
      default:
        return json({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

/** Verify a Firebase Auth ID token and check the user is listed in admins/. */
function verifyAdmin(idToken) {
  if (!idToken) throw new Error('Not signed in');
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(CONFIG.apiKey()), {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true,
  });
  const user = res.getResponseCode() === 200 ? (JSON.parse(res.getContentText()).users || [])[0] : null;
  if (!user || !user.email) throw new Error('Invalid or expired sign-in, please reload the page');
  const email = String(user.email).toLowerCase();
  const member = FS.get('admins/' + email);
  if (!member) throw new Error(email + ' is not a user of this portal');
  return { email: email, role: member.role || 'owner' };
}

/** Store an uploaded image in Drive and return a public URL usable in emails. */
function upload(body) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(body.mimeType || '')) throw new Error('Upload a PNG, JPG, GIF or WebP image');
  const bytes = Utilities.base64Decode(body.data || '');
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Image is larger than 5 MB');
  const folders = DriveApp.getFoldersByName('Emailing uploads');
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('Emailing uploads');
  const file = folder.createFile(Utilities.newBlob(bytes, body.mimeType, body.name || 'image'));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

// ------------------------------------------------------------------ setup
/**
 * Run once after deploying the web app (Deploy > New deployment > Web app,
 * Execute as: Me, Who has access: Anyone). Safe to re-run.
 */
/**
 * Idempotent part of setup(): owner role, default settings, webhook secret,
 * sender identities and seed content. Safe to run any number of times.
 */
function upgrade() {
  const owner = String(CONFIG.senderEmail()).toLowerCase();
  const existing = FS.get('admins/' + owner);
  if (!existing) FS.set('admins/' + owner, { email: owner, role: 'owner', name: '', created_at: nowIso() });
  else if (!existing.role) FS.update('admins/' + owner, { role: 'owner' });

  const current = FS.get('settings/app') || {};
  const defaults = Object.assign({}, CONFIG.DEFAULT_SETTINGS, { site_url: 'https://' + CONFIG.projectId() + '.web.app' });
  const patch = {};
  Object.keys(defaults).forEach(function (k) {
    if (current[k] === undefined) patch[k] = defaults[k];
  });
  let webAppUrl = '';
  try {
    webAppUrl = ScriptApp.getService().getUrl() || '';
  } catch (e) {
    console.warn('Could not read the web app URL: ' + e.message);
  }
  // Only the public deployment URL (…/exec) works for recipients; /dev requires sign-in.
  if (!/\/exec$/.test(webAppUrl)) webAppUrl = '';
  if (webAppUrl && webAppUrl !== current.tracking_url) patch.tracking_url = webAppUrl;
  if (Object.keys(patch).length) FS.set('settings/app', patch, { merge: true });
  if (!FS.get('settings/secrets')) FS.set('settings/secrets', { hunter_api_key: '', apollo_api_key: '', google_cse_key: '', google_cse_cx: '' });
  if (!(FS.get('settings/secrets') || {}).webhook_secret) FS.set('settings/secrets', { webhook_secret: newToken() + newToken() }, { merge: true });
  try {
    Integrations.refreshSenders();
  } catch (e) {
    console.warn('Could not read Gmail sender identities: ' + e.message);
  }
  if (!FS.get('meta/facets')) FS.set('meta/facets', { countries: [], industries: [], tags: [] });
  CONFIG.reset();

  const seeded = seedContent();
  PropertiesService.getScriptProperties().setProperty('build_id', BUILD_ID);
  FS.set('settings/status', { build_id: BUILD_ID, upgraded_at: nowIso() }, { merge: true });
  return { owner: owner, webAppUrl: webAppUrl || current.tracking_url || '', seeded: seeded };
}

/** Runs upgrade() once after each automatic deployment (new BUILD_ID), so nobody has to re-run setup(). */
function autoUpgrade() {
  if (PropertiesService.getScriptProperties().getProperty('build_id') === BUILD_ID) return false;
  try {
    upgrade();
    console.log('Upgraded worker to build ' + BUILD_ID);
  } catch (e) {
    console.error('Automatic upgrade failed', e);
  }
  return true;
}

function setup() {
  const r = upgrade();
  const owner = r.owner;
  const webAppUrl = r.webAppUrl;
  const seeded = r.seeded;

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  CONFIG.secret();

  const msg = 'Setup complete.\nAdmin: ' + owner + '\nWeb app URL: ' + (webAppUrl || '(not detected - deploy the web app, then paste its …/exec URL into dashboard Settings or run setup() again)') +
    '\nSeeded: ' + seeded.templates + ' templates, ' + seeded.automations + ' automations\nWorker trigger: every 5 minutes';
  console.log(msg);
  return msg;
}

/** Add another admin who may sign in to the dashboard. */
function addAdmin(email, role) {
  email = String(email || '').trim().toLowerCase();
  if (!EmailCore.isEmail(email)) throw new Error('Pass an email address');
  FS.set('admins/' + email, { email: email, role: role === 'member' ? 'member' : 'admin', name: '', created_at: nowIso() });
  return email;
}
