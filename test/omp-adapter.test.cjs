'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleOmpPrompt, handleOmpTool, handleOmpToolAfter, handleOmpLifecycle } = require('../src/adapters/omp-hooks.cjs');

function setup(t, directive = '$stop-that-shit review -- inspect the project') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-omp-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir };
  const context = { sessionId: 'omp-root', cwd: '/repo', mode: 'print' };
  handleOmpPrompt({ text: directive }, context, options);
  return { options, context };
}

function tool(toolCallId, toolName, input) {
  return { type: 'tool_call', toolCallId, toolName, input };
}

test('OMP manifest moves enforce dependency policy across all native edit transports', t => {
  const { context, options } = setup(t, '$stop-that-shit change deps=deny -- edit manifests');
  const transports = {
    apply_patch: (source, target, body) => ({ input: `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${target}\n@@\n${body}\n*** End Patch` }),
    patch: (source, target, body) => ({ path: source, edits: [{ op: 'update', rename: target, diff: body }] }),
    hashline: (source, target, body) => ({ input: `*** Begin Patch\n[${source}#abcd]\nPUT 1.=1:\n${body}\nMV ${target}\n*** End Patch` })
  };
  const addition = '+{"dependencies":{"demo":"1"}}';
  for (const [name, edit] of Object.entries(transports)) {
    const run = (id, input) => handleOmpTool(tool(`${name}-${id}`, 'edit', input), context, options);
    assert.equal(run('add', edit('package.json', 'config/package.json', addition)).decision?.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED', name);
    assert.equal(run('promote', edit('manifest.txt', 'package.json', addition)).decision?.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED', name);
    assert.equal(run('demote', edit('package.json', 'manifest.txt', addition)).kind, 'none');
    assert.equal(run('metadata', edit('package.json', 'config/package.json', '+{"name":"demo"}')).kind, 'none');
    if (name !== 'hashline') {
      assert.equal(run('unchanged', edit('package.json', 'config/package.json', ' {"dependencies":{"demo":"1"}}')).kind, 'none');
      assert.equal(run('remove', edit('package.json', 'config/package.json', '-{"dependencies":{"demo":"1"}}')).kind, 'none');
    }
  }
  handleOmpPrompt({ text: '$stop-that-shit change deps=allow -- authorize dependencies' }, context, options);
  for (const [name, edit] of Object.entries(transports)) {
    assert.equal(handleOmpTool(tool(`${name}-allow`, 'edit', edit('manifest.txt', 'package.json', addition)), context, options).kind, 'none');
  }
});

test('OMP manifest edits distinguish dependency additions from removals', t => {
  const { context, options } = setup(t, '$stop-that-shit change deps=deny -- remove a dependency');
  const call = (id, input) => handleOmpTool(tool(id, 'edit', input), context, options);
  assert.equal(call('remove', { path: 'requirements.txt', old_string: 'requests==2.32.0', new_string: '' }).kind, 'none');
  assert.equal(call('add', { path: 'requirements.txt', old_string: '', new_string: 'requests==2.32.0' }).kind, 'deny');
  assert.equal(call('cargo', { path: 'Cargo.toml', edits: [{ op: 'update', diff: ' [dependencies]\n+serde = "1"' }] }).kind, 'deny');
  assert.equal(call('cargo-remove', { path: 'Cargo.toml', edits: [{ op: 'update', diff: ' [dependencies]\n-serde = "1"' }] }).kind, 'none');
  assert.equal(call('patch', { input: '*** Begin Patch\n[requirements.txt#abcd]\nPUT >$:\n+requests==2.32.0\n*** End Patch' }).kind, 'deny');
});

test('OMP structured edits share the final rename destination across entries', t => {
  const { context, options } = setup(t, '$stop-that-shit change deps=deny -- edit manifests');
  const call = (id, source, target, renameFirst) => {
    const rename = { op: 'update', rename: target, diff: '@@\n {}' };
    const addition = { op: 'update', diff: '@@\n-{}\n+{"dependencies":{"demo":"1"}}' };
    return handleOmpTool(tool(id, 'edit', { path: source, edits: renameFirst ? [rename, addition] : [addition, rename] }), context, options);
  };
  assert.equal(call('before', 'manifest.txt', 'package.json', true).decision?.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
  assert.equal(call('after', 'manifest.txt', 'package.json', false).decision?.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
  assert.equal(call('out', 'package.json', 'manifest.txt', true).kind, 'none');
});

test('OMP anchored edits enforce file, dependency, and hash authority', t => {
  const { context, options } = setup(t, '$stop-that-shit change deps=deny hash=deny -- edit source');
  const edit = (id, input) => handleOmpTool(tool(id, 'edit', { input }), context, options);
  const replace = (file, oldText, newText) => `*** Edit File: ${file}\n*** Find\n${oldText}\n*** Replace\n${newText}`;
  assert.equal(edit('unbounded-dependency', replace('requirements.txt', 'requests', 'urllib3')).decision?.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
  assert.equal(edit('unbounded-hash', replace('a.js', 'return value;', 'return crypto.createHash("sha256");')).decision?.reasonCode, 'HASH_NOT_AUTHORIZED');
  handleOmpPrompt({ text: '$stop-that-shit change files=src/** deps=deny hash=deny -- edit source' }, context, options);
  assert.equal(edit('outside', replace('outside.js', 'old', 'next')).decision?.reasonCode, 'PATH_OUTSIDE_CONTRACT');
  assert.equal(edit('inside', replace('"src/file with spaces.js" all', 'old', 'next')).kind, 'none');
  assert.equal(edit('hash', replace('src/a.js', 'return value;', 'return crypto.createHash("sha256");')).decision?.reasonCode, 'HASH_NOT_AUTHORIZED');
  assert.equal(edit('remove-hash', replace('src/a.js', 'return crypto.createHash("sha256");', 'return value;')).kind, 'none');
  for (const action of ['Insert Before', 'Insert After']) {
    assert.equal(edit(action, `*** Edit File: src/requirements.txt\n*** Find\nrequests\n*** ${action}\nurllib3`).decision?.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
    assert.equal(edit(`${action}-comment`, `*** Edit File: src/requirements.txt\n*** Find\nrequests\n*** ${action}\n# note`).kind, 'none');
  }
  assert.equal(edit('remove-dependency', replace('src/requirements.txt', 'requests', '')).kind, 'none');
  const continuation = `${replace('src/requirements.txt', 'requests', '')}\n*** Edit File:\n*** Find\n# note\n*** Replace\nurllib3`;
  assert.equal(edit('continued', continuation.replace(/\n/g, '\r\n')).decision?.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
  const multi = `${replace('src/a.js', 'old', 'next')}\n${replace('outside.js', 'old', 'next')}`;
  assert.equal(edit('multi', multi).decision?.reasonCode, 'PATH_OUTSIDE_CONTRACT');
  handleOmpPrompt({ text: '$stop-that-shit change files=src/** deps=allow hash=allow -- authorize changes' }, context, options);
  assert.equal(edit('authorized', replace('src/requirements.txt', 'requests', 'urllib3')).kind, 'none');
  assert.equal(edit('authorized-hash', replace('src/a.js', 'return value;', 'return crypto.createHash("sha256");')).kind, 'none');
});

test('OMP review allows reading and glob searches but blocks writes before execution', t => {
  const { context, options } = setup(t);
  for (const name of ['read', 'glob']) {
    assert.equal(handleOmpTool(tool(name, name, { path: '/repo/source.txt' }), context, options).kind, 'none');
  }
  const blocked = handleOmpTool(tool('write-1', 'write', { path: '/repo/source.txt', content: 'changed' }), context, options);
  assert.equal(blocked.kind, 'deny');
  assert.match(blocked.message, /MODE_FORBIDS_MUTATION/);
});

test('OMP task reserves an entire batch and releases only confirmed finished children', t => {
  const { context, options } = setup(t, '$stop-that-shit change agents=2 -- implement the feature');
  const batch = tool('batch', 'task', { context: 'inspect sources', tasks: [{ task: 'read A' }, { task: 'read B' }] });
  assert.equal(handleOmpTool(batch, context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('over', 'task', { task: 'read C' }), context, options).kind, 'deny');
  handleOmpToolAfter({ ...batch, type: 'tool_result', content: [], isError: false,
    details: { results: [], async: { state: 'running', type: 'task', jobId: 'A' } } }, context, options);
  assert.equal(handleOmpTool(tool('still-over', 'task', { task: 'read C' }), context, options).kind, 'deny');
  handleOmpLifecycle({ id: 'A', parentToolCallId: 'batch', index: 0, status: 'started' }, context, options);
  handleOmpLifecycle({ id: 'B', parentToolCallId: 'batch', index: 1, status: 'started' }, context, options);
  handleOmpLifecycle({ id: 'A', parentToolCallId: 'batch', index: 0, status: 'completed' }, context, options);
  assert.equal(handleOmpTool(tool('next', 'task', { task: 'read C' }), context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('over-again', 'task', { task: 'read D' }), context, options).kind, 'deny');
});

test('OMP edit replacement text and rename destinations obey the existing policies', t => {
  const { context, options } = setup(t, '$stop-that-shit change files=src/** deps=deny -- fix code');
  assert.equal(handleOmpTool(tool('ok', 'edit', { path: 'src/a.js', old_string: 'a', new_string: 'b' }), context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('hash', 'edit', { path: 'src/a.js', old_string: 'a', new_string: 'crypto.createHash("sha256")' }), context, options).kind, 'deny');
  assert.equal(handleOmpTool(tool('rename', 'edit', { path: 'src/a.js', edits: [{ rename: 'outside.js', diff: '+b' }] }), context, options).kind, 'deny');
});

test('OMP finite limits allow collection but reject untracked eval and revival', t => {
  const { context, options } = setup(t, '$stop-that-shit change agents=1 -- fix code');
  for (const op of ['wait', 'inbox', 'list', 'jobs', 'ps', 'logs', 'describe', 'cancel', 'stop']) {
    assert.equal(handleOmpTool(tool(op, 'hub', { op }), context, options).kind, 'none');
  }
  for (const [name, input] of [['eval', { code: 'agent("work")' }], ['hub', { op: 'send', to: 'old', message: 'resume' }]]) {
    assert.equal(handleOmpTool(tool(name, name, input), context, options).kind, 'deny');
  }
});

test('OMP native agent messaging cannot revive untracked work through the write transport', t => {
  const { context, options } = setup(t, '$stop-that-shit change agents=1 -- implement');
  for (const target of ['agent://worker', 'agent://all']) {
    const denied = handleOmpTool(tool(target, 'write', { path: target, content: 'continue working' }), context, options);
    assert.equal(denied.kind, 'deny');
    assert.match(denied.message, /DELEGATION_LIFECYCLE_UNPROVEN/);
  }
  handleOmpPrompt({ text: '$stop-that-shit review agents=1 files=src/** -- inspect' }, context, options);
  assert.equal(handleOmpTool(tool('read-job', 'read', { path: 'proc://worker' }), context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('stop-job', 'write', { path: 'proc://worker/kill' }), context, options).kind, 'none');
  const unlimited = setup(t, '$stop-that-shit change -- authorized messaging without a finite limit');
  assert.equal(handleOmpTool(tool('allowed', 'write', { path: 'agent://worker', content: 'continue working' }), unlimited.context, unlimited.options).kind, 'none');
});

test('OMP read-only children can yield their result without granting write authority', t => {
  const { context, options } = setup(t);
  assert.equal(handleOmpTool(tool('done', 'yield', { message: 'review finished' }), context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('write', 'write', { path: 'a', content: 'x' }), context, options).kind, 'deny');
});

test('OMP abort retains capacity, terminal failure releases it, and late duplicates do not release new work', t => {
  const { context, options } = setup(t, '$stop-that-shit change agents=1 -- implement');
  const first = tool('first', 'task', { task: 'work' });
  assert.equal(handleOmpTool(first, context, options).kind, 'none');
  assert.equal(handleOmpTool(first, context, options).decision.reasonCode, 'DUPLICATE_ACTION_ID');
  const event = { id: 'A', parentToolCallId: 'first', status: 'aborted' };
  handleOmpLifecycle(event, context, options);
  assert.equal(handleOmpTool(tool('second', 'task', { task: 'work' }), context, options).kind, 'deny');
  handleOmpLifecycle({ ...event, status: 'failed' }, context, options);
  assert.equal(handleOmpTool(tool('second', 'task', { task: 'work' }), context, options).kind, 'none');
  handleOmpLifecycle({ ...event, status: 'completed' }, context, options);
  assert.equal(handleOmpTool(tool('third', 'task', { task: 'work' }), context, options).kind, 'deny');
});

test('OMP sync completion releases a batch while mixed async results retain unfinished slots', t => {
  const { context, options } = setup(t, '$stop-that-shit change agents=2 -- implement');
  const batch = tool('batch', 'task', { tasks: [{ task: 'a' }, { task: 'b' }] });
  handleOmpTool(batch, context, options);
  handleOmpLifecycle({ id: 'a', parentToolCallId: 'batch', status: 'completed' }, context, options);
  handleOmpToolAfter({ ...batch, type: 'tool_result', content: [], isError: false,
    details: { results: [{ id: 'a' }], async: { state: 'running' } } }, context, options);
  assert.equal(handleOmpTool(tool('too-many', 'task', { tasks: [{ task: 'c' }, { task: 'd' }] }), context, options).kind, 'deny');
  handleOmpLifecycle({ id: 'b', parentToolCallId: 'batch', status: 'completed' }, context, options);
  const sync = tool('sync', 'task', { tasks: [{ task: 'c' }, { task: 'd' }] });
  assert.equal(handleOmpTool(sync, context, options).kind, 'none');
  handleOmpToolAfter({ ...sync, type: 'tool_result', content: [], isError: false, details: { results: [{ id: 'c' }, { id: 'd' }] } }, context, options);
  assert.equal(handleOmpTool(tool('next', 'task', { tasks: [{ task: 'e' }, { task: 'f' }] }), context, options).kind, 'none');
});

for (const level of ['watch', 'off']) {
  test(`OMP ${level} activity remains counted after returning to guard`, t => {
    const { context, options } = setup(t, `$stop-that-shit change ${level} agents=0 -- implement`);
    assert.notEqual(handleOmpTool(tool('running', 'task', { task: 'work' }), context, options).kind, 'deny');
    handleOmpPrompt({ text: '$stop-that-shit change guard agents=1 -- implement' }, context, options);
    assert.equal(handleOmpTool(tool('next', 'task', { task: 'work' }), context, options).kind, 'deny');
    handleOmpLifecycle({ id: 'A', parentToolCallId: 'running', status: 'completed' }, context, options);
    assert.equal(handleOmpTool(tool('next', 'task', { task: 'work' }), context, options).kind, 'none');
  });
}

test('OMP root and nested call IDs occupy distinct reservations in the same budget', t => {
  const { context, options } = setup(t, '$stop-that-shit review agents=2 -- inspect');
  const child = { ...context, sessionId: 'child', rootSessionId: context.sessionId };
  const call = tool('same', 'task', { task: 'work' });
  assert.equal(handleOmpTool(call, context, options).kind, 'none');
  assert.equal(handleOmpTool(call, child, options).kind, 'none');
  handleOmpLifecycle({ id: 'A', parentToolCallId: 'same', status: 'completed' }, child, options);
  assert.equal(handleOmpTool(tool('next', 'task', { task: 'work' }), context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('over', 'task', { task: 'work' }), context, options).kind, 'deny');
});

test('OMP blank process name still identifies an agent message that can revive work', t => {
  const { context, options } = setup(t, '$stop-that-shit change agents=0 -- implement');
  assert.equal(handleOmpTool(tool('send', 'hub', { op: 'send', name: ' ', to: 'old', message: 'resume' }), context, options).kind, 'deny');
});

test('OMP patch deletion can remove a hash while adding one still requires authority', t => {
  const { context, options } = setup(t, '$stop-that-shit change hash=deny -- remove needless hash');
  const patch = diff => ({ path: 'a.js', edits: [{ op: 'update', diff }] });
  assert.equal(handleOmpTool(tool('remove', 'edit', patch('-crypto.createHash("sha256")\n+return value;')), context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('add', 'edit', patch('-return value;\n+crypto.createHash("sha256")')), context, options).kind, 'deny');
  assert.equal(handleOmpTool(tool('create', 'edit', { path: 'b.js', edits: [{ op: 'create', diff: 'crypto.createHash("sha256")' }] }), context, options).kind, 'deny');
  assert.equal(handleOmpTool(tool('increment', 'edit', patch('@@\n-return value;\n+++counter; crypto.createHash("sha256");')), context, options).kind, 'deny');
});

test('OMP hashline sections include move destinations and added code in policy checks', t => {
  const { context, options } = setup(t, '$stop-that-shit change files=src/** -- implement');
  const edit = text => ({ input: `*** Begin Patch\n[src/a.js#abcd]\n${text}\n*** End Patch` });
  assert.equal(handleOmpTool(tool('ok', 'edit', edit('PUT >$:\n+return value;')), context, options).kind, 'none');
  assert.equal(handleOmpTool(tool('move', 'edit', edit('MV outside.js')), context, options).kind, 'deny');
  assert.equal(handleOmpTool(tool('hash', 'edit', edit('PUT >$:\n+crypto.createHash("sha256");')), context, options).kind, 'deny');
});

test('OMP permitted untracked revival stays unproven after guard is re-enabled', t => {
  const { context, options } = setup(t, '$stop-that-shit change watch agents=0 -- implement');
  assert.equal(handleOmpTool(tool('send', 'hub', { op: 'send', name: ' ', to: 'old', message: 'resume' }), context, options).kind, 'context');
  handleOmpPrompt({ text: '$stop-that-shit change guard agents=1 -- implement' }, context, options);
  const denied = handleOmpTool(tool('next', 'task', { task: 'work' }), context, options);
  assert.equal(denied.kind, 'deny');
  assert.match(denied.message, /DELEGATION_STATE_UNPROVEN/);
});
