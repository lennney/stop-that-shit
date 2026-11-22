'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('release text checks cover packaged formats and Windows path separators', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-release-check-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  for (const entry of manifest.include) {
    fs.cpSync(path.join(root, entry), path.join(fixture, entry), { recursive: true });
  }
  const check = () => spawnSync(process.execPath, ['scripts/release-check.cjs'], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000
  });
  const baseline = check();
  assert.equal(baseline.status, 0, baseline.stderr);

  const preview = 'https://github.com/lennney/stop-that-shit/releases';
  const previewTag = '0.2.7-dsh.1';
  const previewAsset = 'stop-that-shit-dsh-0.2.7-dsh.1.tgz';
  for (const [relative, reference] of [
    ['README.md', '[Next preview](' + preview + '/tag/0.2.7-dsh.2)'],
    ['README_EN.md', '[Other asset](' + preview + '/download/' + previewTag + '/stop-that-shit-0.2.7-dsh.1.zip)'],
    ['README_KO.md', '[Different source](https://example.invalid/releases/download/' + previewTag + '/' + previewAsset + ')'],
    ['README.md', 'codex plugin marketplace add lennney/stop-that-shit --ref ' + previewTag],
    ['INSTALL.md', '[Preview in stable guide](' + preview + '/tag/' + previewTag + ')'],
    ['README_CN.md', '[Preview outside reviewed locales](' + preview + '/tag/' + previewTag + ')']
  ]) {
    await t.test('unexpected preview reference in ' + relative + ': ' + reference, () => {
      const target = path.join(fixture, relative);
      const original = fs.readFileSync(target);
      try {
        fs.appendFileSync(target, '\n' + reference + '\n');
        const result = check();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(result.stderr.includes('versioned install reference in ' + relative), result.stderr);
      } finally {
        fs.writeFileSync(target, original);
      }
    });
  }

  const privatePosixPath = ['', 'home', 'example', 'private'].join('/');
  const cases = ['.mjs', '.py', '.svg', '.csv'].map((extension) => ({
    name: `private path in ${extension}`, extension, content: privatePosixPath
  }));
  for (const directory of ['Users', 'object']) {
    for (const separator of ['/', '\\']) {
      cases.push({
        name: `Windows ${directory} path with ${JSON.stringify(separator)}`,
        extension: '.cjs', content: ['C:', directory, 'example', 'private'].join(separator)
      });
    }
  }
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const relative = path.join('src', `release-scan-fixture${entry.extension}`);
      const target = path.join(fixture, relative);
      try {
        fs.writeFileSync(target, entry.content);
        const result = check();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(result.stderr.includes(`machine-specific path in ${relative}`), result.stderr);
      } finally {
        fs.rmSync(target, { force: true });
      }
    });
  }
});
