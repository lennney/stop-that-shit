'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('package declares the Pi Extension and existing Skill as a Pi package', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));

  assert.ok(packageJson.keywords.includes('pi-package'));
  assert.deepEqual(packageJson.pi.extensions, ['./pi/stop-that-shit.ts']);
  assert.deepEqual(packageJson.pi.skills, ['./skills/stop-that-shit']);
  assert.equal(packageJson.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(packageJson.peerDependenciesMeta['@earendil-works/pi-coding-agent'].optional, true);
  assert.ok(packageJson.files.includes('pi/'));
  assert.ok(release.include.includes('pi'));
  assert.ok(fs.existsSync(path.join(root, 'pi', 'stop-that-shit.ts')));
  assert.ok(fs.existsSync(path.join(root, 'skills', 'stop-that-shit', 'SKILL.md')));
});
