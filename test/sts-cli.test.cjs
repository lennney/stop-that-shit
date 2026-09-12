'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { recordDecision } = require('../src/runtime-audit.cjs');

const repositoryRoot = path.join(__dirname, '..');

test('package exposes the explicit sts command', () => {
  const packageJson = require('../package.json');
  assert.equal(packageJson.bin.sts, './scripts/sts.cjs');
  for (const file of [
    'scripts/sts.cjs',
    'scripts/case-bundle-lib.cjs',
    'scripts/generated/case-bundle-v1-validator.cjs'
  ]) {
    assert.ok(packageJson.files.includes(file), `package files omit ${file}`);
  }
});

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, ['scripts/sts.cjs', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env }
  });
}

function stubReleaseFetch(t, release, response = { ok: true, status: 200 }) {
  const directory = temporaryDirectory(t);
  const preload = path.join(directory, 'fetch-preload.cjs');
  const requests = path.join(directory, 'requests.jsonl');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const fs = require('node:fs');",
    "globalThis.fetch = async (url) => {",
    "  fs.appendFileSync(process.env.STS_FETCH_REQUESTS, `${url}\\n`, 'utf8');",
    `  return { ok: ${response.ok}, status: ${response.status}, json: async () => (${JSON.stringify(release)}) };`,
    "};"
  ].join('\n'), 'utf8');
  return {
    requests,
    env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim(),
      STS_FETCH_REQUESTS: requests
    }
  };
}

test('doctor --check-update returns the installed and latest release', (t) => {
  const dataDir = temporaryDirectory(t);
  const fetchStub = stubReleaseFetch(t, {
    tag_name: '0.2.0',
    html_url: 'https://github.com/lennney/stop-that-shit/releases/tag/0.2.0'
  });

  const checked = run(['doctor', '--check-update', '--data-dir', dataDir], { env: fetchStub.env });
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(
    (({ installed, latest, releaseUrl }) => ({ installed, latest, releaseUrl }))(JSON.parse(checked.stdout)),
    {
      installed: require('../package.json').version,
      latest: '0.2.0',
      releaseUrl: 'https://github.com/lennney/stop-that-shit/releases/tag/0.2.0'
    }
  );
  assert.equal(
    fs.readFileSync(fetchStub.requests, 'utf8').trim(),
    'https://api.github.com/repos/lennney/stop-that-shit/releases/latest'
  );
});

test('doctor does not check for updates unless the user passes --check-update', (t) => {
  const dataDir = temporaryDirectory(t);
  const fetchStub = stubReleaseFetch(t, {
    tag_name: '9.9.9',
    html_url: 'https://github.com/lennney/stop-that-shit/releases/tag/9.9.9'
  });

  const checked = run(['doctor', '--data-dir', dataDir], { env: fetchStub.env });
  assert.equal(checked.status, 0, checked.stderr);
  const output = JSON.parse(checked.stdout);
  assert.equal(Object.hasOwn(output, 'installed'), false);
  assert.equal(Object.hasOwn(output, 'latest'), false);
  assert.equal(Object.hasOwn(output, 'releaseUrl'), false);
  assert.equal(fs.existsSync(fetchStub.requests), false);
});

test('doctor --check-update reports a release lookup failure without fallback', (t) => {
  const dataDir = temporaryDirectory(t);
  const fetchStub = stubReleaseFetch(t, {}, { ok: false, status: 503 });

  const checked = run(['doctor', '--check-update', '--data-dir', dataDir], { env: fetchStub.env });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /release lookup failed: HTTP 503/);
  assert.equal(checked.stdout, '');
  assert.equal(fs.readFileSync(fetchStub.requests, 'utf8').trim().split(/\r?\n/).length, 1);
});

test('doctor, runtime, explain, and label expose the local evidence chain', (t) => {
  const dataDir = temporaryDirectory(t);
  const event = recordDecision({
    sessionId: 'session-secret',
    controlState: 'armed',
    action: { name: 'apply_patch', mutability: 'write', affectedPaths: ['secret.txt'] },
    contract: { mode: 'review', level: 'guard', agentBudget: Number.MAX_SAFE_INTEGER, hashPolicy: 'deny', dependencyPolicy: 'ask', allowedPaths: [] },
    decision: { outcome: 'deny_and_explain', family: 'I', reasonCode: 'MODE_FORBIDS_MUTATION' },
    responseOutcome: 'permission_deny_returned'
  }, { dataDir });

  const doctor = run(['doctor', '--data-dir', dataDir]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).runtimeLogFiles, 1);

  const runtime = run(['runtime', '--data-dir', dataDir]);
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.equal(JSON.parse(runtime.stdout).summary.permissionDenyResponses, 1);

  const explain = run(['explain', event.eventId, '--data-dir', dataDir]);
  assert.equal(explain.status, 0, explain.stderr);
  assert.equal(JSON.parse(explain.stdout).event.eventId, event.eventId);

  const label = run(['label', event.eventId, 'correct', '--data-dir', dataDir]);
  assert.equal(label.status, 0, label.stderr);
  assert.equal(JSON.parse(label.stdout).label, 'correct');
});

test('case new creates a deliberately incomplete reviewable skeleton', (t) => {
  const root = temporaryDirectory(t);
  const output = path.join(root, 'sample');
  const created = run(['case', 'new', '--id', 'sample', '--output', output]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(fs.existsSync(path.join(output, 'case.json')), true);

  const validation = run(['case', 'validate', output]);
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /privacy|acceptance|sanitized/i);
});
