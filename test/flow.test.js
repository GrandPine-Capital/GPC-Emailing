const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, startServer } = require('./helpers');
const campaigns = require('../src/lib/campaigns');
const automations = require('../src/lib/automations');
const { inboundKey } = require('../src/routes/engage');

const { db, sent } = setup();
let srv;

test.before(async () => {
  srv = await startServer();
});
test.after(() => srv.close());

const CSV = 'Email,Name,Company,Country,Industry\nalice@acme.com,Alice Lim,Acme,Malaysia,Retail\nbob@beta.com,Bob Tan,Beta,Singapore,Software\nnot-an-email,X,,,\n';

test('CSV import creates contacts in a list', async () => {
  const list = (await srv.call('POST', '/api/lists', { name: 'Customers' })).data;
  const fd = new FormData();
  fd.append('file', new Blob([CSV], { type: 'text/csv' }), 'c.csv');
  fd.append('list_id', String(list.id));
  fd.append('tags', 'expo');
  const res = await fetch(`${srv.base}/api/contacts/import`, { method: 'POST', body: fd });
  const r = await res.json();
  assert.deepEqual([r.created, r.updated, r.skipped], [2, 0, 1]);
  const alice = db.get("SELECT * FROM contacts WHERE email = 'alice@acme.com'");
  assert.equal(alice.first_name, 'Alice');
  assert.equal(alice.last_name, 'Lim');
  assert.equal(alice.country, 'Malaysia');
  assert.deepEqual(JSON.parse(alice.tags), ['expo']);

  const filtered = (await srv.call('GET', '/api/contacts?country=Singapore')).data;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].email, 'bob@beta.com');
});

test('campaign sends personalised, tracked emails and records stats', async () => {
  // Follow-up automation on this campaign: wait 0 min, stop if replied, send follow-up in thread.
  const followUpTpl = db.get("SELECT id FROM templates WHERE name LIKE 'Personal Follow-up%'").id;
  const auto = (await srv.call('POST', '/api/automations', {
    name: 'Follow up',
    trigger_type: 'email_sent',
    trigger_config: { campaign_id: 1, stop_on_reply: true },
    status: 'active',
    steps: [
      { type: 'wait', amount: 1, unit: 'days' },
      { type: 'stop_if', condition: 'replied' },
      { type: 'send_email', template_id: followUpTpl, reply_in_thread: true },
    ],
  })).data;

  const c = (await srv.call('POST', '/api/campaigns', { name: 'Launch', subject: 'Hi {{first_name}}', template_id: 1, list_ids: [1] })).data;
  assert.equal(c.id, 1);
  const launched = await srv.call('POST', `/api/campaigns/${c.id}/send`);
  assert.equal(launched.data.queued, 2);
  await campaigns.processQueue();
  await campaigns.processQueue(); // marks campaign as sent

  const camp = (await srv.call('GET', `/api/campaigns/${c.id}`)).data;
  assert.equal(camp.status, 'sent');
  assert.equal(camp.stats.sent, 2);
  assert.equal(sent.length, 2);
  const toAlice = sent.find((m) => JSON.stringify(m.to).includes('alice@acme.com'));
  assert.equal(toAlice.subject, 'Hi Alice');
  assert.match(toAlice.headers['List-Unsubscribe'], /\/u\//);
  assert.match(toAlice.html, /t\/o\/[a-f0-9]+\.gif/);

  // Both recipients entered the follow-up automation and are waiting.
  await automations.processDue();
  const runs = db.all('SELECT * FROM automation_runs WHERE automation_id = ?', auto.id);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === 'active' && r.next_run_at > db.now()));
});

test('open and click tracking update the message', async () => {
  const m = db.get("SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'bob@beta.com'");
  const open = await srv.call('GET', `/t/o/${m.token}.gif`);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('content-type'), 'image/gif');

  const html = sent.find((x) => JSON.stringify(x.to).includes('bob@beta.com')).html;
  const link = html.match(/href="http:\/\/test\.local(\/t\/c\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  const click = await srv.call('GET', link);
  assert.equal(click.status, 302);
  assert.match(click.headers.get('location'), /^https:\/\/example\.com/);

  const bad = await srv.call('GET', `/t/c/${m.token}?u=${encodeURIComponent('https://evil.com')}&s=0000`);
  assert.equal(bad.status, 400);

  const after = db.get('SELECT * FROM messages WHERE id = ?', m.id);
  assert.equal(after.open_count, 1);
  assert.equal(after.click_count, 1);
  const stats = campaigns.stats(1);
  assert.equal(stats.opened, 1);
  assert.equal(stats.clicked, 1);
});

test('reply via inbound webhook is matched, stops the follow-up and fires reply automations', async () => {
  const tagAuto = (await srv.call('POST', '/api/automations', {
    name: 'Hot lead', trigger_type: 'reply_received', trigger_config: { keywords: 'pricing, quote' }, status: 'active',
    steps: [{ type: 'add_tag', tag: 'hot-lead' }],
  })).data;
  const m = db.get("SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'alice@acme.com' AND m.campaign_id = 1");

  const res = await srv.call('POST', `/api/inbound/reply?key=${inboundKey()}`, {
    from: 'Alice Lim <ALICE@acme.com>',
    subject: 'Re: Hi Alice',
    text: 'Can you send me your pricing?\n\nOn Tue, Sender wrote:\n> Hi Alice',
    headers: `Message-ID: <reply-1@acme.com>\nIn-Reply-To: ${m.message_id}\n`,
  });
  assert.deepEqual(res.data, { ok: true, matched: true });
  const unauth = await srv.call('POST', '/api/inbound/reply?key=wrong', { from: 'x@y.com' });
  assert.equal(unauth.status, 401);

  const reply = db.get('SELECT * FROM replies');
  assert.equal(reply.message_id, m.id);
  assert.equal(reply.body, 'Can you send me your pricing?');
  assert.ok(db.get('SELECT replied_at FROM messages WHERE id = ?', m.id).replied_at);

  await automations.processDue();
  const aliceId = m.contact_id;
  const followRun = db.get("SELECT r.* FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.name = 'Follow up' AND r.contact_id = ?", aliceId);
  assert.equal(followRun.status, 'stopped');
  const tags = JSON.parse(db.get('SELECT tags FROM contacts WHERE id = ?', aliceId).tags);
  assert.ok(tags.includes('hot-lead'));
  assert.equal(db.get('SELECT COUNT(*) n FROM automation_runs WHERE automation_id = ?', tagAuto.id).n, 1);

  // Duplicate delivery of the same reply is ignored.
  await srv.call('POST', `/api/inbound/reply?key=${inboundKey()}`, { from: 'alice@acme.com', subject: 'Re', text: 'x', message_id: '<reply-1@acme.com>' });
  assert.equal(db.get('SELECT COUNT(*) n FROM replies').n, 1);
});

test('follow-up is sent in-thread to non-responders once the wait is over', async () => {
  // Fast-forward: make the waiting runs due now.
  db.run("UPDATE automation_runs SET next_run_at = '2000-01-01 00:00:00' WHERE status = 'active'");
  const before = sent.length;
  await automations.processDue();
  const followUps = sent.slice(before);
  assert.equal(followUps.length, 1, 'only Bob (no reply) gets the follow-up');
  assert.match(JSON.stringify(followUps[0].to), /bob@beta\.com/);
  assert.equal(followUps[0].subject, 'Re: Hi Bob');
  const original = db.get("SELECT m.message_id FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'bob@beta.com' AND m.campaign_id = 1");
  assert.equal(followUps[0].inReplyTo, original.message_id);
  const run = db.get("SELECT r.* FROM automation_runs r JOIN contacts c ON c.id = r.contact_id JOIN automations a ON a.id = r.automation_id WHERE c.email = 'bob@beta.com' AND a.name = 'Follow up'");
  assert.equal(run.status, 'completed');
});

test('unsubscribe link opts the contact out and later campaigns skip them', async () => {
  const m = db.get("SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'bob@beta.com' AND m.campaign_id = 1");
  const page = await srv.call('GET', `/u/${m.token}`);
  assert.match(page.data, /Unsubscribe me/);
  await srv.call('POST', `/u/${m.token}`);
  assert.equal(db.get('SELECT status FROM contacts WHERE id = ?', m.contact_id).status, 'unsubscribed');

  const c2 = (await srv.call('POST', '/api/campaigns', { name: 'Second', subject: 'Again', template_id: 2, list_ids: [1] })).data;
  const r = await srv.call('POST', `/api/campaigns/${c2.id}/send`);
  assert.equal(r.data.queued, 1);
});

test('scheduled campaigns launch when due', async () => {
  const c = (await srv.call('POST', '/api/campaigns', { name: 'Later', subject: 'S', template_id: 2, list_ids: [1] })).data;
  const past = new Date(Date.now() - 60e3).toISOString();
  const r = await srv.call('POST', `/api/campaigns/${c.id}/schedule`, { scheduled_at: past });
  assert.equal(r.data.status, 'scheduled');
  await campaigns.processQueue();
  assert.notEqual(db.get('SELECT status FROM campaigns WHERE id = ?', c.id).status, 'scheduled');
});

test('template CRUD with drag & drop design renders HTML on save', async () => {
  const t = (await srv.call('POST', '/api/templates', {
    name: 'DnD', mode: 'dragdrop', subject: 'S',
    design: { settings: {}, blocks: [{ type: 'button', props: { text: 'Buy now', href: 'https://shop.test' } }] },
  })).data;
  assert.match(t.html, /Buy now/);
  const h = (await srv.call('POST', '/api/templates', { name: 'Code', mode: 'html', html: '<p>{{first_name}}</p>' })).data;
  assert.equal(h.html, '<p>{{first_name}}</p>');
  const preview = (await srv.call('POST', '/api/templates/render', { mode: 'html', html: '<p>Hi {{first_name}}</p>' })).data;
  assert.match(preview.preview, /Hi Alex/);
  const test2 = await srv.call('POST', `/api/templates/${t.id}/test`, { email: 'qa@acme.test' });
  assert.equal(test2.data.ok, true);
});
