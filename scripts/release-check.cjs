#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'release-files.json');
const releaseManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const failures = [];

function fail(message) {
  failures.push(message);
}

function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
}

const forbiddenEntries = new Set([
  '0.0.1-ACCEPTANCE.md',
  'PRODUCT-SPEC.md',
  'RESEARCH.md',
  'THIRD_PARTY_NOTICES.md',
  'dist',
  'outputs',
  'work'
]);

for (const entry of releaseManifest.include) {
  if (forbiddenEntries.has(entry)) fail(`internal entry is allowlisted: ${entry}`);
  const absolute = path.resolve(root, entry);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    fail(`allowlisted path escapes the repository: ${entry}`);
  } else if (!fs.existsSync(absolute)) {
    fail(`allowlisted path is missing: ${entry}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const codexPlugin = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const claudePlugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
const claudeMarketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
const expectedVersion = packageJson.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  fail(`package version is not semver: ${expectedVersion}`);
}
if (expectedVersion !== codexPlugin.version) fail('package and Codex plugin versions differ');
if (expectedVersion !== claudePlugin.version) fail('package and Claude plugin versions differ');
if (!claudeMarketplace.plugins || claudeMarketplace.plugins[0]?.name !== claudePlugin.name || claudeMarketplace.plugins[0]?.source !== './') {
  fail('Claude marketplace does not point at the root plugin');
}
if (Object.hasOwn(claudeMarketplace.plugins?.[0] || {}, 'version')) {
  fail('Claude marketplace duplicates the plugin version; keep version in plugin.json only');
}

const openCodeEntrypoint = './opencode/stop-that-shit.mjs';
if (packageJson.main !== openCodeEntrypoint) fail('package main is not the OpenCode plugin entrypoint');
if (packageJson.exports?.['./server'] !== openCodeEntrypoint) {
  fail('package does not export the OpenCode server entrypoint');
}
if (!packageJson.files?.includes('opencode/') || !packageJson.files?.includes('src/')) {
  fail('package files omit the OpenCode plugin runtime');
}
if (!packageJson.engines?.opencode) fail('package does not declare its OpenCode engine');
if (!fs.existsSync(path.join(root, openCodeEntrypoint))) fail('OpenCode package entrypoint is missing');

const hermesPluginRoot = './.hermes-plugin';
const hermesManifest = './.hermes-plugin/plugin.yaml';
const hermesEntrypoint = './.hermes-plugin/__init__.py';
const hermesRuntime = './.hermes-plugin/runtime/stop-that-shit.cjs';
for (const hermesPath of [hermesManifest, hermesEntrypoint, hermesRuntime]) {
  if (!fs.existsSync(path.join(root, hermesPath))) {
    fail(`Hermes release path is missing: ${hermesPath}`);
  }
}
if (fs.existsSync(path.join(root, 'hooks', 'stop-that-shit-hermes.cjs'))) {
  fail('legacy Hermes Shell Hook entrypoint must be removed');
}
if (fs.existsSync(path.join(root, 'hooks', 'hermes-config.example.yaml'))) {
  fail('legacy Hermes Shell Hook config sample must be removed');
}
if (fs.existsSync(path.join(root, hermesPluginRoot, 'hooks'))) {
  fail('native Hermes plugin must not contain a hooks subdirectory');
}

const selectedFiles = releaseManifest.include.flatMap((entry) => walk(path.join(root, entry)));
const textExtensions = new Set(['', '.cjs', '.js', '.json', '.md', '.txt', '.yaml', '.yml']);
const staleVersion = /(?:v0\.1(?:\.\d+)?|0\.1\.1)/i;
const privatePath = /(?:[A-Za-z]:\\Users\\|[A-Za-z]:\\object\\|\/Users\/|\/home\/)/;
const mojibake = /(?:\uFFFD|\u9225|\u6E1F|\u951F)/;

for (const file of selectedFiles) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const relative = path.relative(root, file);
  const content = fs.readFileSync(file, 'utf8');
  if (staleVersion.test(content)) fail(`stale public version marker in ${relative}`);
  if (privatePath.test(content)) fail(`machine-specific path in ${relative}`);
  if (mojibake.test(content)) fail(`possible mojibake in ${relative}`);
}

const codexHooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'codex-hooks.json'), 'utf8'));
for (const groups of Object.values(codexHooks.hooks)) {
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (!hook.command.includes('process.env.PLUGIN_ROOT')) {
        fail('a Codex Hook command does not resolve from PLUGIN_ROOT');
      }
    }
  }
}
const claudeHooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
for (const groups of Object.values(claudeHooks.hooks)) {
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.type !== 'command') fail('a Claude Hook is not a command hook');
      if (hook.command !== 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-that-shit-claude.cjs"') {
        fail('a Claude Hook does not resolve its entrypoint from CLAUDE_PLUGIN_ROOT as a shell-form command');
      }
    }
  }
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS release allowlist (${selectedFiles.length} files, version ${expectedVersion}, multi-host)\n`);
}
