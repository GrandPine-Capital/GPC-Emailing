const test = require('node:test');
const assert = require('node:assert/strict');
const { TABS, tabFromHash, hashFor, legacyRedirect } = require('../web/shared/settings-tabs');

test('the tab comes from the hash', () => {
  assert.equal(tabFromHash('#/settings/integrations'), 'integrations');
  assert.equal(tabFromHash('#/settings/sending'), 'sending');
  assert.equal(tabFromHash('#/settings/transactional?q=Pay1'), 'transactional');
});

test('#/settings opens the first tab', () => {
  assert.equal(tabFromHash('#/settings'), 'general');
  assert.equal(tabFromHash('#/settings/'), 'general');
  assert.equal(tabFromHash(''), 'general');
});

test('an unknown tab opens the first tab', () => {
  assert.equal(tabFromHash('#/settings/nope'), 'general');
});

test('hashFor builds the address of a tab, with a query', () => {
  assert.equal(hashFor('sending'), '#/settings/sending');
  assert.equal(hashFor('transactional', 'q=a%40b.com'), '#/settings/transactional?q=a%40b.com');
  assert.equal(hashFor('bogus'), '#/settings/general');
});

test('the old Transactional route leads to its tab', () => {
  assert.equal(legacyRedirect('#/transactional'), '#/settings/transactional');
  assert.equal(legacyRedirect('#/transactional?q=Pay1'), '#/settings/transactional?q=Pay1');
  assert.equal(legacyRedirect('#/settings'), null);
  assert.equal(legacyRedirect('#/transactionalx'), null);
});

test('every tab round-trips', () => {
  for (const t of TABS) assert.equal(tabFromHash(hashFor(t.id)), t.id);
});
