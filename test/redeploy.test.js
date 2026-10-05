const test = require('node:test');
const assert = require('node:assert');
const { parseDeployments, pickDeployments } = require('../scripts/redeploy-worker.js');

test('parses clasp deployments JSON even with log noise around it', () => {
  const out = 'Found 2 deployments.\n[{"deploymentId":"AKfyHEAD"},{"deploymentId":"AKfyV1","versionNumber":1,"description":"v1"}]\n';
  assert.deepStrictEqual(parseDeployments(out).map((d) => d.deploymentId), ['AKfyHEAD', 'AKfyV1']);
});

test('ignores @HEAD and picks the newest versioned deployment', () => {
  const list = [
    { deploymentId: 'AKfyHEAD' },
    { deploymentId: 'AKfyOld', versionNumber: 2 },
    { deploymentId: 'AKfyNew', versionNumber: 5 },
  ];
  assert.deepStrictEqual(pickDeployments(list).map((d) => d.deploymentId), ['AKfyNew', 'AKfyOld']);
  assert.deepStrictEqual(pickDeployments([{ deploymentId: 'AKfyHEAD' }]), []);
});

test('rejects output without a deployments list', () => {
  assert.throws(() => parseDeployments('Not logged in'), /Could not read deployments/);
});
