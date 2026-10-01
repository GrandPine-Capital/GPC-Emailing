const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas } = require('./harness');

const SITE = 'https://emailing-portal.web.app';
const now = () => new Date().toISOString();

function contact(store, email, extra = {}) {
  store.put(`contacts/${email}`, {
    email, first_name: '', last_name: '', company: '', website: '', phone: '', country: '', industry: '',
    tags: [], list_ids: [], status: 'subscribed', source: 'test', created_at: now(), ...extra,
  });
}

function templateId(store, name) {
  return store.collection('templates').find((t) => t.name.startsWith(name)).id;
}
function automationId(store, name) {
  return store.collection('automations').find((a) => a.name === name).id;
}

test('setup() creates admin, settings, standard templates, example automations and the trigger', () => {
  const { gas, store, triggers, OWNER, WEBAPP } = createGas();
  const msg = gas.setup();
  assert.match(msg, /Setup complete/);
  assert.ok(store.doc(`admins/${OWNER}`));
  const s = store.doc('settings/app');
  assert.equal(s.tracking_url, WEBAPP);
  assert.equal(s.site_url, SITE);
  assert.equal(store.collection('templates').length, 6);
  assert.ok(store.collection('templates').every((t) => t.html.length > 100));
  assert.equal(store.collection('automations').length, 4);
  assert.ok(store.collection('automations').every((a) => a.status === 'paused'));
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].fn, 'tick');
  // Re-running is safe.
  gas.setup();
  assert.equal(store.collection('templates').length, 6);
  assert.equal(triggers.length, 1);
});

test('end-to-end: campaign send, open, click, reply, follow-up and unsubscribe', () => {
  const { gas, store, sent, receive } = createGas();
  gas.setup();
  store.put('lists/L1', { name: 'Customers', created_at: now() });
  contact(store, 'alice@acme.com', { first_name: 'Alice', company: 'Acme', list_ids: ['L1'] });
  contact(store, 'bob@beta.com', { first_name: 'Bob', list_ids: ['L1'] });
  contact(store, 'gone@x.com', { list_ids: ['L1'], status: 'unsubscribed' });

  const followUp = automationId(store, 'Follow up if no reply after 3 days');
  const hot = automationId(store, 'Hot lead: interested reply');
  store.put(`automations/${followUp}`, { ...store.doc(`automations/${followUp}`), status: 'active', trigger_config: { campaign_id: 'C1', stop_on_reply: true } });
  store.put(`automations/${hot}`, { ...store.doc(`automations/${hot}`), status: 'active' });

  store.put('campaigns/C1', {
    name: 'Launch', subject: 'Hi {{first_name}}', template_id: templateId(store, 'Monthly Newsletter'),
    list_ids: ['L1'], status: 'launching', stats: {}, created_at: now(),
  });

  // --- send
  gas.tick();
  const c1 = store.doc('campaigns/C1');
  assert.equal(c1.status, 'sent');
  assert.deepEqual([c1.stats.total, c1.stats.sent, c1.stats.queued], [2, 2, 0]);
  assert.equal(sent.length, 2);
  const toAlice = sent.find((m) => m.to.includes('alice@acme.com'));
  assert.equal(toAlice.subject, 'Hi Alice');
  assert.match(toAlice.to, /"Alice" <alice@acme\.com>/);
  assert.match(toAlice.headers['list-unsubscribe'], /^<mailto:owner@gmail\.test\?subject=unsubscribe%20[a-f0-9]{24}>, <https:\/\/script\.google\.com\/macros\/s\/TEST\/exec\?a=u1&t=[a-f0-9]{24}>$/);
  assert.equal(toAlice.headers['list-unsubscribe-post'], 'List-Unsubscribe=One-Click');
  assert.match(toAlice.html, /Hi Alice,/);
  assert.match(toAlice.html, /\/exec\?a=o&amp;t=[a-f0-9]{24}/);
  assert.match(toAlice.text, /Unsubscribe: https:\/\/emailing-portal\.web\.app\/u\.html\?t=/);
  const link = toAlice.html.match(/href="https:\/\/emailing-portal\.web\.app\/r\.html\?t=([a-f0-9]{24})&amp;k=([a-f0-9]{24})"/);
  assert.ok(link, 'links are rewritten to the Hosting redirect page');
  assert.ok(store.doc(`links/${link[2]}`).url.startsWith('https://'));
  const aliceMsg = store.doc(`messages/${link[1]}`);
  assert.equal(aliceMsg.status, 'sent');
  assert.equal(aliceMsg.thread_id, sent.find((m) => m.to.includes('alice')).threadId);
  assert.equal(store.doc(`stats/daily-${now().slice(0, 10)}`).sent, 2);
  // Both recipients entered the follow-up sequence (waiting 3 days).
  const runs = store.collection('runs').filter((r) => r.automation_id === followUp);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === 'active' && r.next_run_at > now()));

  // --- open (pixel hits the web app)
  const out = gas.doGet({ parameter: { a: 'o', t: aliceMsg.id } });
  assert.equal(out.content, '');
  assert.equal(store.doc(`messages/${aliceMsg.id}`).open_count, 1);
  assert.equal(store.doc('campaigns/C1').stats.opened, 1);

  // --- click (written by r.html, processed by the worker)
  store.put('clicks/x1', { token: aliceMsg.id, k: link[2], created_at: now() });
  store.put('clicks/x2', { token: aliceMsg.id, k: 'bogus', created_at: now() });
  gas.tick();
  assert.equal(store.collection('clicks').length, 0);
  const afterClick = store.doc(`messages/${aliceMsg.id}`);
  assert.equal(afterClick.click_count, 1);
  assert.equal(store.doc('campaigns/C1').stats.clicked, 1);
  assert.equal(store.doc('campaigns/C1').links[link[2]].clicks, 1);

  // --- reply detected in Gmail, matched by thread
  receive({ threadId: aliceMsg.thread_id, from: 'Alice <alice@acme.com>', subject: 'Re: Hi Alice', body: 'Interested - what is your pricing?\n\nOn Mon, Owner wrote:\n> Hi' });
  gas.tick();
  const replies = store.collection('replies');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message_id, aliceMsg.id);
  assert.equal(replies[0].body, 'Interested - what is your pricing?');
  assert.equal(store.doc('campaigns/C1').stats.replied, 1);
  assert.ok(store.doc('contacts/alice@acme.com').tags.includes('hot-lead'));
  const aliceRun = store.collection('runs').find((r) => r.automation_id === followUp && r.contact_id === 'alice@acme.com');
  assert.equal(aliceRun.status, 'stopped', 'stop_on_reply ends the follow-up sequence');
  // Same reply seen again on the next poll is ignored.
  gas.tick();
  assert.equal(store.collection('replies').length, 1);

  // --- follow-up to the non-responder once the wait is over, threaded
  for (const r of store.collection('runs').filter((x) => x.status === 'active')) {
    store.put(`runs/${r.id}`, { ...store.doc(`runs/${r.id}`), next_run_at: '2000-01-01T00:00:00.000Z' });
  }
  const before = sent.length;
  gas.tick();
  const follow = sent.slice(before);
  assert.equal(follow.length, 1);
  assert.match(follow[0].to, /bob@beta\.com/);
  assert.equal(follow[0].subject, 'Re: Hi Bob');
  const bobMsg = store.collection('messages').find((m) => m.email === 'bob@beta.com' && m.campaign_id === 'C1');
  assert.equal(follow[0].threadId, bobMsg.thread_id);
  assert.equal(follow[0].headers['in-reply-to'], `<${bobMsg.gmail_id}@mail.gmail.com>`);

  // --- unsubscribe via the Hosting page (u.html writes unsubscribes/*)
  store.put('unsubscribes/u1', { token: bobMsg.id, created_at: now() });
  gas.tick();
  assert.equal(store.doc('contacts/bob@beta.com').status, 'unsubscribed');
  assert.equal(store.doc('campaigns/C1').stats.unsubscribed, 1);
  assert.ok(store.collection('runs').filter((r) => r.contact_id === 'bob@beta.com').every((r) => r.status !== 'active'));

  // --- one-click unsubscribe (List-Unsubscribe-Post) and mailto unsubscribe
  contact(store, 'carol@c.com', { list_ids: ['L1'] });
  contact(store, 'dave@d.com', { list_ids: ['L1'] });
  store.put('campaigns/C2', { name: 'Two', subject: 'S', template_id: templateId(store, 'Welcome'), list_ids: ['L1'], status: 'launching', stats: {}, created_at: now() });
  gas.tick();
  const carol = store.collection('messages').find((m) => m.email === 'carol@c.com');
  const dave = store.collection('messages').find((m) => m.email === 'dave@d.com');
  gas.doPost({ parameter: { a: 'u1', t: carol.id }, postData: { contents: 'List-Unsubscribe=One-Click' } });
  assert.equal(store.doc('contacts/carol@c.com').status, 'unsubscribed');
  receive({ from: 'dave@d.com', subject: `unsubscribe ${dave.id}`, body: '' });
  gas.tick();
  assert.equal(store.doc('contacts/dave@d.com').status, 'unsubscribed');
  assert.equal(store.collection('replies').length, 1, 'unsubscribe requests are not stored as replies');
});

test('bounces mark the contact as bounced', () => {
  const { gas, store, receive } = createGas();
  gas.setup();
  contact(store, 'nobody@acme.com');
  receive({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', body: "Address not found\nYour message wasn't delivered to nobody@acme.com because the address couldn't be found." });
  gas.tick();
  assert.equal(store.doc('contacts/nobody@acme.com').status, 'bounced');
});

test('daily limit and dry-run mode are respected', () => {
  const { gas, store, sent } = createGas();
  gas.setup();
  store.put('settings/app', { ...store.doc('settings/app'), daily_limit: 1 });
  store.put('lists/L', { name: 'L' });
  ['a@a.com', 'b@b.com', 'c@c.com'].forEach((e) => contact(store, e, { list_ids: ['L'] }));
  store.put('campaigns/C', { name: 'C', subject: 'S', template_id: templateId(store, 'Welcome'), list_ids: ['L'], status: 'launching', stats: {}, created_at: now() });
  gas.tick();
  assert.equal(sent.length, 1);
  assert.equal(store.doc('campaigns/C').status, 'sending');
  assert.equal(store.doc('campaigns/C').stats.queued, 2);

  store.put('settings/app', { ...store.doc('settings/app'), daily_limit: 100, dry_run: true });
  gas.tick();
  assert.equal(sent.length, 1, 'dry run does not call Gmail');
  assert.equal(store.doc('campaigns/C').status, 'sent');
  assert.ok(store.collection('messages').filter((m) => m.dry_run).length === 2);
});

test('scheduled campaigns and paused campaigns', () => {
  const { gas, store, sent } = createGas();
  gas.setup();
  store.put('lists/L', { name: 'L' });
  contact(store, 'a@a.com', { list_ids: ['L'] });
  const tpl = templateId(store, 'Welcome');
  store.put('campaigns/Future', { name: 'F', subject: 'S', template_id: tpl, list_ids: ['L'], status: 'scheduled', scheduled_at: '2999-01-01T00:00:00.000Z', stats: {}, created_at: now() });
  store.put('campaigns/Due', { name: 'D', subject: 'S', template_id: tpl, list_ids: ['L'], status: 'scheduled', scheduled_at: '2000-01-01T00:00:00.000Z', stats: {}, created_at: now() });
  gas.tick();
  assert.equal(store.doc('campaigns/Future').status, 'scheduled');
  assert.equal(store.doc('campaigns/Due').status, 'sent');
  assert.equal(sent.length, 1);
});

test('jobs: contact_added fires welcome automation, enroll, test email, manual reply log', () => {
  const { gas, store, sent } = createGas();
  gas.setup();
  const welcome = automationId(store, 'Welcome new subscribers');
  store.put(`automations/${welcome}`, { ...store.doc(`automations/${welcome}`), status: 'active' });
  contact(store, 'new@n.com', { first_name: 'Nia', list_ids: ['L'] });
  store.put('jobs/j1', { type: 'contacts_added', payload: { items: [{ contact_id: 'new@n.com', list_id: 'L' }] }, status: 'pending', created_at: now() });
  store.put('jobs/j2', { type: 'test_email', payload: { template_id: templateId(store, 'Promotion'), email: 'qa@acme.test' }, status: 'pending', created_at: now() });
  store.put('jobs/j3', { type: 'log_reply', payload: { from: 'new@n.com', subject: 'Phone call', text: 'Called us' }, status: 'pending', created_at: now() });
  store.put('jobs/j4', { type: 'log_reply', payload: { from: 'unknown@z.com', subject: 'x', text: 'y' }, status: 'pending', created_at: now() });
  gas.tick();
  assert.equal(store.doc('jobs/j1').status, 'done');
  assert.ok(sent.some((m) => m.to.includes('new@n.com') && /Welcome aboard, Nia!/.test(m.subject)));
  assert.ok(sent.some((m) => m.to === 'qa@acme.test' && m.subject.startsWith('[TEST]')));
  assert.equal(store.doc('jobs/j3').status, 'done');
  assert.equal(store.doc('jobs/j4').status, 'failed');

  const hot = automationId(store, 'Hot lead: interested reply');
  store.put('lists/M', { name: 'M' });
  contact(store, 'm1@m.com', { list_ids: ['M'] });
  contact(store, 'm2@m.com', { list_ids: ['M'], status: 'unsubscribed' });
  store.put('jobs/j5', { type: 'enroll', payload: { automation_id: hot, list_id: 'M' }, status: 'pending', created_at: now() });
  gas.tick();
  assert.deepEqual(store.doc('jobs/j5').result, { enrolled: 1 });
});

test('web app: admin actions require a valid admin ID token', () => {
  const { gas, store, sent, files } = createGas();
  gas.setup();
  const call = (body) => JSON.parse(gas.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).content);
  assert.equal(call({ action: 'status' }).ok, false);
  assert.match(call({ action: 'status', idToken: 'stranger-token' }).error, /not an admin/);
  assert.match(call({ action: 'status', idToken: 'forged' }).error, /Invalid or expired/);
  const st = call({ action: 'status', idToken: 'admin-token' });
  assert.equal(st.ok, true);
  assert.equal(st.account, 'owner@gmail.test');
  const t = call({ action: 'test_email', idToken: 'admin-token', template_id: templateId(store, 'Welcome'), email: 'me@x.com' });
  assert.equal(t.ok, true);
  assert.equal(sent.length, 1);
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const up = call({ action: 'upload', idToken: 'admin-token', mimeType: 'image/png', name: 'a.png', data: png });
  assert.equal(up.url, 'https://lh3.googleusercontent.com/d/file0');
  assert.equal(files.length, 1);
  assert.match(call({ action: 'upload', idToken: 'admin-token', mimeType: 'text/html', data: '' }).error, /Upload a PNG/);
  assert.ok(call({ action: 'kick', idToken: 'admin-token' }).summary);
});

test('lead finder: search by country + industry, crawl sites politely, store leads', () => {
  const cf = (email, key = 0x42) => key.toString(16).padStart(2, '0') + [...email].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const pages = {
    'https://acmerealty.test/robots.txt': 'User-agent: *\nDisallow: /private\n',
    'https://acmerealty.test': '<html><head><title>Acme Realty | Homes in KL</title></head><body><a href="/hubungi-kami">Hubungi</a> <a href="/private/staff">Staff contact</a></body></html>',
    'https://acmerealty.test/hubungi-kami': `<a href="mailto:Sales@AcmeRealty.test?subject=Hi">Email</a> support [at] acmerealty [dot] test <span data-cfemail="${cf('ceo@acmerealty.test')}"></span> noreply@acmerealty.test logo@2x.png`,
    'https://acmerealty.test/private/staff': 'secret@acmerealty.test',
    'https://beta-homes.test': '<title>Beta Homes</title><p>Write to hello&#64;beta-homes.test</p>',
  };
  let ddgQuery = null;
  const web = (url, opts) => {
    if (url === 'https://html.duckduckgo.com/html/') {
      ddgQuery = opts.payload;
      return {
        body: `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://acmerealty.test/about')}&amp;rut=x">Acme</a>
               <a class="result__a" href="https://www.facebook.com/acme">FB</a>
               <a class="result__a" href="https://beta-homes.test/listing">Beta</a>`,
      };
    }
    const key = url.replace(/\/+$/, '');
    return pages[key] !== undefined ? { body: pages[key] } : null;
  };
  const { gas, store } = createGas({ web });
  gas.setup();
  store.put('leadSearches/S1', {
    params: { countries: ['MY'], industries: ['Real Estate'], sources: ['web'], limit: 10, perSiteMaxEmails: 5, pages: 1 },
    status: 'queued', created_at: now(),
  });
  gas.tick();
  const s = store.doc('leadSearches/S1');
  assert.equal(s.status, 'done', s.error);
  assert.equal(ddgQuery.kl, 'my-en');
  assert.match(ddgQuery.q, /"Real Estate".*Malaysia/);
  const leads = store.collection('leadSearches/S1/leads');
  const emails = leads.map((l) => l.email).sort();
  assert.deepEqual(emails, ['ceo@acmerealty.test', 'hello@beta-homes.test', 'sales@acmerealty.test', 'support@acmerealty.test']);
  assert.ok(leads.every((l) => l.country === 'Malaysia' && l.industry === 'Real Estate'));
  assert.equal(leads.find((l) => l.email === 'sales@acmerealty.test').company, 'Acme Realty');
  assert.equal(s.results_count, 4);
});

test('lead finder respects the result limit and reports provider errors', () => {
  const web = (url) => (url === 'https://html.duckduckgo.com/html/' ? { code: 403, body: 'blocked' } : null);
  const { gas, store } = createGas({ web });
  gas.setup();
  store.put('leadSearches/S2', { params: { countries: ['SG'], industries: ['Retail'], sources: ['web'] }, status: 'queued', created_at: now() });
  gas.tick();
  const s = store.doc('leadSearches/S2');
  assert.equal(s.status, 'done');
  assert.match(s.error, /DuckDuckGo responded 403/);
});

test('Firestore client quotes field paths that start with a digit (link keys are hex)', () => {
  const { gas, store } = createGas();
  store.put('campaigns/C', { stats: {} });
  gas.FS.commit([{ update: 'campaigns/C', data: { 'links.0abc.url': 'https://x.test' }, mustExist: false, increment: { 'links.0abc.clicks': 1, 'stats.clicked': 1 } }]);
  gas.FS.update('campaigns/C', { 'links.1def.url': 'https://y.test' });
  const c = store.doc('campaigns/C');
  assert.deepEqual(c.links, { '0abc': { url: 'https://x.test', clicks: 1 }, '1def': { url: 'https://y.test' } });
  assert.equal(c.stats.clicked, 1);
});
