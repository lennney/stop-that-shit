'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('OMP is packaged as an explicit extension without replacing the Pi entrypoint', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, ['./pi/stop-that-shit.ts']);
  assert.ok(pkg.files.includes('omp/'));
  assert.ok(release.include.includes('omp'));
  const entry = fs.readFileSync(path.join(root, 'omp/stop-that-shit.ts'), 'utf8');
  assert.match(entry, /import type .*@oh-my-pi\/pi-coding-agent/);
  assert.match(entry, /registerOmpExtension/);
  for (const file of ['omp-extension.cjs', 'omp-hooks.cjs', 'omp-tool-classifier.cjs']) {
    assert.ok(fs.existsSync(path.join(root, 'src/adapters', file)));
  }
});
