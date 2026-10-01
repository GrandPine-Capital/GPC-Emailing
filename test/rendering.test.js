const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { renderDesign } = require('../src/lib/render-blocks');
const { merge, buildEmail, verify } = require('../src/lib/personalize');

setup();

test('renderDesign builds table-based HTML for every block type', () => {
  const types = ['heading', 'text', 'image', 'button', 'divider', 'spacer', 'columns', 'social', 'footer', 'html'];
  const html = renderDesign({ settings: { width: 640, bgColor: '#123456' }, blocks: types.map((type) => ({ type, props: {} })) });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /width="640"/);
  assert.match(html, /background:#123456/);
  assert.match(html, /Your headline here/);
  assert.match(html, /Call to action/);
  assert.match(html, /class="col"/);
});

test('renderDesign escapes text props', () => {
  const html = renderDesign({ blocks: [{ type: 'heading', props: { text: '<script>x</script>' } }] });
  assert.ok(!html.includes('<script>x'));
  assert.match(html, /&lt;script&gt;/);
});

test('merge tags support fallbacks and HTML escaping', () => {
  const vars = { first_name: '', company: 'A&B <Co>' };
  assert.equal(merge('Hi {{first_name|there}} from {{ company }}', vars), 'Hi there from A&B <Co>');
  assert.equal(merge('{{company}}', vars, { html: true }), 'A&amp;B &lt;Co&gt;');
  assert.equal(merge('{{unknown}}!', vars), '!');
});

test('buildEmail adds unsubscribe link, click tracking and open pixel', () => {
  const email = buildEmail({
    html: '<html><body><p>Hi {{first_name}}</p><a href="https://example.com/a?x=1&amp;y=2">Go</a></body></html>',
    subject: 'Hello {{first_name|friend}}',
    contact: { email: 'a@b.com', first_name: 'Ann' },
    token: 'tok123',
  });
  assert.equal(email.subject, 'Hello Ann');
  assert.match(email.html, /http:\/\/test\.local\/u\/tok123/);
  assert.match(email.html, /http:\/\/test\.local\/t\/o\/tok123\.gif/);
  const m = email.html.match(/href="http:\/\/test\.local\/t\/c\/tok123\?u=([^&]+)&amp;s=([a-f0-9]+)"/);
  assert.ok(m, 'link should be rewritten');
  assert.equal(decodeURIComponent(m[1]), 'https://example.com/a?x=1&y=2');
  assert.ok(verify(decodeURIComponent(m[1]), m[2]));
  assert.ok(!verify('https://evil.com', m[2]));
  assert.match(email.text, /Unsubscribe: http:\/\/test\.local\/u\/tok123/);
});

test('buildEmail does not duplicate an existing unsubscribe link', () => {
  const email = buildEmail({ html: '<body><a href="{{unsubscribe_url}}">bye</a></body>', subject: '', contact: { email: 'a@b.com' }, token: 't2' });
  assert.equal(email.html.split('/u/t2').length - 1, 1);
});
