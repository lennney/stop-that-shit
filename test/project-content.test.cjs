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
  assert.ok(!content.hosts.some(host => host.id === 'dsh'), 'DSH is not in this reviewed release');
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
