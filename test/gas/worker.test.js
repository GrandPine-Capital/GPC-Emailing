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

test('tick() runs upgrade() once after a new build is deployed, without re-running setup()', () => {
  const { gas, store, props, triggers, OWNER } = createGas();
  gas.setup();
  store.put(`admins/${OWNER}`, { email: OWNER }); // old install: no role yet
  gas.tick();
  assert.equal(store.doc(`admins/${OWNER}`).role, undefined, 'same build: no upgrade');

  vmSet(gas, 'BUILD_ID', 'abc123');
  gas.tick();
  assert.equal(store.doc(`admins/${OWNER}`).role, 'owner');
  assert.equal(props.get('build_id'), 'abc123');
  assert.equal(store.doc('settings/status').build_id, 'abc123');
  assert.equal(store.collection('templates').length, 6);
  assert.equal(triggers.length, 1);

  store.put(`admins/${OWNER}`, { email: OWNER });
  gas.tick();
  assert.equal(store.doc(`admins/${OWNER}`).role, undefined, 'upgrade runs only once per build');
});

function vmSet(gas, name, value) {
  require('node:vm').runInContext(`${name} = ${JSON.stringify(value)}`, gas);
}

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
  assert.match(call({ action: 'status', idToken: 'stranger-token' }).error, /not a user of this portal/);
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

// ------------------------------------------------------------------ v3 features
function webRecorder() {
  const calls = [];
  const web = (url, opts) => {
    if (url.startsWith('https://api.chatdaddy.tech/') || url.startsWith('https://graph.facebook.com/')) {
      calls.push({ url, method: opts.method, headers: opts.headers || {}, body: opts.payload ? JSON.parse(opts.payload) : null });
      return { code: 200, body: '{"ok":true}', headers: { 'Content-Type': 'application/json' } };
    }
    return null;
  };
  return { calls, web };
}

test('sender identities: send from a verified Gmail alias, reject unverified ones', () => {
  const { gas, store, sent } = createGas();
  gas.setup();
  assert.deepEqual(store.doc('settings/senders').list.map((s) => [s.email, s.verified]),
    [['owner@gmail.test', true], ['sales@acme.test', true], ['pending@acme.test', false]]);
  store.put('lists/L', { name: 'L' });
  contact(store, 'a@a.com', { list_ids: ['L'] });
  const tpl = templateId(store, 'Welcome');
  store.put('campaigns/C1', { name: 'C1', subject: 'S', template_id: tpl, list_ids: ['L'], from_email: 'sales@acme.test', status: 'launching', stats: {}, created_at: now() });
  gas.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.from, '"Acme Sales" <sales@acme.test>');
  contact(store, 'b@b.com', { list_ids: ['M'] });
  store.put('campaigns/C2', { name: 'C2', subject: 'S', template_id: tpl, list_ids: ['M'], from_email: 'pending@acme.test', status: 'launching', stats: {}, created_at: now() });
  gas.tick();
  const failed = store.collection('messages').find((m) => m.campaign_id === 'C2');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /not a verified "Send mail as" address/);
  // Default sender from settings applies when the campaign has none.
  store.put('settings/app', { ...store.doc('settings/app'), default_from_email: 'sales@acme.test', from_name: 'Acme' });
  gas.CONFIG.reset(); // each Apps Script execution starts with fresh settings
  const r = gas.sendTest({ template_id: tpl, email: 'qa@x.test' });
  assert.equal(r.ok, true);
  // Alias display name from Gmail wins over the global From name.
  assert.equal(sent[sent.length - 1].headers.from, '"Acme Sales" <sales@acme.test>');
});

test('WhatsApp automation: tag added -> ChatDaddy contact sync -> WhatsApp message (ChatDaddy and Cloud API)', () => {
  const { calls, web } = webRecorder();
  const { gas, store } = createGas({ web });
  gas.setup();
  store.put('settings/app', { ...store.doc('settings/app'), default_country_code: '60' });
  store.put('settings/secrets', { ...store.doc('settings/secrets'), chatdaddy_token: 'cd-token', whatsapp_token: 'meta-token' });
  store.put('settings/app', { ...store.doc('settings/app'), whatsapp_phone_number_id: '1234567890' });
  store.put('automations/WA', {
    name: 'Hot lead WhatsApp', trigger_type: 'tag_added', trigger_config: { tag: 'hot-lead' }, status: 'active', runs: {}, created_at: now(),
    steps: [
      { type: 'chatdaddy_contact', tags: 'email-lead, {{company}}' },
      { type: 'send_whatsapp', provider: 'chatdaddy', text: 'Hi {{first_name|there}}, thanks for your interest!' },
      { type: 'send_whatsapp', provider: 'cloud', template_name: 'follow_up', language: 'en', params: '{{first_name}} | {{company}}' },
      { type: 'stop_if', condition: 'has_tag', tag: 'vip' },
      { type: 'add_tag', tag: 'whatsapped' },
    ],
  });
  contact(store, 'lee@acme.com', { first_name: 'Lee', company: 'Acme', phone: '012-345 6789' });
  store.put('jobs/t1', { type: 'tags_added', payload: { items: [{ contact_id: 'lee@acme.com', tag: 'hot-lead' }] }, status: 'pending', created_at: now() });
  gas.tick();
  const run = store.collection('runs').find((r) => r.automation_id === 'WA');
  assert.equal(run.status, 'completed', JSON.stringify(run.log));
  const [upsert, msg, cloud] = calls;
  assert.equal(upsert.url, 'https://api.chatdaddy.tech/im/contacts/upsert');
  assert.equal(upsert.headers.Authorization, 'Bearer cd-token');
  assert.deepEqual(upsert.body.contacts[0], { phoneNumber: '60123456789', name: 'Lee', tags: [{ name: 'email-lead' }, { name: 'Acme' }], email: 'lee@acme.com' });
  assert.equal(msg.url, 'https://api.chatdaddy.tech/im/messages/random/60123456789');
  assert.deepEqual(msg.body, { text: 'Hi Lee, thanks for your interest!' });
  assert.equal(cloud.url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(cloud.headers.Authorization, 'Bearer meta-token');
  assert.deepEqual(cloud.body.template, { name: 'follow_up', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Lee' }, { type: 'text', text: 'Acme' }] }] });
  assert.ok(store.doc('contacts/lee@acme.com').tags.includes('whatsapped'));
  assert.equal(store.collection('whatsapp').filter((w) => w.direction === 'out').length, 2);
});

test('inbound ChatDaddy webhook: WhatsApp reply creates contact, logs reply, fires automation, stops sequences', () => {
  const { calls, web } = webRecorder();
  const { gas, store } = createGas({ web });
  gas.setup();
  const secret = store.doc('settings/secrets').webhook_secret;
  assert.match(secret, /^[a-f0-9]{48}$/);
  store.put('settings/secrets', { ...store.doc('settings/secrets'), chatdaddy_token: 'cd' });
  store.put('settings/app', { ...store.doc('settings/app'), default_country_code: '60' });
  contact(store, 'amy@x.com', { first_name: 'Amy', phone: '+60 11-2222 3333', phone_key: '601122223333' });
  store.put('automations/SEQ', { name: 'Seq', trigger_type: 'manual', trigger_config: { stop_on_reply: true }, status: 'active', runs: {}, steps: [{ type: 'wait', amount: 2, unit: 'days' }], created_at: now() });
  store.put('automations/WR', {
    name: 'WhatsApp reply', trigger_type: 'whatsapp_received', trigger_config: { keywords: 'price' }, status: 'active', runs: {}, created_at: now(),
    steps: [{ type: 'add_tag', tag: 'wa-interested' }, { type: 'notify', channel: 'whatsapp', whatsapp: '+60 19-999 0000', provider: 'chatdaddy' }],
  });
  store.put('jobs/e', { type: 'enroll', payload: { automation_id: 'SEQ', contact_ids: ['amy@x.com'] }, status: 'pending', created_at: now() });
  gas.tick();
  const hook = (body, k = secret) => JSON.parse(gas.doPost({ parameter: { a: 'hook', src: 'chatdaddy', k }, postData: { contents: JSON.stringify(body) } }).content);
  assert.equal(hook({ event: 'message-insert', data: [] }, 'wrong').ok, false);
  const payload = {
    event: 'message-insert',
    data: [
      { id: 'M1', chatId: '601122223333', accountId: 'acc1', fromMe: false, text: 'What is the price?' },
      { id: 'M2', chatId: '60177777777', accountId: 'acc1', fromMe: false, text: 'hello', sender: { name: 'New Person' } },
      { id: 'M3', chatId: '601122223333', accountId: 'acc1', fromMe: true, text: 'our own message' },
      { id: 'M4', chatId: '1203630@g.us', accountId: 'acc1', fromMe: false, text: 'group' },
    ],
  };
  assert.deepEqual(hook(payload), { ok: true, handled: 2 });
  assert.deepEqual(hook(payload), { ok: true, handled: 2 }); // duplicate delivery is harmless
  const replies = store.collection('replies').filter((r) => r.channel === 'whatsapp');
  assert.equal(replies.length, 2);
  assert.equal(store.doc('contacts/wa-60177777777').first_name, 'New');
  assert.equal(store.collection('runs').find((r) => r.automation_id === 'SEQ').status, 'stopped');
  gas.tick();
  assert.ok(store.doc('contacts/amy@x.com').tags.includes('wa-interested'));
  assert.ok(!(store.doc('contacts/wa-60177777777').tags || []).includes('wa-interested'), 'keyword filter');
  const notify = calls.find((c) => c.url.endsWith('/60199990000'));
  assert.match(notify.body.text, /WhatsApp reply/);
  assert.match(notify.body.text, /What is the price\?/);
});

test('generic webhook: form submission creates contact in list with tags and fires matching automations', () => {
  const { gas, store, sent } = createGas();
  gas.setup();
  const secret = store.doc('settings/secrets').webhook_secret;
  const welcome = automationId(store, 'Welcome new subscribers');
  store.put(`automations/${welcome}`, { ...store.doc(`automations/${welcome}`), status: 'active', trigger_config: { list_id: 'WEB' } });
  store.put('automations/WH', { name: 'Form', trigger_type: 'webhook_received', trigger_config: { event: 'form_submitted' }, status: 'active', runs: {}, steps: [{ type: 'add_tag', tag: 'form' }], created_at: now() });
  const out = JSON.parse(gas.doPost({ parameter: { a: 'hook', k: secret }, postData: { contents: JSON.stringify({ email: 'Zed@Z.com', name: 'Zed Ong', company: 'ZCo', tags: ['webinar'], list_id: 'WEB', event: 'form_submitted' }) } }).content);
  assert.deepEqual(out, { ok: true, contact: 'zed@z.com' });
  gas.tick();
  const c = store.doc('contacts/zed@z.com');
  assert.deepEqual([c.first_name, c.last_name, c.company, c.list_ids], ['Zed', 'Ong', 'ZCo', ['WEB']]);
  assert.deepEqual(c.tags.sort(), ['form', 'webinar']);
  assert.ok(sent.some((m) => m.to.includes('zed@z.com') && /Welcome aboard, Zed/.test(m.subject)));
  // Other events don't match the event filter.
  JSON.parse(gas.doPost({ parameter: { a: 'hook', k: secret }, postData: { contents: JSON.stringify({ email: 'y@y.com', event: 'other' }) } }).content);
  gas.tick();
  assert.ok(!(store.doc('contacts/y@y.com').tags || []).includes('form'));
});

test('roles: members can use the worker but not admin-only actions', () => {
  const { gas, store } = createGas();
  gas.setup();
  assert.equal(store.doc('admins/owner@gmail.test').role, 'owner');
  store.put('admins/stranger@gmail.test', { email: 'stranger@gmail.test', role: 'member' });
  const call = (body) => JSON.parse(gas.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).content);
  assert.equal(call({ action: 'status', idToken: 'stranger-token' }).ok, true);
  assert.match(call({ action: 'senders', idToken: 'stranger-token' }).error, /Only admins/);
  assert.equal(call({ action: 'senders', idToken: 'admin-token' }).senders.length, 3);
});

test('WhatsApp-only contacts are skipped by email campaigns', () => {
  const { gas, store, sent } = createGas();
  gas.setup();
  store.put('lists/L', { name: 'L' });
  contact(store, 'wa-60123456789', { email: '', phone_key: '60123456789', list_ids: ['L'] });
  contact(store, 'real@x.com', { list_ids: ['L'] });
  store.put('campaigns/C', { name: 'C', subject: 'S', template_id: templateId(store, 'Welcome'), list_ids: ['L'], status: 'launching', stats: {}, created_at: now() });
  gas.tick();
  assert.equal(sent.length, 1);
  assert.equal(store.doc('campaigns/C').stats.total, 1);
});

// ------------------------------------------------------------------ v4: auto-reply, inbound, industries
function autoreplyRule(store, extra = {}) {
  store.put(`autoreplies/${extra.id || 'R1'}`, {
    name: 'Thanks', enabled: true, order: 0, to_address: '', audience: 'all', keywords: '', exclude: '',
    template_id: templateId(store, 'Thank You for Your Reply'), keep_thread: true, from_mode: 'recipient',
    cooldown_hours: 24, schedule: { mode: 'always' }, timezone: 'Asia/Kuala_Lumpur', created_at: now(), ...extra,
  });
}

test('auto-reply: replies once per sender, in thread, from the address they wrote to, and saves the contact', () => {
  const { gas, store, sent, receive } = createGas();
  gas.setup();
  store.put('lists/ENQ', { name: 'Enquiries' });
  autoreplyRule(store, { create_contact: true, list_id: 'ENQ', tags: 'enquiry' });
  const r1 = receive({ from: 'Jane Lim <jane@prospect.test>', to: 'Acme Sales <sales@acme.test>', subject: 'Course fees?', body: 'Hi, how much is the course?' });
  gas.tick();
  assert.equal(sent.length, 1);
  const reply = sent[0];
  assert.match(reply.to, /jane@prospect\.test/);
  assert.equal(reply.headers.from, '"Acme Sales" <sales@acme.test>', 'replies from the alias that received the email');
  assert.equal(reply.subject, 'Re: Course fees?');
  assert.equal(reply.threadId, r1.threadId);
  assert.equal(reply.headers['in-reply-to'], r1.rfcMessageId);
  assert.equal(reply.headers['auto-submitted'], 'auto-replied');
  assert.equal(reply.headers['list-unsubscribe'], undefined);
  assert.match(reply.html, /Hi Jane,/);
  const c = store.doc('contacts/jane@prospect.test');
  assert.deepEqual([c.first_name, c.last_name, c.list_ids, c.tags], ['Jane', 'Lim', ['ENQ'], ['enquiry']]);
  const log = store.doc(`inbound/g-${r1.id}`);
  assert.equal(log.status, 'replied');
  assert.equal(log.autoreply_rule, 'R1');
  assert.equal(store.doc('autoreplies/R1').replied_count, 1);

  // Same message seen again -> not processed twice; a new email within the cooldown -> no second reply.
  gas.tick();
  receive({ from: 'jane@prospect.test', to: 'sales@acme.test', subject: 'One more thing', body: 'Also, do you have weekend classes?' });
  gas.tick();
  assert.equal(sent.length, 1);
  const second = store.collection('inbound').find((d) => d.subject === 'One more thing');
  assert.equal(second.status, 'skipped');
  assert.match(second.reason, /already auto-replied/);
});

test('auto-reply never answers newsletters, no-reply senders, other auto-responders or ourselves', () => {
  const { gas, store, sent, receive } = createGas();
  gas.setup();
  autoreplyRule(store);
  receive({ from: 'News <news@shop.test>', subject: 'Big sale', body: 'x', headers: { 'List-Unsubscribe': '<mailto:u@shop.test>' } });
  receive({ from: 'noreply@bank.test', subject: 'Statement', body: 'x' });
  receive({ from: 'Bob <bob@x.test>', subject: 'Out of office', body: 'x', headers: { 'Auto-Submitted': 'auto-replied' } });
  receive({ from: 'owner@gmail.test', subject: 'note to self', body: 'x' });
  receive({ from: 'Sales <sales@acme.test>', subject: 'from my alias', body: 'x' });
  gas.tick();
  assert.equal(sent.length, 0);
  const reasons = store.collection('inbound').map((d) => d.reason).sort();
  assert.deepEqual(reasons, ['auto-submitted', 'mailing list or newsletter', 'no-reply sender']);
});

test('auto-reply rule filters: address, audience, keywords and office-hours schedule', () => {
  const { gas, store, sent, receive } = createGas();
  gas.setup();
  contact(store, 'known@client.test', { first_name: 'Kim' });
  // Only for email to sales@, only new senders, only when mentioning "price".
  autoreplyRule(store, { id: 'SALES', to_address: 'sales@acme.test', audience: 'new', keywords: 'price, fee' });
  receive({ from: 'a@new.test', to: 'owner@gmail.test', subject: 'price?', body: '' }); // wrong address
  receive({ from: 'known@client.test', to: 'sales@acme.test', subject: 'price?', body: '' }); // already a contact
  receive({ from: 'b@new.test', to: 'sales@acme.test', subject: 'hello', body: 'just saying hi' }); // no keyword
  receive({ from: 'c@new.test', to: 'sales@acme.test', subject: 'Fee', body: 'what is the fee' }); // match
  gas.tick();
  assert.deepEqual(sent.map((m) => m.to.replace(/.*</, '').replace('>', '')), ['c@new.test']);

  // After-hours rule: Saturday 10:00 in Kuala Lumpur is outside Mon-Fri 09:00-18:00.
  store.put('autoreplies/SALES', { ...store.doc('autoreplies/SALES'), enabled: false });
  autoreplyRule(store, { id: 'AFTER', schedule: { mode: 'outside', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } });
  const saturday = new Date('2026-10-03T02:00:00Z'); // Sat 10:00 MYT
  const tuesday = new Date('2026-10-06T02:00:00Z'); // Tue 10:00 MYT
  gas.CONFIG.reset();
  assert.equal(gas.AutoReply.inSchedule(store.doc('autoreplies/AFTER'), saturday), true);
  assert.equal(gas.AutoReply.inSchedule(store.doc('autoreplies/AFTER'), tuesday), false);
  // Messages must also be newer than the last poll, so use "now" for the end-to-end path.
  receive({ from: 'weekend@new.test', subject: 'hi', body: '' });
  gas.AutoReply.reset();
  gas.tick();
  const expectReply = gas.AutoReply.inSchedule(store.doc('autoreplies/AFTER'), new Date());
  assert.equal(sent.some((m) => m.to.includes('weekend@new.test')), expectReply);
});

test('"Any email received" trigger can reply in the same thread', () => {
  const { gas, store, sent, receive } = createGas();
  gas.setup();
  contact(store, 'kim@client.test', { first_name: 'Kim' });
  store.put('automations/ER', {
    name: 'Answer enquiries', trigger_type: 'email_received', trigger_config: { keywords: 'brochure' }, status: 'active', runs: {}, created_at: now(),
    steps: [{ type: 'send_email', template_id: templateId(store, 'Monthly Newsletter'), reply_in_thread: true }],
  });
  receive({ from: 'Kim <kim@client.test>', subject: 'Brochure please', body: 'Can you send your brochure?' });
  const other = receive({ from: 'kim@client.test', subject: 'Unrelated', body: 'hello' });
  gas.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Re: Brochure please');
  assert.ok(sent[0].headers['in-reply-to']);
  assert.notEqual(sent[0].threadId, other.threadId);
});

test('focus industries search several related phrases', () => {
  const queries = [];
  const web = (url, opts) => {
    if (url === 'https://html.duckduckgo.com/html/') {
      queries.push(opts.payload.q);
      return { body: '' };
    }
    return null;
  };
  const { gas, store } = createGas({ web });
  gas.setup();
  store.put('leadSearches/S', { params: { countries: ['MY'], industries: ['Dental Lab'], sources: ['web'], pages: 2 }, status: 'queued', created_at: now() });
  gas.tick();
  assert.deepEqual(queries, [
    '"dental laboratory" company Malaysia contact email',
    '"dental lab" company Malaysia contact email',
    '"dental technician" company Malaysia contact email',
    '"crown and bridge lab" company Malaysia contact email',
  ]);
  assert.equal(store.doc('leadSearches/S').status, 'done');
});
