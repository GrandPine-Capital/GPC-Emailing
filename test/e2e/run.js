#!/usr/bin/env node
/*
 * Full-stack end-to-end test: the real dashboard (Chromium) + Firebase Auth,
 * Firestore and Hosting emulators + the real Apps Script worker code (run in
 * Node with mocked Gmail/Drive, talking to the Firestore emulator).
 *
 * Prerequisites:
 *   npm run emulators            (in another terminal)
 *   npm i --no-save firebase@12.19.0 esbuild playwright   (or set E2E_NODE_MODULES)
 *   node test/e2e/run.js
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createGas, curlSync } = require('../gas/harness');

const req = createRequire(process.env.E2E_NODE_MODULES ? path.join(process.env.E2E_NODE_MODULES, 'noop.js') : __filename);
const SDK = '12.19.0';
const SITE = 'http://127.0.0.1:5000';
const FS_EMU = 'http://127.0.0.1:8080';
const DOCS = `${FS_EMU}/v1/projects/emailing-portal/databases/(default)/documents`;
const SHOTS = process.env.E2E_SHOTS || path.join(__dirname, '.cache');
const CONFIG = { apiKey: 'fake-api-key', projectId: 'emailing-portal', authDomain: 'emailing-portal.firebaseapp.com', appId: '1:1:web:1' };

const { decode } = require('../gas/fake-firestore');
const emu = (method, p, body) => {
  const r = curlSync(method, p.startsWith('http') ? p : `${DOCS}/${p}`, body ? JSON.stringify(body) : undefined, { Authorization: 'Bearer owner' });
  return r.body ? JSON.parse(r.body) : {};
};
const getDoc = (p) => {
  const d = emu('get', p);
  return d.fields ? Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, decode(v)])) : null;
};
const list = (col) => (emu('get', `${col}?pageSize=300`).documents || []).map((d) => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, decode(v)])) }));

async function bundleSdk() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const entry = path.join(SHOTS, 'entry.mjs');
  fs.writeFileSync(entry, "export * from 'firebase/app';\nexport * from 'firebase/auth';\nexport * from 'firebase/firestore';\n");
  const out = path.join(SHOTS, 'firebase-bundle.mjs');
  await req('esbuild').build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error', nodePaths: [path.dirname(req.resolve('firebase/package.json')).replace(/firebase$/, '')] });
  return fs.readFileSync(out, 'utf8');
}

async function main() {
  // Reset emulators.
  curlSync('delete', `${FS_EMU}/emulator/v1/projects/emailing-portal/databases/(default)/documents`);
  curlSync('delete', 'http://127.0.0.1:9099/emulator/v1/projects/emailing-portal/accounts');

  const sites = {
    'https://acmerealty.test': '<title>Acme Realty | KL</title><a href="/contact">Contact us</a>',
    'https://acmerealty.test/contact': '<a href="mailto:sales@acmerealty.test">Sales</a> <p>info@acmerealty.test</p>',
  };
  const web = (url) => {
    if (url === 'https://html.duckduckgo.com/html/') return { body: `<a class="result__a" href="https://acmerealty.test/">Acme</a>` };
    const k = url.replace(/\/+$/, '');
    return sites[k] !== undefined ? { body: sites[k] } : null;
  };
  const G = createGas({ firestoreEmulator: FS_EMU, trustJwt: true, web });
  G.gas.setup();

  const bundle = await bundleSdk();
  const { chromium } = req('playwright');
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack || ''}`));
  page.on('dialog', (d) => d.accept());

  const ctx = page.context();
  await ctx.route(`https://www.gstatic.com/firebasejs/${SDK}/firebase-app.js`, (r) => r.fulfill({ contentType: 'application/javascript', body: bundle }));
  for (const m of ['auth', 'firestore']) {
    await ctx.route(`https://www.gstatic.com/firebasejs/${SDK}/firebase-${m}.js`, (r) => r.fulfill({ contentType: 'application/javascript', body: `export * from 'https://www.gstatic.com/firebasejs/${SDK}/firebase-app.js';` }));
  }
  await ctx.route('**/__/firebase/init.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(CONFIG) }));
  await ctx.route(`${G.WEBAPP}**`, (r) => {
    const request = r.request();
    const parameter = Object.fromEntries(new URL(request.url()).searchParams);
    const out = request.method() === 'POST'
      ? G.gas.doPost({ parameter, postData: { contents: request.postData() || '' } })
      : G.gas.doGet({ parameter });
    r.fulfill({ status: 200, contentType: out.mime || 'text/html', headers: { 'access-control-allow-origin': '*' }, body: out.content || '' });
  });
  await ctx.route('https://placehold.co/**', (r) => r.fulfill({ contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') }));
  await ctx.route('https://example.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Example destination</h1>' }));

  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const waitFor = async (fn, what, ms = 60000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await page.waitForTimeout(500);
    }
  };
  const step = (name) => console.log(`- ${name}`);

  step('non-admin is denied');
  await page.goto(SITE);
  await page.fill('#emu-email', 'stranger@example.com');
  await page.click('#emu-signin button');
  await page.waitForSelector('text=is not an admin');
  await shot('01-denied');
  await page.click('#signout-denied');

  step('admin signs in and sees the dashboard');
  await page.fill('#emu-email', G.OWNER);
  await page.click('#emu-signin button');
  await page.waitForSelector('#view h1:has-text("Dashboard")');
  await shot('02-dashboard');

  step('create a list and import contacts from CSV');
  await page.goto(`${SITE}/#/lists`);
  await page.click('#new');
  await page.fill('#n', 'Customers');
  await page.click('#go');
  await page.waitForSelector('td >> text=Customers');
  await page.goto(`${SITE}/#/contacts`);
  await page.click('#import');
  await page.fill('#csv', 'Email,Name,Company,Country\nalice@acme.com,Alice Lim,Acme,Malaysia\nbob@beta.com,Bob Tan,Beta,Singapore\nnot-an-email,X,,\n');
  await page.selectOption('#list', { label: 'Customers' });
  await page.fill('#tags', 'expo');
  await page.check('#consent');
  await page.click('.modal #go');
  await page.waitForSelector('#result >> text=Imported 3 rows');
  assert.match(await page.textContent('#result'), /2<\/strong> new|2 new/);
  await page.click('.modal [data-close]');
  await page.waitForSelector('#count >> text=2 contacts');
  await page.fill('input[name=q]', 'alice');
  await page.waitForSelector('#count >> text=1 contacts');
  await shot('03-contacts');
  const alice = getDoc('contacts/alice@acme.com');
  assert.equal(alice.first_name, 'Alice');
  assert.deepEqual(alice.tags, ['expo']);

  step('build a template with drag & drop');
  await page.goto(`${SITE}/#/templates/new-dragdrop`);
  await page.waitForSelector('.pal-item[data-type="heading"]');
  await page.dragAndDrop('.pal-item[data-type="heading"]', '#canvas');
  await page.dragAndDrop('.pal-item[data-type="button"]', '#canvas');
  await page.fill('#t-name', 'E2E template');
  await page.fill('#t-subject', 'Hello {{first_name}}');
  await page.click('#btn-save');
  await waitFor(async () => !/new-dragdrop/.test(await page.evaluate(() => location.hash)), 'template saved');
  const tplId = (await page.evaluate(() => location.hash)).split('/').pop();
  assert.match(getDoc(`templates/${tplId}`).html, /Call to action/);

  step('send a test email from the editor (via the worker)');
  await page.click('#btn-test');
  await page.fill('#test-to', 'qa@example.com');
  await page.click('.modal #send');
  await waitFor(() => G.sent.find((m) => m.to === 'qa@example.com'), 'test email');
  await shot('04-builder');

  step('create and send a campaign');
  await page.goto(`${SITE}/#/campaigns/new`);
  await page.fill('input[name=name]', 'October launch');
  await page.selectOption('select[name=template_id]', { label: 'Monthly Newsletter' });
  await page.fill('input[name=subject]', 'Hi {{first_name}}, news inside');
  await page.check('input[name=list_ids] >> nth=0');
  await page.click('#send');
  await page.click('.modal #ok');
  const campaign = await waitFor(() => list('campaigns').find((c) => c.name === 'October launch' && c.status === 'sent'), 'campaign sent');
  assert.equal(campaign.stats.sent, 2);
  const toAlice = G.sent.find((m) => /alice@acme\.com/.test(m.to));
  assert.equal(toAlice.subject, 'Hi Alice, news inside');
  await page.goto(`${SITE}/#/campaigns/${campaign.id}`);
  await page.waitForSelector('text=Delivered');
  await shot('05-campaign-report');

  step('open pixel, click redirect page and unsubscribe page');
  const token = toAlice.html.match(/r\.html\?t=([a-f0-9]{24})/)[1];
  G.gas.doGet({ parameter: { a: 'o', t: token } });
  const link = toAlice.html.match(/https:\/\/emailing-portal\.web\.app(\/r\.html\?t=[a-f0-9]{24}&amp;k=[a-f0-9]{24})/)[1].replace(/&amp;/g, '&');
  await page.goto(SITE + link);
  await page.waitForURL(/example\.com/);
  assert.ok(list('clicks').length === 1, 'click recorded by r.html');
  const toBob = G.sent.find((m) => /bob@beta\.com/.test(m.to));
  const bobToken = toBob.html.match(/r\.html\?t=([a-f0-9]{24})/)[1];
  await page.goto(`${SITE}/u.html?t=${bobToken}`);
  await page.click('#go');
  await page.waitForSelector("text=You're unsubscribed");
  await shot('06-unsubscribed');
  const summary = G.gas.tick();
  assert.equal(getDoc('contacts/bob@beta.com').status, 'unsubscribed', JSON.stringify(summary));
  const c2 = getDoc(`campaigns/${campaign.id}`);
  assert.deepEqual([c2.stats.opened, c2.stats.clicked, c2.stats.unsubscribed], [1, 1, 1]);

  step('activate the hot-lead automation, receive a reply, check Gmail from the UI');
  await page.goto(SITE);
  await page.waitForSelector('#view h1');
  await page.goto(`${SITE}/#/automations`);
  await page.click('tr:has-text("Hot lead") [data-toggle]');
  await page.waitForSelector('tr:has-text("Hot lead") >> text=active');
  const aliceMsg = list('messages').find((m) => m.email === 'alice@acme.com' && m.campaign_id === campaign.id);
  G.receive({ threadId: aliceMsg.thread_id, from: 'Alice Lim <alice@acme.com>', subject: 'Re: Hi Alice', body: 'Interested! Send pricing please.\n\nOn Mon, X wrote:\n> hi' });
  await page.goto(`${SITE}/#/replies`);
  await page.click('#poll');
  await page.waitForSelector('.reply-body >> text=Interested! Send pricing please.');
  await shot('07-replies');
  assert.ok(getDoc('contacts/alice@acme.com').tags.includes('hot-lead'));

  step('lead finder by country + industry, then import');
  await page.goto(`${SITE}/#/leads`);
  await page.click('[data-chips="countries"] .chip:has-text("Malaysia")');
  await page.click('[data-chips="industries"] .chip:has-text("Real Estate")');
  await page.click('#go');
  await page.waitForSelector('td >> text=sales@acmerealty.test', { timeout: 90000 });
  await page.check('#all');
  await page.fill('#newlist', 'MY real estate');
  await page.click('#imp');
  await page.waitForSelector('text=imported');
  await shot('08-leads');
  assert.equal(getDoc('contacts/sales@acmerealty.test').country, 'Malaysia');

  step('settings show the connected worker');
  await page.goto(`${SITE}/#/settings`);
  await page.click('#check');
  await page.waitForSelector(`text=Connected. Sending as ${G.OWNER}`);
  await shot('09-settings');

  step('dashboard reflects activity');
  await page.goto(`${SITE}/#/dashboard`);
  await page.waitForSelector('.stat .value');
  await shot('10-dashboard-after');

  await browser.close();
  if (errors.length) throw new Error(`Page errors:\n${errors.join('\n')}`);
  console.log('E2E passed. Screenshots in', SHOTS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
