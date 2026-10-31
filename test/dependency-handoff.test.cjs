'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHandoff, consumeHandoff, discardHandoff, handoffAvailable, cleanupCreatedHandoffs } = require('../src/dependency-handoff.cjs');

test.after(() => cleanupCreatedHandoffs());

function binding(overrides = {}) {
  return { sessionId: 'handoff-session', ticket: 'a'.repeat(64), eventId: `evt_${'1'.repeat(8)}-${'2'.repeat(4)}-${'3'.repeat(4)}-${'4'.repeat(4)}-${'5'.repeat(12)}`,
    actionDigest: 'b'.repeat(64), argv: ['pnpm', 'install'], targetCwd: fs.realpathSync(os.tmpdir()),
    manager: { kind: 'native', entry: { path: path.join(os.tmpdir(), 'manager.cjs'), sha256: 'f'.repeat(64) } }, ...overrides };
}

test('handoff consumes one identity-bound temp file and cannot be replayed', t => {
  const handoff = createHandoff(binding());
  t.after(() => { try { fs.unlinkSync(handoff.path); } catch {} });
  const stat = fs.statSync(handoff.path, { bigint: true });
  assert.equal(stat.nlink, 1n);
  assert.match(handoff.identity.dev, /^\d+$/);
  assert.match(handoff.identity.ino, /^\d+$/);
  assert.match(handoff.identity.birthtimeNs, /^\d+$/);
  assert.equal(consumeHandoff(handoff, binding()), true);
  assert.equal(fs.existsSync(handoff.path), false);
  assert.throws(() => consumeHandoff(handoff, binding()), /unavailable|identity|handoff/i);
});

test('handoff closes the claimed file before checking its deleted path', t => {
  const expected = binding({ ticket: 'e'.repeat(64), actionDigest: 'f'.repeat(64) });
  const handoff = createHandoff(expected);
  t.after(() => { try { fs.unlinkSync(handoff.path); } catch {} });
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalLstat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let handoffFd;
  let handoffClosed = false;
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(fs, file, ...args);
    if (typeof file === 'string' && file.endsWith('.claim')) handoffFd = fd;
    return fd;
  };
  fs.closeSync = function(fd) {
    if (fd === handoffFd) handoffClosed = true;
    return originalClose.call(fs, fd);
  };
  let claimUnlinked = false;
  fs.unlinkSync = function(file) {
    originalUnlink.call(fs, file);
    if (typeof file === 'string' && file.endsWith('.claim')) claimUnlinked = true;
  };
  fs.lstatSync = function(file, ...args) {
    if (claimUnlinked && typeof file === 'string' && file.endsWith('.claim') && !handoffClosed) {
      const error = new Error('Simulated Windows Node 18 delete-pending path');
      error.code = 'EPERM';
      throw error;
    }
    return originalLstat.call(fs, file, ...args);
  };
  try {
    assert.equal(consumeHandoff(handoff, expected), true);
    assert.equal(handoffClosed, true);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.lstatSync = originalLstat;
    fs.unlinkSync = originalUnlink;
  }
});

test('handoff metadata accepts a temp-root alias that resolves to the canonical root', t => {
  const originalTmpdir = os.tmpdir;
  const actualTmpdir = fs.realpathSync(originalTmpdir());
  const aliasParent = fs.mkdtempSync(path.join(actualTmpdir, 'sts-temp-alias-'));
  const alias = path.join(aliasParent, 'temp-alias');
  try {
    fs.symlinkSync(actualTmpdir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fs.rmSync(aliasParent, { recursive: true, force: true });
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Windows temp junction unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => {
    os.tmpdir = originalTmpdir;
    fs.rmSync(aliasParent, { recursive: true, force: true });
  });
  os.tmpdir = () => alias;
  const expected = binding();
  const handoff = createHandoff(expected);
  assert.equal(handoff.tempRoot, path.join(actualTmpdir, 'stop-that-shit-handoffs'));
  assert.equal(handoffAvailable(handoff, expected), true);
  assert.equal(consumeHandoff(handoff, expected), true);
});

test('handoff rejects changed binding, copied replacement and hard links without consuming', t => {
  const expected = binding();
  const handoff = createHandoff(expected);
  const bytes = fs.readFileSync(handoff.path);
  try {
    assert.throws(() => consumeHandoff(handoff, binding({ actionDigest: 'c'.repeat(64) })), /binding|digest/i);
    assert.equal(fs.existsSync(handoff.path), true);
    fs.unlinkSync(handoff.path);
    fs.writeFileSync(handoff.path, bytes, { flag: 'wx' });
    assert.throws(() => consumeHandoff(handoff, expected), /identity/i);
    fs.unlinkSync(handoff.path);
    const replaced = createHandoff(expected);
    const hardlink = `${replaced.path}.link`;
    try {
      fs.linkSync(replaced.path, hardlink);
      assert.throws(() => consumeHandoff(replaced, expected), /link|identity/i);
      assert.equal(fs.statSync(replaced.path, { bigint: true }).nlink, 2n);
    } finally {
      try { fs.unlinkSync(hardlink); } catch {}
      try { fs.unlinkSync(replaced.path); } catch {}
    }
  } finally {
    try { fs.unlinkSync(handoff.path); } catch {}
  }
});

test('orphaned handoffs can be discarded by identity and expired temp entries are cleaned', t => {
  const root = path.join(fs.realpathSync(os.tmpdir()), 'stop-that-shit-handoffs');
  fs.mkdirSync(root, { recursive: true });
  const stale = path.join(root, `.sts-dependency-${'9'.repeat(64)}.handoff`);
  fs.writeFileSync(stale, 'orphan', { flag: 'w' });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const handoff = createHandoff(binding({ ticket: 'c'.repeat(64), actionDigest: 'd'.repeat(64) }));
  t.after(() => { try { fs.unlinkSync(handoff.path); } catch {} });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(discardHandoff(handoff), true);
  assert.equal(fs.existsSync(handoff.path), false);
});

test('concurrent handoff consumers have exactly one winner', async t => {
  const expected = binding({ ticket: 'd'.repeat(64), actionDigest: 'e'.repeat(64) });
  const handoff = createHandoff(expected);
  t.after(() => { try { fs.unlinkSync(handoff.path); } catch {} });
  const modulePath = path.resolve(__dirname, '../src/dependency-handoff.cjs');
  const source = `const {consumeHandoff}=require(${JSON.stringify(modulePath)});const h=JSON.parse(process.argv[1]);process.stdout.write('ready\\n');process.stdin.once('data',()=>{try{consumeHandoff(h,${JSON.stringify(expected)});process.stdout.write('won')}catch(e){process.stdout.write('lost')}});`;
  const children = [0, 1].map(() => spawn(process.execPath, ['-e', source, JSON.stringify(handoff)], { stdio: ['pipe', 'pipe', 'pipe'] }));
  let ready = 0;
  for (const child of children) child.stdout.on('data', chunk => { ready += (chunk.toString().match(/ready/g) || []).length; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('consumer readiness timeout')), 5000);
    const poll = setInterval(() => { if (ready === 2) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 5);
  });
  const outputs = [];
  const closed = children.map(child => new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(out) : reject(new Error(`consumer exit ${code}`)));
  }));
  for (const child of children) child.stdin.end('go');
  outputs.push(...await Promise.all(closed));
  assert.equal(outputs.filter(output => output.includes('won')).length, 1);
  assert.equal(outputs.filter(output => output.includes('lost')).length, 1);
});
