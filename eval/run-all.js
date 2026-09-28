// eval/run-all.js — runs every dependency-free suite. Run with: node eval/run-all.js
//
// Exit code is non-zero if any suite fails, so this is the one command CI or a
// pre-deploy check needs.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Anything matching *.test.js is picked up automatically — a new suite should
// not need this file edited, and therefore cannot be silently left out.
const suites = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort();

if (suites.length === 0) {
  console.error('No *.test.js suites found — refusing to report success.');
  process.exit(1);
}

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  try {
    process.stdout.write(execFileSync('node', [path.join(__dirname, suite)], { encoding: 'utf8' }));
  } catch (err) {
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || '');
    failed++;
  }
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
