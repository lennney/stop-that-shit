'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
// Enumerate files explicitly: directory and glob handling differ across the
// supported Node versions and shells. Fixtures are not executable test entries.
const files = fs.readdirSync(path.join(root, 'test'), { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.test\.[cm]js$/.test(entry.name))
  .map(entry => path.join('test', entry.name))
  .sort();
if (files.length === 0) throw new Error('No test/*.test.cjs or test/*.test.mjs files found');

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
