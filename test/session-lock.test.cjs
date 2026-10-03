'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { acquireSessionLock, statePath } = require('../src/state.cjs');

test('stale legacy locks without a valid owner report damage and remain intact', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-legacy-lock-damage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [index, content] of ['', '123', '0:partial', '99999999999999999999:partial'].entries()) {
    const id = `damaged-${index}`;
    const file = `${statePath(id, dir)}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const old = new Date(Date.now() - 20000);
    fs.utimesSync(file, old, old);
    assert.throws(() => acquireSessionLock(id, dir, { timeoutMs: 30 }), error => {
      assert.equal(error.code, 'STS_LOCK_DAMAGED');
      assert.ok(error.message.includes(path.basename(file)));
      assert.match(error.message, /stop every host process/i);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('a recent incomplete legacy lock remains busy while its owner may be initializing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-legacy-lock-initializing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = `${statePath('initializing', dir)}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  assert.throws(() => acquireSessionLock('initializing', dir, { timeoutMs: 20 }), { code: 'STS_LOCK_TIMEOUT' });
  assert.equal(require('../src/state.cjs').readState('initializing', dir).storageError, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('an updater error is never retried as damaged-lock recovery', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-lock-updater-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failure = Object.assign(new Error('callback failure'), { code: 'STS_LOCK_DAMAGED' });
  let calls = 0;
  assert.throws(() => require('../src/state.cjs').updateSession('callback', dir, () => {
    calls += 1;
    throw failure;
  }), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(`${statePath('callback', dir)}.lock`), false);
});

test('stale lock recovery removes exited owners but preserves a live contender', (t) => {
  const { spawnSync } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-lock-owners-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exitedOwners = Array.from({ length: 2 }, () => {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8', timeout: 5000
    });
    assert.equal(child.status, 0, child.stderr);
    return `${child.stdout}-${randomUUID()}`;
  });
  function seed(sessionId, owners) {
    const file = `${statePath(sessionId, dir)}.lock`;
    fs.mkdirSync(file, { recursive: true });
    for (const owner of owners) fs.writeFileSync(path.join(file, owner), '');
    const old = new Date(Date.now() - 20000);
    fs.utimesSync(file, old, old);
    return file;
  }

  // A delayed initializer can publish beside a replacement owner. Both may
  // exit before removing their markers; neither should strand the session.
  const abandoned = seed('abandoned-pair', exitedOwners);
  acquireSessionLock('abandoned-pair', dir, { timeoutMs: 100 })();
  assert.equal(fs.existsSync(abandoned), false);

  const liveOwner = `${process.pid}-${randomUUID()}`;
  const occupied = seed('live-contender', [...exitedOwners, liveOwner]);
  assert.throws(() => acquireSessionLock('live-contender', dir, { timeoutMs: 30 }), { code: 'STS_LOCK_TIMEOUT' });
  assert.deepEqual(fs.readdirSync(occupied), [liveOwner]);
});

test('an old session lock remains exclusive while its owner is alive', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-live-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = acquireSessionLock('live', dir);
  try {
    const old = new Date(Date.now() - 20000);
    fs.utimesSync(`${statePath('live', dir)}.lock`, old, old);
    assert.throws(() => acquireSessionLock('live', dir, { timeoutMs: 30 }), { code: 'STS_LOCK_TIMEOUT' });
  } finally {
    release();
  }
  const releaseNext = acquireSessionLock('live', dir);
  try {
    release();
    assert.throws(() => acquireSessionLock('live', dir, { timeoutMs: 30 }), { code: 'STS_LOCK_TIMEOUT' });
  } finally {
    releaseNext();
  }
});

test('an abandoned session lock can be recovered after its owner exits', (t) => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-abandoned-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['-e', `
    require(process.argv[1]).acquireSessionLock('abandoned', process.argv[2]);
  `, require.resolve('../src/state.cjs'), dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const file = `${statePath('abandoned', dir)}.lock`;
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(file, old, old);
  const release = acquireSessionLock('abandoned', dir, { timeoutMs: 100 });
  release();
  assert.equal(fs.existsSync(file), false);

  // Recover a file lock left by a previous release, but retain a live one.
  fs.writeFileSync(file, `${result.pid}:legacy-owner 0\n`);
  fs.utimesSync(file, old, old);
  acquireSessionLock('abandoned', dir, { timeoutMs: 100 })();
  fs.writeFileSync(file, `${process.pid}:live-owner 0\n`);
  fs.utimesSync(file, old, old);
  assert.throws(() => acquireSessionLock('abandoned', dir, { timeoutMs: 30 }), { code: 'STS_LOCK_TIMEOUT' });
  assert.match(fs.readFileSync(file, 'utf8'), /live-owner/);
});

test('two stale-lock recoverers cannot enter the same critical section', async (t) => {
  const { spawn, spawnSync } = require('node:child_process');
  const { setTimeout: delay } = require('node:timers/promises');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-lock-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modulePath = require.resolve('../src/state.cjs');
  const seed = spawnSync(process.execPath, ['-e', `
    require(process.argv[1]).acquireSessionLock('race', process.argv[2]);
  `, modulePath, dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(seed.status, 0, seed.stderr);
  const file = `${statePath('race', dir)}.lock`;
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(file, old, old);
  const children = ['A', 'B'].map((name) => {
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path');
      const [modulePath, dir, name] = process.argv.slice(1);
      const marker = suffix => path.join(dir, name + suffix);
      const wait = suffix => {
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(marker(suffix))) {
          if (Date.now() > deadline) throw new Error('barrier timed out: ' + suffix);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      };
      const stat = fs.statSync;
      let observed = false;
      fs.statSync = function (file, ...args) {
        const result = stat.call(this, file, ...args);
        if (!observed && !result.isDirectory() && String(file).endsWith('.lock')) {
          observed = true;
          fs.writeFileSync(marker('.observed'), '');
          wait('.continue');
        }
        return result;
      };
      const readdir = fs.readdirSync;
      fs.readdirSync = function (file, ...args) {
        const result = readdir.call(this, file, ...args);
        if (!observed && String(file).endsWith('.lock')) {
          observed = true;
          fs.writeFileSync(marker('.observed'), '');
          wait('.continue');
        }
        return result;
      };
      try {
        const release = require(modulePath).acquireSessionLock('race', dir, { timeoutMs: 300 });
        fs.writeFileSync(marker('.held'), '');
        if (name === 'A') wait('.release');
        release();
        process.stdout.write('acquired');
      } catch (error) {
        process.stdout.write(error.code || error.message);
      }
    `, modulePath, dir, name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, output, errors }));
    });
    return { child, completed };
  });
  async function waitFor(...markers) {
    const deadline = Date.now() + 5000;
    while (!markers.every(marker => fs.existsSync(path.join(dir, marker)))) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${markers}`);
      await delay(5);
    }
  }
  try {
    await waitFor('A.observed', 'B.observed');
    fs.writeFileSync(path.join(dir, 'A.continue'), '');
    await waitFor('A.held');
    fs.writeFileSync(path.join(dir, 'B.continue'), '');
    const second = await children[1].completed;
    assert.equal(second.code, 0, second.errors);
    assert.equal(second.output, 'STS_LOCK_TIMEOUT');
  } finally {
    for (const { child } of children) child.kill();
    await Promise.all(children.map(({ completed }) => completed));
  }
});

test('a delayed lock initializer cannot join a replacement owner', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-lock-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = `${statePath('delayed', dir)}.lock`;
  const write = fs.writeFileSync;
  let replaced = false, releaseReplacement;
  const mock = t.mock.method(fs, 'writeFileSync', function (target, ...args) {
    if (!replaced && path.dirname(String(target)) === file) {
      replaced = true;
      // Another process recovers the empty directory before this owner writes.
      fs.rmdirSync(file);
      releaseReplacement = acquireSessionLock('delayed', dir);
    }
    return write.call(this, target, ...args);
  });
  try {
    assert.throws(() => acquireSessionLock('delayed', dir, { timeoutMs: 30 }), { code: 'STS_LOCK_TIMEOUT' });
    assert.equal(replaced, true);
    assert.equal(fs.readdirSync(file).length, 1);
  } finally {
    mock.mock.restore();
    releaseReplacement?.();
  }
  acquireSessionLock('delayed', dir)();
});

test('a failed owner-marker write leaves no lock behind', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-lock-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = `${statePath('write-failure', dir)}.lock`;
  const write = fs.writeFileSync;
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const mock = t.mock.method(fs, 'writeFileSync', function (target, ...args) {
    if (path.dirname(String(target)) === file) throw failure;
    return write.call(this, target, ...args);
  });
  try {
    assert.throws(() => acquireSessionLock('write-failure', dir), error => error === failure);
    assert.equal(fs.existsSync(file), false);
  } finally {
    mock.mock.restore();
  }
  acquireSessionLock('write-failure', dir)();
});
