#!/usr/bin/env node
/*
 * Push the Apps Script worker and update its web-app deployment to the new
 * code - without having to look up the deployment ID.
 *
 *   npm run deploy:worker                      (from the repo root)
 *   node scripts/redeploy-worker.js --id AKfy… (pick a specific deployment)
 *   node scripts/redeploy-worker.js --no-push  (only redeploy)
 *
 * The existing deployment is updated in place, so its /exec URL (saved in
 * Settings → Worker) stays the same.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DIR = path.join(__dirname, '..', 'apps-script');
// Overridable for tests: CLASP_CMD="node fake-clasp.js"
const CLASP = (process.env.CLASP_CMD || 'npx -y @google/clasp@latest').split(' ');

function clasp(args, { capture = false } = {}) {
  const [cmd, ...pre] = CLASP;
  return execFileSync(cmd, [...pre, ...args], { cwd: DIR, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
}

function parseDeployments(out) {
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`Could not read deployments from clasp output:\n${out}`);
  return JSON.parse(out.slice(start, out.lastIndexOf(']') + 1));
}

/** The web-app deployments (not the @HEAD test deployment), newest version first. */
function pickDeployments(list) {
  return list.filter((d) => d.deploymentId && d.versionNumber).sort((a, b) => b.versionNumber - a.versionNumber);
}

function main() {
  const args = process.argv.slice(2);
  const idArg = args.includes('--id') ? args[args.indexOf('--id') + 1] : process.env.DEPLOYMENT_ID;
  const description = `Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

  if (!fs.existsSync(path.join(DIR, '.clasp.json'))) {
    console.error('apps-script/.clasp.json not found. Run the one-time "clasp create" step from the README first.');
    process.exit(1);
  }

  if (!args.includes('--no-push')) {
    console.log('→ Pushing worker code to Apps Script…');
    clasp(['push', '-f']);
  }

  let id = idArg;
  if (!id) {
    const deployments = pickDeployments(parseDeployments(clasp(['deployments', '--json'], { capture: true })));
    if (!deployments.length) {
      console.log('→ No web-app deployment yet - creating one…');
      clasp(['deploy', '-d', description]);
      const created = pickDeployments(parseDeployments(clasp(['deployments', '--json'], { capture: true })))[0];
      if (!created) throw new Error('Deployment was not created - check the clasp output above.');
      console.log(`\n✔ Worker deployed.\n  Web app URL: https://script.google.com/macros/s/${created.deploymentId}/exec`);
      console.log('  Next: open the Apps Script editor (npx @google/clasp open-script), run setup(), and authorise it.');
      return;
    }
    if (deployments.length > 1) {
      console.log(`ℹ Found ${deployments.length} deployments; updating the newest one (version ${deployments[0].versionNumber}).`);
      console.log('  To choose another: node scripts/redeploy-worker.js --no-push --id <deploymentId>');
      deployments.forEach((d) => console.log(`    ${d.deploymentId}  v${d.versionNumber}  ${d.description || ''}`));
    }
    id = deployments[0].deploymentId;
  }

  console.log(`→ Updating deployment ${id}…`);
  clasp(['redeploy', id, '-d', description]);
  console.log(`\n✔ Worker updated. Web app URL (unchanged): https://script.google.com/macros/s/${id}/exec`);
  console.log('  It should match Settings → Worker → "Apps Script web app URL" in the dashboard.');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`\n✖ ${e.message}`);
    process.exit(1);
  }
}

module.exports = { parseDeployments, pickDeployments };
