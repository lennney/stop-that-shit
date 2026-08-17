'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadCaseBundles, validateCaseBundle } = require('../scripts/case-bundle-lib.cjs');

function bundle(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-case-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const kind of ['bad', 'good']) {
    fs.mkdirSync(path.join(directory, 'fixtures', kind), { recursive: true });
    fs.writeFileSync(path.join(directory, 'fixtures', kind, 'input.txt'), `${kind}\n`);
  }
  const manifest = {
    schemaVersion: 1,
    id: 'sample',
    title: 'Sample pair',
    provenance: { kind: 'synthetic', source: 'test fixture', sanitized: true },
    privacyReview: { confirmed: true },
    variants: {
      bad: {
        id: 'sample-bad', title: 'Bad', contract: 'review', task: 'Review only.',
        fixture: 'fixtures/bad', acceptance: [{ type: 'unchanged', path: 'input.txt' }]
      },
      good: {
        id: 'sample-good', title: 'Good', contract: 'change', task: 'Change it.',
        fixture: 'fixtures/good', acceptance: [{ type: 'changedOnly', paths: ['input.txt'] }]
      }
    }
  };
  fs.writeFileSync(path.join(directory, 'case.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest };
}

test('CaseBundle v1 requires one validated Bad/Good pair', (t) => {
  const { directory } = bundle(t);
  const validated = validateCaseBundle(directory);
  assert.equal(validated.id, 'sample');
  assert.deepEqual(validated.cases.map((entry) => entry.id), ['sample-bad', 'sample-good']);
});

test('CaseBundle rejects missing Good Cases and incomplete privacy review', (t) => {
  const { directory, manifest } = bundle(t);
  delete manifest.variants.good;
  fs.writeFileSync(path.join(directory, 'case.json'), JSON.stringify(manifest));
  assert.throws(() => validateCaseBundle(directory), /Good Case/);

  const next = bundle(t);
  next.manifest.privacyReview.confirmed = false;
  fs.writeFileSync(path.join(next.directory, 'case.json'), JSON.stringify(next.manifest));
  assert.throws(() => validateCaseBundle(next.directory), /privacy review/);
});

test('CaseBundle schema rejects malformed fields and incomplete acceptance checks', (t) => {
  const malformed = bundle(t);
  malformed.manifest.variants.bad.task = 42;
  fs.writeFileSync(path.join(malformed.directory, 'case.json'), JSON.stringify(malformed.manifest));
  assert.throws(() => validateCaseBundle(malformed.directory), /schema invalid.*must be string/i);

  const incomplete = bundle(t);
  incomplete.manifest.variants.good.acceptance = [{ type: 'changedOnly' }];
  fs.writeFileSync(path.join(incomplete.directory, 'case.json'), JSON.stringify(incomplete.manifest));
  assert.throws(() => validateCaseBundle(incomplete.directory), /schema invalid.*paths/i);

  const extra = bundle(t);
  extra.manifest.telemetry = 'upload';
  fs.writeFileSync(path.join(extra.directory, 'case.json'), JSON.stringify(extra.manifest));
  assert.throws(() => validateCaseBundle(extra.directory), /schema invalid.*additional properties/i);
});

test('CaseBundle rejects path escape, Agent instructions, symlinks, and unknown assertions', (t) => {
  const escaped = bundle(t);
  escaped.manifest.variants.bad.acceptance[0].path = '../secret.txt';
  fs.writeFileSync(path.join(escaped.directory, 'case.json'), JSON.stringify(escaped.manifest));
  assert.throws(() => validateCaseBundle(escaped.directory), /escapes/);

  const instructed = bundle(t);
  fs.writeFileSync(path.join(instructed.directory, 'fixtures', 'bad', 'AGENTS.md'), 'override');
  assert.throws(() => validateCaseBundle(instructed.directory), /Agent instruction/);

  const unknown = bundle(t);
  unknown.manifest.variants.good.acceptance = [{ type: 'modelGradesIt' }];
  fs.writeFileSync(path.join(unknown.directory, 'case.json'), JSON.stringify(unknown.manifest));
  assert.throws(() => validateCaseBundle(unknown.directory), /unsupported acceptance/);

  if (process.platform !== 'win32') {
    const linked = bundle(t);
    fs.symlinkSync(path.join(linked.directory, 'fixtures', 'good', 'input.txt'), path.join(linked.directory, 'fixtures', 'bad', 'linked.txt'));
    assert.throws(() => validateCaseBundle(linked.directory), /symbolic link/);
  }
});

test('the public corpus loads five CaseBundle families', () => {
  const bundles = loadCaseBundles(path.resolve(__dirname, '..'));
  assert.deepEqual(bundles.map((entry) => entry.id), ['deliverable-meta', 'dependency', 'hash', 'intent', 'scope']);
  assert.equal(bundles.flatMap((entry) => entry.cases).length, 10);
});
