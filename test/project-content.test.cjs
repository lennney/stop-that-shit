'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateContent, validateRelease } = require('../project-content/validate.cjs');
const root = path.resolve(__dirname, '..');
const content = JSON.parse(fs.readFileSync(path.join(root, 'project-content/stable.json'), 'utf8'));
const proof = JSON.parse(fs.readFileSync(path.join(root, 'project-content/release-proof.json'), 'utf8'));

test('the multilingual stable baseline has a complete release record', () => {
  validateContent(content);
  validateRelease(content, proof);
  assert.ok(content.hosts.some(host => host.id === 'omp'));
  assert.ok(!content.hosts.some(host => host.id === 'dsh'), 'DSH preview must remain separate from the six Host integrations');
});

test('content validation rejects missing translations and duplicate Hosts', () => {
  const missing = structuredClone(content);
  delete missing.locales.ko;
  assert.throws(() => validateContent(missing));
  const duplicate = structuredClone(content);
  duplicate.hosts.push(duplicate.hosts[0]);
  assert.throws(() => validateContent(duplicate));
});

test('stable content cannot use a development version or a different released commit', () => {
  const development = structuredClone(content);
  development.release.version += '-dev';
  assert.throws(() => validateContent(development));
  assert.throws(() => validateRelease(content, { ...proof, commit: 'a'.repeat(40) }));
  assert.throws(() => validateRelease(content, { ...proof, prerelease: true }));
});



test('0.2.6 content keeps DSH preview scope explicit in every language', () => {
  assert.equal(content.release.version, '0.2.6');
  assert.equal(content.hosts.length, 6);
  for (const [locale, preview] of [['zh', '预览'], ['en', 'preview'], ['ko', '미리보기']]) {
    const copy = content.locales[locale];
    assert.ok(copy.description.includes(preview));
    for (const requirement of ['DSH', '24.9.0', '0.2.2-rc.3', 'web', 'Standard'])
      assert.ok(copy.requirements.includes(requirement), `${locale}: ${requirement}`);
  }
});
