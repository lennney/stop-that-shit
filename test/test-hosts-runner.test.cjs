'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts host runner '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'test'));
  const runner = path.join(root, 'scripts/test-hosts.cjs');
  fs.copyFileSync(path.join(__dirname, '../scripts/test-hosts.cjs'), runner);
  const suite = path.join(root, 'test/opencode-dual-smoke.test.mjs');
  const env = { ...process.env, STS_OPENCODE_V1_BIN: process.execPath, STS_OPENCODE_V2_BIN: process.execPath };
  delete env.NODE_TEST_CONTEXT;
  return {
    root, suite,
    run: (source, overrides = {}) => {
      // Synthetic suites exercise the runner only; they are not host evidence.
      fs.writeFileSync(suite, `import test from 'node:test';\n${source}\n`);
      return spawnSync(process.execPath, [runner], {
        cwd: os.tmpdir(), env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000
      });
    }
  };
}

test('host runner refuses missing or invalid executables before running tests', (t) => {
  const { root, run } = fixture(t);
  for (const key of ['STS_OPENCODE_V1_BIN', 'STS_OPENCODE_V2_BIN']) {
    for (const value of ['', path.join(root, 'absent'), root]) {
      const result = run("throw new Error('suite must not run');", { [key]: value });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.includes(`${key} must name an installed executable`));
      assert.doesNotMatch(result.stdout + result.stderr, /suite must not run/);
    }
  }
});

test('host runner requires both passing checks and rejects skips, todos, empty or partial suites', (t) => {
  const { run } = fixture(t);
  const pass = "test('V1', () => {}); test('V2', () => {});";
  const success = run(pass);
  assert.equal(success.status, 0, success.stdout + success.stderr);
  for (const source of [
    '',
    "test('V1', () => {});",
    "test('V1', () => {}); test.skip('V2', () => {});",
    "test.skip('V1', () => {}); test.skip('V2', () => {});",
    "test('V1', () => {}); test.todo('V2');",
    "test('V1', () => {}); test('V2', () => { throw new Error('host failure'); });",
  ]) {
    const result = run(source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /requires exactly two passing host tests/);
  }
});
