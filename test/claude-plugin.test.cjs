'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));

test('Claude plugin manifest uses default skills and hooks surfaces', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('.claude-plugin', 'plugin.json');
  assert.equal(manifest.name, 'stop-that-shit');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.skills, './skills/');
  // The standard hooks/hooks.json location is auto-loaded; manifest.hooks
  // must not re-declare it, or hosts reject the duplicate registration.
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.ok(fs.existsSync(path.join(root, 'hooks', 'stop-that-shit-claude.cjs')));
});

test('Claude hooks register only events every supported host accepts', () => {
  const config = readJson('hooks', 'hooks.json');
  assert.deepEqual(Object.keys(config.hooks).sort(), [
    'PreToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit'
  ]);
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        // Shell form (no args array) so hosts that only accept a command
        // string, such as cc-haha, still resolve the entrypoint.
        assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-that-shit-claude.cjs"');
        assert.equal(Object.hasOwn(hook, 'args'), false);
        assert.ok(hook.timeout > 0);
      }
    }
  }
});

test('local Claude marketplace points at the plugin root and leaves version to plugin.json', () => {
  const marketplace = readJson('.claude-plugin', 'marketplace.json');
  assert.equal(marketplace.name, 'stop-that-shit');
  assert.equal(marketplace.plugins[0].name, 'stop-that-shit');
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(Object.hasOwn(marketplace.plugins[0], 'version'), false);
});

test('Claude local install docs use an explicit relative marketplace path', () => {
  for (const file of ['README.md', 'README_EN.md', 'INSTALL.md', 'INSTALL_FOR_AGENTS.md']) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    const commands = (contents.match(/^\s*claude plugin marketplace add .*$/gm) || [])
      .map((command) => command.trim());
    assert.ok(commands.length > 0, `${file} must document the marketplace command`);
    assert.deepEqual([...new Set(commands)], ['claude plugin marketplace add ./']);
  }
});

test('Codex manifest keeps the original two-hook surface', () => {
  const manifest = readJson('.codex-plugin', 'plugin.json');
  const hooks = readJson('hooks', 'codex-hooks.json');
  assert.equal(manifest.hooks, './hooks/codex-hooks.json');
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PreToolUse', 'UserPromptSubmit']);
});

test('shared Skill documents both Claude Code and Codex invocation forms', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'stop-that-shit', 'SKILL.md'), 'utf8');
  assert.match(skill, /Claude Code/i);
  assert.match(skill, /\/stop-that-shit:stop-that-shit review/);
  assert.match(skill, /\$stop-that-shit review/);
  assert.match(skill, /works without the Guard/i);
});
