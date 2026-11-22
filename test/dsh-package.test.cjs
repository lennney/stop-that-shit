'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { version: releaseVersion } = require('../package.json');
const { engines, repository, version: dshVersion } = require('../dsh/package.json');
const version = dshVersion === '0.0.0-development' ? releaseVersion : dshVersion;

test('the DSH bundle targets only accepted host versions', () => {
  assert.equal(engines.dsh, '0.2.2-rc.3 || 0.2.2-rc.5');
});

test('the packed DSH bundle runs its bridge outside the STS checkout', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-dsh-package-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const artifact = path.join(temporary, `stop-that-shit-dsh-${version}.tgz`);
  const build = spawnSync(process.execPath, [require.resolve('../scripts/build-dsh-bundle.cjs'), temporary], {
    cwd: temporary, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, npm_config_cache: path.join(temporary, 'npm-cache') }
  });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.stdout.trim(), artifact);

  const unpack = spawnSync('tar', ['-xf', artifact, '-C', temporary], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(unpack.error);
  assert.equal(unpack.status, 0, unpack.stderr);

  const installed = path.join(temporary, 'package');
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.engines, engines);
  assert.deepEqual(manifest.repository, repository);
  assert.equal(manifest.repository.url, 'https://github.com/lennney/stop-that-shit.git');
  for (const field of ['private', 'dependencies', 'peerDependencies', 'scripts']) {
    assert.equal(manifest[field], undefined, `bundle has no ${field} field`);
  }
  assert.ok(fs.existsSync(path.join(installed, 'src', 'windows-job-guard.cs')));
  const patch = fs.readFileSync(path.join(installed, manifest.dsh.bundle.patch), 'utf8');
  assert.match(patch, /^\s+name: stop-that-shit-dsh\s*$/m);

  const bridge = require(installed);
  const session = { id: 'test-session', header: { cwd: temporary } };
  const agent = { session };
  const handlers = new Map();
  bridge.apply({
    subagents: { rootOf: (owner) => owner },
    workingDirectory: { get: (ownerSession) => ownerSession.header.cwd },
    on: (event, listener) => handlers.set(event, listener)
  }, { dataDir: path.join(temporary, 'sts-data') });
  const messages = [{
    role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '$stop-that-shit review -- inspect only' }]
  }];
  await handlers.get('agent/pre-step')({ agent, messages, turn: 1 }, () => ({ kind: 'enter', messages }));

  const beforeTool = handlers.get('tools/pre-execute');
  const input = { agent, arguments: { file_path: 'example.txt', content: 'synthetic' } };
  const denied = await beforeTool({ ...input, name: 'write', callId: 'write-1' }, () => assert.fail('review write reached dispatch'));
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /MODE_FORBIDS_MUTATION/);
  const downstream = { kind: 'allow' };
  assert.equal(await beforeTool({ ...input, name: 'read', callId: 'read-1' }, () => downstream), downstream);
});
