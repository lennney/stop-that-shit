'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const source = path.join(root, 'dsh');
const { version, license } = require('../package.json');
const manifest = require('../dsh/package.json');
const outputDirectory = path.resolve(process.argv[2] || path.join(root, 'dist'));
const archiveName = `${manifest.name}-${version}.tgz`;

fs.mkdirSync(outputDirectory, { recursive: true });
const staging = fs.mkdtempSync(path.join(outputDirectory, '.dsh-package-'));
try {
  // Keep the source layout so the same bridge resolves ../../src in both
  // a checkout and the installed package. The patch resolves the package by name.
  const main = path.posix.join('dsh', manifest.main);
  const patch = manifest.dsh.bundle.patch;
  for (const [from, to] of [
    [path.join(source, manifest.main), main],
    [path.join(source, patch), patch],
    [path.join(root, 'src'), 'src'],
    [path.join(root, 'LICENSE'), 'LICENSE']
  ]) {
    const destination = path.join(staging, to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(from, destination, { recursive: true });
  }

  const metadata = {
    ...manifest, version, license, main,
    files: [main, patch, 'src/']
  };
  delete metadata.private;
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');

  const npmArgs = ['pack', '--ignore-scripts', '--offline', '--loglevel=error'];
  const options = { cwd: staging, encoding: 'utf8' };
  const npmCli = process.env.npm_execpath;
  const result = npmCli && path.basename(npmCli) === 'npm-cli.js'
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], options)
    : spawnSync(['npm', ...npmArgs].join(' '), { ...options, shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);

  const artifact = path.join(outputDirectory, archiveName);
  fs.renameSync(path.join(staging, archiveName), artifact);
  console.log(artifact);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
