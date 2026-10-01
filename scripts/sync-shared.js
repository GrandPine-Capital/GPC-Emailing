#!/usr/bin/env node
/* Copy shared/*.js into the Hosting site and the Apps Script project. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'shared')).filter((f) => f.endsWith('.js'));
const banner = '// GENERATED from shared/ by scripts/sync-shared.js - edit the file in shared/ instead.\n';
for (const f of files) {
  const src = banner + fs.readFileSync(path.join(root, 'shared', f), 'utf8');
  fs.writeFileSync(path.join(root, 'hosting', 'shared', f), src);
  fs.writeFileSync(path.join(root, 'apps-script', `Shared_${f.replace(/-/g, '_')}`), src);
}
if (require.main === module) console.log(`Synced ${files.length} shared files.`);
module.exports = { files };
