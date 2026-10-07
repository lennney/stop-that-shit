'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('default test runner discovers new CJS and ESM tests, skips fixtures, and preserves failures and filters', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts test runner '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'test', 'fixtures'), { recursive: true });
  const runner = path.join(root, 'scripts', 'test.cjs');
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'test.cjs'), runner);
  fs.writeFileSync(path.join(root, 'test', 'first.test.cjs'), "require('node:test')('sample-cjs', () => {});\n");
  fs.writeFileSync(path.join(root, 'test', 'second.test.mjs'), "import test from 'node:test'; test('sample-esm', () => {});\n");
  for (const relative of ['helper.cjs', 'fixtures/fixture.test.cjs']) {
    fs.writeFileSync(path.join(root, 'test', relative), "throw new Error('fixture must not execute');\n");
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (...args) => spawnSync(process.execPath, [runner, ...args], {
    cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 10000
  });

  const passing = run();
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  assert.match(passing.stdout, /sample-cjs/);
  assert.match(passing.stdout, /sample-esm/);

  fs.writeFileSync(path.join(root, 'test', 'new.test.cjs'),
    "require('node:test')('added-failure', () => { throw new Error('new test was discovered'); });\n");
  const failing = run();
  assert.equal(failing.status, 1, failing.stdout + failing.stderr);
  assert.match(failing.stdout, /new test was discovered/);

  const filtered = run('--test-name-pattern=^sample-');
  assert.equal(filtered.status, 0, filtered.stdout + filtered.stderr);
  assert.match(filtered.stdout, /sample-cjs/);
  assert.match(filtered.stdout, /sample-esm/);
});
