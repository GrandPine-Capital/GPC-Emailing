/*
 * Entry points:
 *   setup()   run once from the Apps Script editor (creates admin, settings,
 *             standard templates, example automations and the 5-minute trigger)
 *   tick()    background worker, runs every 5 minutes
 *   doGet()   public web app: open pixel, unsubscribe link fallback, health check
 *   doPost()  public web app: one-click unsubscribe + authenticated admin actions
 */

// ------------------------------------------------------------------ worker
function tick(maxMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { skipped: 'busy' };
  const hasTime = deadline(typeof maxMs === 'number' ? maxMs : 4.5 * 60e3);
  const summary = {};
  try {
    CONFIG.reset();
    Automations.reset();
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
    fromName: campaign && campaign.from_name, replyTo: campaign && campaign.reply_to, force: true,
  });
  return { ok: true, dryRun: r.dryRun };
}

// ------------------------------------------------------------------ web app
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
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
  const p = (e && e.parameter) || {};
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
    const admin = verifyAdmin(body.idToken);
    switch (body.action) {
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
  if (!FS.get('admins/' + email)) throw new Error(email + ' is not an admin');
  return email;
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
function setup() {
  const owner = String(CONFIG.senderEmail()).toLowerCase();
  if (!FS.get('admins/' + owner)) FS.set('admins/' + owner, { email: owner, created_at: nowIso() });

  const current = FS.get('settings/app') || {};
  const defaults = Object.assign({}, CONFIG.DEFAULT_SETTINGS, { site_url: 'https://' + CONFIG.projectId() + '.web.app' });
  const patch = {};
  Object.keys(defaults).forEach(function (k) {
    if (current[k] === undefined) patch[k] = defaults[k];
  });
  let webAppUrl = ScriptApp.getService().getUrl() || '';
  // Only the public deployment URL (…/exec) works for recipients; /dev requires sign-in.
  if (!/\/exec$/.test(webAppUrl)) webAppUrl = '';
  if (webAppUrl) patch.tracking_url = webAppUrl;
  if (Object.keys(patch).length) FS.set('settings/app', patch, { merge: true });
  if (!FS.get('settings/secrets')) FS.set('settings/secrets', { hunter_api_key: '', apollo_api_key: '', google_cse_key: '', google_cse_cx: '' });
  if (!FS.get('meta/facets')) FS.set('meta/facets', { countries: [], industries: [], tags: [] });
  CONFIG.reset();

  const seeded = seedContent();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  CONFIG.secret();

  const msg = 'Setup complete.\nAdmin: ' + owner + '\nWeb app URL: ' + (webAppUrl || current.tracking_url || '(not detected - deploy the web app, then paste its …/exec URL into dashboard Settings or run setup() again)') +
    '\nSeeded: ' + seeded.templates + ' templates, ' + seeded.automations + ' automations\nWorker trigger: every 5 minutes';
  console.log(msg);
  return msg;
}

/** Add another admin who may sign in to the dashboard. */
function addAdmin(email) {
  email = String(email || '').trim().toLowerCase();
  if (!EmailCore.isEmail(email)) throw new Error('Pass an email address');
  FS.set('admins/' + email, { email: email, created_at: nowIso() });
  return email;
}
