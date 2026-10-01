const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, startServer } = require('./helpers');
const crawler = require('../src/lib/leads/crawler');
const leads = require('../src/lib/leads');
const { uniqueSites } = require('../src/lib/leads/search');

const { db } = setup();
let site;
let siteUrl;
let srv;

// Encode an address the way Cloudflare's email obfuscation does.
const cf = (email, key = 0x42) => key.toString(16).padStart(2, '0') + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

const PAGES = {
  '/robots.txt': 'User-agent: *\nDisallow: /private\n',
  '/': '<html><head><title>Acme Realty | Homes in KL</title></head><body><a href="/hubungi-kami">Contact</a><a href="/private/staff">Staff</a><img src="logo@2x.png"></body></html>',
  '/hubungi-kami': `<html><body><a href="mailto:Sales@AcmeRealty.test?subject=Hi">Email sales</a>
     <p>Support: support [at] acmerealty [dot] test</p>
     <span class="__cf_email__" data-cfemail="${cf('ceo@acmerealty.test')}">[email protected]</span>
     <p>noreply@acmerealty.test user@example.com</p></body></html>`,
  '/private/staff': '<p>secret@acmerealty.test</p>',
};

test.before(async () => {
  site = http.createServer((req, res) => {
    const body = PAGES[req.url];
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': req.url.endsWith('.txt') ? 'text/plain' : 'text/html' });
    res.end(body);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  srv = await startServer();
});
test.after(async () => {
  site.close();
  await srv.close();
});

test('extractEmails finds mailto, obfuscated and Cloudflare-protected addresses and drops junk', () => {
  const emails = crawler.extractEmails(PAGES['/hubungi-kami']);
  assert.deepEqual(emails.sort(), ['ceo@acmerealty.test', 'sales@acmerealty.test', 'support@acmerealty.test']);
});

test('robots.txt rules are honoured', () => {
  const rules = crawler.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
  assert.equal(crawler.pathAllowed(rules, '/contact'), true);
  assert.equal(crawler.pathAllowed(rules, '/private/x'), false);
  assert.equal(crawler.pathAllowed(rules, '/private/ok'), true);
});

test('crawlSite follows contact links and skips disallowed pages', async () => {
  const r = await crawler.crawlSite(siteUrl, { delayMs: 0 });
  assert.equal(r.company, 'Acme Realty');
  const emails = r.emails.map((e) => e.email);
  assert.ok(emails.includes('sales@acmerealty.test'));
  assert.ok(!emails.includes('secret@acmerealty.test'), 'robots.txt disallowed page must not be crawled');
});

test('uniqueSites removes duplicates and social/directory platforms', () => {
  const sites = uniqueSites(['https://www.acme.com/a', 'https://acme.com/b', 'https://www.facebook.com/acme', 'https://en.wikipedia.org/x', 'https://beta.com.my']);
  assert.deepEqual(sites.map((s) => s.domain), ['acme.com', 'beta.com.my']);
});

test('lead search by country + industry saves leads which can be imported into a list', async () => {
  leads.deps.search = { searchCompanies: async ({ country, industry }) => {
    assert.equal(country, 'MY');
    assert.equal(industry, 'Real Estate');
    return { engine: 'test', sites: [{ website: siteUrl, domain: '127.0.0.1' }] };
  } };
  try {
    const res = await srv.call('POST', '/api/leads/search', { countries: ['MY'], industries: ['Real Estate'], sources: ['web'], limit: 2 });
    assert.equal(res.status, 202);
    let s;
    for (let i = 0; i < 100; i++) {
      s = (await srv.call('GET', `/api/leads/searches/${res.data.id}`)).data;
      if (s.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(s.status, 'done');
    assert.equal(s.leads.length, 2, 'respects the limit');
    assert.ok(s.leads.every((l) => l.country === 'Malaysia' && l.industry === 'Real Estate' && l.company === 'Acme Realty'));

    const list = (await srv.call('POST', '/api/lists', { name: 'MY Real Estate' })).data;
    const imp = (await srv.call('POST', '/api/leads/import', { lead_ids: s.leads.map((l) => l.id), list_id: list.id, tags: 'prospect' })).data;
    assert.equal(imp.created, 2);
    const contact = db.get('SELECT * FROM contacts WHERE email = ?', s.leads[0].email);
    assert.equal(contact.country, 'Malaysia');
    assert.ok(JSON.parse(contact.tags).includes('lead-finder'));
    assert.equal(db.get('SELECT COUNT(*) n FROM list_contacts WHERE list_id = ?', list.id).n, 2);
  } finally {
    leads.deps.search = require('../src/lib/leads/search');
  }
});

test('lead search validates input', async () => {
  const res = await srv.call('POST', '/api/leads/search', {});
  assert.equal(res.status, 400);
});
