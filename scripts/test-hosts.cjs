'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const key of ['STS_OPENCODE_V1_BIN', 'STS_OPENCODE_V2_BIN']) {
  try {
    if (!process.env[key] || !fs.statSync(process.env[key]).isFile()) throw new Error('Not a file');
    fs.accessSync(process.env[key], fs.constants.X_OK);
  } catch {
    process.stderr.write(`${key} must name an installed executable; host acceptance cannot be skipped.\n`);
    process.exit(1);
  }
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/opencode-dual-smoke.test.mjs'], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true,
  maxBuffer: 16 * 1024 * 1024
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exitCode = result.status ?? 1;
// Node considers skipped/todo/empty suites successful. The dedicated acceptance
// entrypoint requires both actual host checks, even if a future edit adds a skip.
const summary = Object.fromEntries(Array.from((result.stdout || '').matchAll(
  /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm
), ([, key, count]) => [key, Number(count)]));
if (summary.tests !== 2 || summary.pass !== 2
    || ['fail', 'cancelled', 'skipped', 'todo'].some((key) => summary[key] !== 0)) {
  process.stderr.write('Host acceptance requires exactly two passing host tests with no skips, todos, failures, or cancellations.\n');
  process.exitCode = process.exitCode || 1;
}
