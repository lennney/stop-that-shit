'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManager, unchanged } = require('../src/dependency-manager.cjs');

test('resolves a native executable and detects changes', t => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-resolve-'));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(bin, { recursive: true, force: true }); });
  process.env.PATH = bin;
  const executable = path.join(bin, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm');
  fs.writeFileSync(executable, 'fixture');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  const result = resolveManager('pnpm');
  assert.equal(result.kind, 'native');
  assert.equal(fs.realpathSync(result.launchPath), result.entry.path);
  assert.equal(unchanged(result.entry), true);
  fs.appendFileSync(executable, 'modified');
  assert.equal(unchanged(result.entry), false);
  assert.equal(resolveManager('not-present'), null);
});
