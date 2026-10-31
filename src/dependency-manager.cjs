'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fingerprint(file) {
  const real = fs.realpathSync(file);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('Package manager entry is not a file');
  return { path: real, size: stat.size, mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex') };
}

function resolveManager(name) {
  const search = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const lower = String(name).toLowerCase();
  for (const directory of search) {
    const candidates = [];
    if (lower === 'pnpm') candidates.push(path.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
    if (lower === 'npm') candidates.push(path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return { kind: 'node', entry: fingerprint(candidate), executable: fingerprint(process.execPath) };
    }
    // A POSIX shim may be a symlink to the manager's JS entry. Windows cmd/ps1
    // shims cannot be executed safely with shell:false and are not accepted.
    const launchPath = path.join(directory, process.platform === 'win32' ? `${lower}.exe` : lower);
    if (!fs.existsSync(launchPath)) continue;
    const entry = fingerprint(launchPath);
    if (process.platform !== 'win32' && /(?:pnpm\.cjs|npm-cli\.js)$/i.test(entry.path)) {
      return { kind: 'node', entry, executable: fingerprint(process.execPath) };
    }
    if (process.platform !== 'win32' && !(fs.statSync(launchPath).mode & 0o111)) continue;
    return { kind: 'native', entry, launchPath: path.resolve(launchPath) };
  }
  return null;
}

function unchanged(expected) {
  try { return JSON.stringify(fingerprint(expected.path)) === JSON.stringify(expected); }
  catch { return false; }
}

module.exports = { fingerprint, resolveManager, unchanged };
