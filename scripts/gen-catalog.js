#!/usr/bin/env node
/*
 * Writes internal/catalog/catalog.json from web/shared/catalog.js, so the Go worker (lead finder,
 * automation validation) and the browser read one catalogue. Run after editing catalog.js:
 *   node scripts/gen-catalog.js
 * test/shared.test.js fails while the two disagree.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require('../web/shared/catalog');

function build() {
  return JSON.stringify({
    countries: C.COUNTRIES,
    focus_industries: C.FOCUS_INDUSTRIES.map((i) => ({ name: i.name, keywords: i.keywords })),
    triggers: Object.keys(C.TRIGGERS),
    step_types: Object.keys(C.STEP_TYPES),
    stop_conditions: Object.keys(C.STOP_CONDITIONS),
  }, null, 1) + '\n';
}

const out = path.join(__dirname, '..', 'internal', 'catalog', 'catalog.json');
if (require.main === module) {
  fs.writeFileSync(out, build());
  console.log('Wrote ' + path.relative(process.cwd(), out));
}
module.exports = { build, out };
