const test = require('node:test');
const assert = require('node:assert/strict');
const { needsChatDaddy, visibleRecipes } = require('../web/shared/recipes');

const recipes = [
  { key: 'plain', title: 'Plain', desc: 'd', steps: () => [{ type: 'send_email' }, { type: 'send_whatsapp', text: 'hi' }] },
  {
    key: 'click', title: 'Clicked → ChatDaddy follow-up', desc: 'cd', steps: () => [{ type: 'chatdaddy_contact' }, { type: 'send_whatsapp', provider: 'chatdaddy' }],
    gpc: { title: 'Clicked → WhatsApp follow-up', desc: 'wa', steps: () => [{ type: 'send_whatsapp', text: 'x' }] },
  },
  { key: 'sync', title: 'Sync', desc: 's', steps: () => [{ type: 'chatdaddy_contact' }] },
  { key: 'cdsend', title: 'CD send', desc: 's', steps: () => [{ type: 'send_whatsapp', provider: 'chatdaddy' }] },
];

test('needsChatDaddy spots the contact step and the chatdaddy provider only', () => {
  assert.equal(needsChatDaddy([{ type: 'chatdaddy_contact' }]), true);
  assert.equal(needsChatDaddy([{ type: 'send_whatsapp', provider: 'chatdaddy' }]), true);
  assert.equal(needsChatDaddy([{ type: 'send_whatsapp', provider: 'cloud' }, { type: 'send_whatsapp' }]), false);
});

test('switch on: recipes are returned exactly as they are', () => {
  assert.equal(visibleRecipes(recipes, true), recipes);
});

test('switch off: variant swapped in, ChatDaddy-only hidden, others untouched', () => {
  const out = visibleRecipes(recipes, false);
  assert.deepEqual(out.map((r) => r.key), ['plain', 'click']);
  const click = out[1];
  assert.equal(click.title, 'Clicked → WhatsApp follow-up');
  assert.ok(!/chatdaddy/i.test(JSON.stringify([click.title, click.desc, click.steps()])));
  assert.equal(out[0], recipes[0]);
});

test('the real recipes list follows the rules', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../web/js/automations.js'), 'utf8');
  assert.ok(src.includes("key: 'click_to_chatdaddy'") && src.includes('gpc: {') && src.includes("key: 'unsub_sync'"));
});
