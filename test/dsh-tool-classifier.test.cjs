'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeDshTool } = require('../src/adapters/dsh-tool-classifier.cjs');
const { decide } = require('../src/decision.cjs');

function decideTool(contract, name, input, cwd = '/repo') {
  return decide({
    contract: { level: 'lock', ...contract },
    action: { cwd, ...analyzeDshTool(name, input, cwd) }
  });
}

test('DSH review blocks scheduled-task mutations and lets schedule inspection continue', () => {
  const contract = { mode: 'review' };
  const mutations = [
    ['schedule_create', { title: 'Review logs' }],
    ['schedule_edit', { id: 'review', action: 'update', active: false }],
    ['schedule_edit', { id: 'review', action: 'delete' }],
    ['schedule_update', { id: 'review' }],
    ['schedule_delete', { id: 'review' }]
  ];
  for (const [name, input] of mutations) {
    assert.equal(decideTool(contract, name, input).reasonCode, 'MODE_FORBIDS_MUTATION', name);
  }
  assert.equal(decideTool(contract, 'schedule_list', {}).outcome, 'allow');
  assert.equal(decideTool(contract, 'schedule_view', { id: 'review' }).outcome, 'allow');

  const fileContract = { mode: 'change', allowedPaths: ['docs/**'] };
  assert.equal(decideTool(fileContract, 'schedule_create', {
    title: 'Review logs', file_path: 'docs/report.md'
  }).reasonCode, 'WRITE_PATH_UNPROVEN');
  assert.equal(decideTool({ mode: 'change' }, 'schedule_create', { title: 'Review logs' }).outcome, 'allow');
});

test('DSH review permits market listings and still blocks plugin installs', () => {
  const contract = { mode: 'review' };
  for (const action of ['list_indexes', 'list_plugins', 'list_versions']) {
    assert.equal(decideTool(contract, 'plugin_market', { action }).outcome, 'allow', action);
  }
  assert.equal(decideTool(contract, 'plugin_market', { action: 'new_action' }).reasonCode, 'MUTABILITY_UNPROVEN');
  assert.equal(decideTool(contract, 'plugin_manager', {
    action: 'install_bundle', target: 'example'
  }).reasonCode, 'MODE_FORBIDS_MUTATION');
});

test('DSH native patch scope includes indented headers and both move paths', () => {
  const contract = { mode: 'change', allowedPaths: ['docs/**'] };
  const add = [
    '*** Begin Patch',
    '*** Add File: docs/note.md',
    '+hello',
    '  *** Add File: src/extra.js',
    '+outside',
    '*** End Patch'
  ].join('\r\n');
  assert.equal(decideTool(contract, 'apply_patch', { input: add }).reasonCode, 'PATH_OUTSIDE_CONTRACT');
  assert.equal(decideTool(contract, 'apply_patch', { input: add.replace('src/extra.js', 'docs/extra.md') }).outcome, 'allow');

  const move = [
    '*** Begin Patch',
    '*** Update File: docs/note.md',
    '*** Move to: src/note.md',
    '@@',
    ' *** Add File: src/example.js',
    '-hello',
    '+welcome',
    '*** End Patch'
  ].join('\n');
  assert.deepEqual(analyzeDshTool('apply_patch', { input: move }, '/repo').affectedPaths, ['docs/note.md', 'src/note.md']);
  assert.equal(decideTool(contract, 'apply_patch', { input: move }).reasonCode, 'PATH_OUTSIDE_CONTRACT');
  assert.equal(decideTool(contract, 'apply_patch', { input: move.replace('src/note.md', 'docs/new.md') }).outcome, 'allow');
});

test('DSH patch inputs share dependency and hash rules across native and legacy shapes', () => {
  const contract = { mode: 'change', hashPolicy: 'deny', dependencyPolicy: 'deny' };
  const dependency = [
    '*** Begin Patch',
    '  *** Add File: package.json',
    '+{"dependencies":{"example":"1.0.0"}}',
    '*** End Patch'
  ].join('\n');
  const metadata = dependency.replace('{"dependencies":{"example":"1.0.0"}}', '{"name":"demo"}');
  const hash = [
    '*** Begin Patch',
    '*** Add File: src/demo.js',
    '+createHash("sha256");',
    '*** End Patch'
  ].join('\n');
  const ordinaryCode = hash.replace('createHash("sha256");', 'console.log("demo");');
  for (const input of [dependency, { patch: dependency }, { input: dependency }, { input: dependency, patch: metadata }]) {
    assert.equal(decideTool(contract, 'apply_patch', input).reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
  }
  assert.equal(decideTool(contract, 'apply_patch', { input: metadata }).outcome, 'allow');
  assert.equal(decideTool(contract, 'apply_patch', { input: hash }).reasonCode, 'HASH_NOT_AUTHORIZED');
  assert.equal(decideTool(contract, 'apply_patch', { input: ordinaryCode }).outcome, 'allow');
});

test('DSH literal filenames retain quotes and distinguish Windows separators from POSIX backslashes', () => {
  const contract = { mode: 'change', allowedPaths: ['docs/**'] };
  const writes = [
    ['write', { content: 'hi' }, 'file_path'],
    ['edit', { old_string: 'hi', new_string: 'hello' }, 'file_path'],
    ['str_replace_editor', { command: 'create', file_text: 'hi' }, 'path']
  ];
  for (const [name, input, pathField] of writes) {
    assert.equal(decideTool(contract, name, { ...input, [pathField]: "'docs/note.md'" }).reasonCode, 'PATH_OUTSIDE_CONTRACT');
    assert.equal(decideTool(contract, name, { ...input, [pathField]: 'docs\\note.md' }).reasonCode, 'WRITE_PATH_UNPROVEN');
    assert.equal(decideTool(contract, name, { ...input, [pathField]: 'docs/note.md' }).outcome, 'allow');
    assert.equal(decideTool(contract, name, { ...input, [pathField]: 'docs\\note.md' }, 'C:\\repo').outcome, 'allow');
  }

  const patch = [
    '*** Begin Patch',
    '*** Add File: docs/note.md',
    '+hello',
    '*** Add File: docs\\extra.md',
    '+outside on POSIX',
    '*** End Patch'
  ].join('\n');
  assert.equal(decideTool(contract, 'apply_patch', { input: patch }).reasonCode, 'WRITE_PATH_UNPROVEN');
  assert.equal(decideTool(contract, 'apply_patch', { input: patch }, 'C:\\repo').outcome, 'allow');
});
