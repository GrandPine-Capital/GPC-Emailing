const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderDesign } = require('../web/shared/render-blocks');
const Core = require('../web/shared/email-core');
const Catalog = require('../web/shared/catalog');

test('renderDesign builds table-based HTML for every block type', () => {
  const types = ['heading', 'text', 'image', 'button', 'divider', 'spacer', 'columns', 'social', 'footer', 'html'];
  const html = renderDesign({ settings: { width: 640, bgColor: '#123456' }, blocks: types.map((type) => ({ type, props: {} })) });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /width="640"/);
  assert.match(html, /background:#123456/);
  assert.match(html, /Your headline here/);
  assert.match(html, /class="col"/);
});

test('renderDesign escapes text props', () => {
  const html = renderDesign({ blocks: [{ type: 'heading', props: { text: '<script>x</script>' } }] });
  assert.ok(!html.includes('<script>x'));
});

test('merge tags support fallbacks and HTML escaping', () => {
  const vars = { first_name: '', company: 'A&B <Co>', unsubscribe_url: 'https://x/u?a=1&b=2' };
  assert.equal(Core.merge('Hi {{first_name|there}} from {{ company }}', vars), 'Hi there from A&B <Co>');
  assert.equal(Core.merge('{{company}}', vars, { html: true }), 'A&amp;B &lt;Co&gt;');
  assert.equal(Core.merge('{{unsubscribe_url}}', vars, { html: true }), 'https://x/u?a=1&b=2');
  assert.equal(Core.merge('{{unknown}}!', vars), '!');
});

test('email helpers', () => {
  assert.ok(Core.isEmail('a.b+c@d.co'));
  assert.ok(!Core.isEmail('nope'));
  assert.ok(!Core.isEmail('a/b@c.com'), 'slashes are not allowed');
  assert.equal(Core.emailKey(' Alice@Acme.COM '), 'alice@acme.com');
  assert.deepEqual(Core.normaliseTags('a, b;a | c'), ['a', 'b', 'c']);
  assert.equal(Core.addressOf('Alice <ALICE@x.com>'), 'alice@x.com');
  assert.equal(Core.stripQuoted('Yes please\n\nOn Mon, Bob wrote:\n> hi'), 'Yes please');
  const kw = Core.searchKeywords({ email: 'alice@acme.com', first_name: 'Alice', company: 'Acme Sdn Bhd' });
  for (const w of ['alice', 'acme', 'acme.com', 'alice@acme.com', 'sdn']) assert.ok(kw.includes(w), w);
  assert.match(Core.htmlToText('<p>Hi</p><a href="https://x.com">Go</a>'), /Hi\nGo \(https:\/\/x\.com\)/);
});

test('catalog', () => {
  assert.equal(Catalog.countryName('my'), 'Malaysia');
  assert.equal(Catalog.byCode('SG').region, 'sg-en');
  assert.ok(Catalog.INDUSTRIES.includes('Real Estate'));
  assert.ok(Catalog.TRIGGERS.reply_received);
});

test('internal/catalog/catalog.json matches web/shared/catalog.js (run `node scripts/gen-catalog.js`)', () => {
  const gen = require('../scripts/gen-catalog');
  assert.equal(fs.readFileSync(gen.out, 'utf8'), gen.build());
});
