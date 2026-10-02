'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fromControlResult, handleDshHook, resultLifecycle, toControlEvent } = require('../src/adapters/dsh-hooks.cjs');
const { analyzeDshTool, classifyDshTool, extractAffectedPaths, normalizePath } = require('../src/adapters/dsh-tool-classifier.cjs');
const { readState } = require('../src/state.cjs');

const root = path.join(__dirname, '..');

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-dsh-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

function start(session, options) {
  handleDshHook('session/created', { session: { id: session } }, options);
}

function prompt(session, text, turnId = 'turn-1') {
  return { session: { id: session }, prompt: text, turnId };
}

function pre(session, name, args, callId, cwd = root) {
  return {
    session: { id: session },
    exec: { name, arguments: args, callId },
    cwd
  };
}

test('DSH tool names map onto the shared mutability vocabulary', () => {
  assert.equal(classifyDshTool('read', { file_path: 'a.txt' }), 'read');
  assert.equal(classifyDshTool('glob', { pattern: '**' }), 'read');
  assert.equal(classifyDshTool('grep', { pattern: 'x' }), 'read');
  assert.equal(classifyDshTool('session_search', { query: 'x' }), 'read');
  assert.equal(classifyDshTool('web_fetch', { url: 'https://example.com' }), 'read');
  assert.equal(classifyDshTool('write', { file_path: 'a.txt', content: 'x' }), 'write');
  assert.equal(classifyDshTool('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }), 'write');
  assert.equal(classifyDshTool('str_replace_editor', { path: 'a.txt', command: 'view' }), 'write');
  assert.equal(classifyDshTool('todo_write', { todos: [] }), 'control');
  assert.equal(classifyDshTool('ask_user_question', {}), 'control');
  assert.equal(classifyDshTool('subagent', {}), 'delegate');
  assert.equal(classifyDshTool('spawn_teammate', { name: 'x' }), 'delegate');
  assert.equal(classifyDshTool('workflow', {}), 'delegate');
  // Terminal observation is a read; sending into a live terminal mutates it.
  assert.equal(classifyDshTool('terminal_read', { terminal_id: 't1' }), 'read');
  assert.equal(classifyDshTool('terminal_list', {}), 'read');
  assert.equal(classifyDshTool('terminal_send', { terminal_id: 't1', input: 'ls' }), 'write');
  // Shell classification follows the command, not the tool name.
  assert.equal(classifyDshTool('bash', { command: 'ls -la' }), 'read');
  assert.equal(classifyDshTool('bash', { command: 'rm -rf build' }), 'write');
  assert.equal(classifyDshTool('bash', { command: 'cat src/index.js' }), 'read');
});

test('DSH file paths normalize against the session workspace', () => {
  assert.equal(normalizePath('src/index.js', root), 'src/index.js');
  assert.equal(normalizePath(path.join(root, 'src', 'a.js'), root), 'src/a.js');
  assert.deepEqual(extractAffectedPaths('write', { file_path: 'src/a.js' }, root, 'write'), ['src/a.js']);
  assert.deepEqual(extractAffectedPaths('edit', { file_path: 'src/a.js' }, root, 'write'), ['src/a.js']);
  assert.deepEqual(extractAffectedPaths('read', { file_path: 'src/a.js' }, root, 'read'), []);
  assert.deepEqual(extractAffectedPaths('str_replace_editor', { path: 'src/a.js' }, root, 'write'), ['src/a.js']);
});

test('DSH dependency and hash intent follow the shared manifest rules', () => {
  const install = analyzeDshTool('bash', { command: 'npm install left-pad' }, root);
  assert.equal(install.dependencyIntent, true);
  const hash = analyzeDshTool('bash', { command: 'sha256sum file' }, root);
  assert.equal(hash.hashIntent, true);
  const plain = analyzeDshTool('read', { file_path: 'package.json' }, root);
  assert.equal(plain.hashIntent, false);
  assert.equal(plain.dependencyIntent, false);
});

test('Bad Case: a write outside the declared scope is denied', (t) => {
  const options = workspace(t);
  const session = 'dsh-scope-deny';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change files=src/** -- implement the parser'), options);
  const decision = handleDshHook(
    'tools/pre-execute',
    pre(session, 'write', { file_path: 'docs/other.md', content: 'x' }, 'call-1'),
    options
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /docs\/other\.md/);
  assert.match(decision.reason, /PATH_OUTSIDE_CONTRACT/);
});

test('Good Case: the requested write inside scope still proceeds', (t) => {
  const options = workspace(t);
  const session = 'dsh-scope-allow';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change files=src/** -- implement the parser'), options);
  const decision = handleDshHook(
    'tools/pre-execute',
    pre(session, 'write', { file_path: 'src/parser.js', content: 'x' }, 'call-1'),
    options
  );
  assert.equal(decision, null);
});

test('Requested result still completes: an in-scope read is never blocked', (t) => {
  const options = workspace(t);
  const session = 'dsh-read-allow';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit review files=src/** -- inspect the parser'), options);
  const decision = handleDshHook(
    'tools/pre-execute',
    pre(session, 'read', { file_path: 'src/parser.js' }, 'call-1'),
    options
  );
  assert.equal(decision, null);
});

test('DSH event translation produces a valid ControlEvent v2', () => {
  const start0 = toControlEvent('session/created', { session: { id: 's1' } });
  assert.equal(start0.kind, 'session.start');
  assert.equal(start0.protocolVersion, 2);
  assert.equal(start0.lifecycleVersion, 2);
  assert.equal(start0.host.family, 'deepseek-harness');

  const submitted = toControlEvent('agent/pre-step', prompt('s1', 'hello'));
  assert.equal(submitted.kind, 'prompt.submit');
  assert.equal(submitted.prompt, 'hello');

  const before = toControlEvent('tools/pre-execute', pre('s1', 'write', { file_path: 'a.txt', content: 'x' }, 'c1'));
  assert.equal(before.kind, 'action.before');
  assert.equal(before.action.name, 'write');
  assert.equal(before.action.mutability, 'write');
  assert.equal(before.action.id, 'c1');

  const ended = toControlEvent('session/disposed', { session: { id: 's1' } });
  assert.equal(ended.kind, 'session.end');
});

test('A delegated call without a call identity cannot be correlated', () => {
  const event = toControlEvent('tools/pre-execute', {
    session: { id: 's1' },
    exec: { name: 'subagent', arguments: {} }
  });
  assert.equal(event, null);
});

test('An unknown extension point is ignored rather than guessed', () => {
  assert.equal(toControlEvent('tools/execute', { session: { id: 's1' } }), null);
  assert.equal(toControlEvent('made/up', { session: { id: 's1' } }), null);
});

test('An event without a session identity is not translated', () => {
  // The harness always supplies a session, but a payload that lost it must not
  // be forced into an empty contract key.
  assert.equal(toControlEvent('session/created', {}), null);
  assert.equal(toControlEvent('session/created', { session: {} }), null);
  assert.equal(toControlEvent('tools/pre-execute', { exec: { name: 'write', arguments: {}, callId: 'c1' } }), null);
  assert.equal(toControlEvent('agent/pre-step', { prompt: 'hello' }), null);
});

test('Post-dispatch lifecycle facts do not claim child completion', () => {
  assert.equal(resultLifecycle({ result: { kind: 'deny' } }), 'not_started');
  assert.equal(resultLifecycle({ result: { kind: 'cancel' } }), 'not_started');
  // A blocked result and a thrown error mean the body ran without a usable
  // outcome. Neither proves the action completed.
  assert.equal(resultLifecycle({ result: { kind: 'block' } }), 'unknown');
  assert.equal(resultLifecycle({ result: { kind: 'error' } }), 'unknown');
  // An accepted call is not evidence that delegated children finished.
  assert.equal(resultLifecycle({ result: { kind: 'accept', value: { ok: true } } }), 'unknown');
  assert.equal(resultLifecycle({ result: { kind: 'accept', run_in_background: true } }), 'running');
  assert.equal(resultLifecycle({}), 'unknown');
});

test('send_message is flagged as an unproven delegation lifecycle', () => {
  const event = toControlEvent('tools/pre-execute', pre('s1', 'send_message', { target: 'lead', message: 'hi' }, 'c1'));
  assert.equal(event.action.delegationLifecycleUnproven, true);
});

test('Context is offered before dispatch but not after a settled result', () => {
  const context = { kind: 'context', text: 'reminder' };
  assert.deepEqual(fromControlResult('tools/pre-execute', context), context);
  assert.equal(fromControlResult('tools/post-execute', context), null);
  assert.equal(fromControlResult('subagent/end', context), null);
  assert.equal(fromControlResult('session/disposed', context), null);
  assert.equal(fromControlResult('tools/pre-execute', { kind: 'none' }), null);
  assert.equal(fromControlResult('tools/pre-execute', null), null);
});

test('A malformed directive denies the prompt instead of arming a contract', (t) => {
  const options = workspace(t);
  const session = 'dsh-prompt-error';
  start(session, options);
  const decision = handleDshHook(
    'agent/pre-step',
    prompt(session, '$stop-that-shit bogus=1 -- do the thing'),
    options
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /Unknown directive field/);
  // The error path returns before assigning a contract, so the session keeps
  // the unconfirmed default rather than arming a partial directive.
  const state = readState(session, options.dataDir);
  assert.equal(state.contract.mode, 'unconfirmed');
  assert.equal(state.directiveError.code, 'INVALID_DIRECTIVE_TOKEN');
});

test('Watch mode reports context rather than claiming mutations are blocked', (t) => {
  const options = workspace(t);
  const session = 'dsh-watch-mode';
  start(session, options);
  const decision = handleDshHook('agent/pre-step', prompt(session, 'fix the failing test'), options);
  assert.equal(decision.kind, 'context');
  assert.match(decision.text, /watch-only mode/);
});
