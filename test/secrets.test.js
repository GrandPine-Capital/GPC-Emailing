const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { generateSecret } = require('../web/shared/secrets');

const fill = (a) => webcrypto.getRandomValues(a);

test('48 URL-safe characters by default', () => {
  const s = generateSecret(fill);
  assert.equal(s.length, 48);
  assert.match(s, /^[A-Za-z0-9_-]{48}$/);
});

test('two secrets differ', () => {
  assert.notEqual(generateSecret(fill), generateSecret(fill));
});

test('every byte value maps into the alphabet', () => {
  const all = (a) => { for (let i = 0; i < a.length; i++) a[i] = 255 - i; return a; };
  assert.match(generateSecret(all), /^[A-Za-z0-9_-]{48}$/);
});

test('the length can be chosen', () => {
  assert.equal(generateSecret(fill, 10).length, 10);
});
