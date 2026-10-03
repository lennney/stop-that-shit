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
