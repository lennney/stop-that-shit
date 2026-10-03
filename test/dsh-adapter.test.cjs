'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyDshDecision,
  fromControlResult,
  fromNativeEvent,
  handleDshHook,
  resultLifecycle,
  toControlEvent
} = require('../src/adapters/dsh-hooks.cjs');
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
  // The file editor classifies by its command: `view` observes, the rest write.
  assert.equal(classifyDshTool('str_replace_editor', { path: 'a.txt', command: 'view' }), 'read');
  assert.equal(classifyDshTool('str_replace_editor', { path: 'a.txt', command: 'create', file_text: 'x' }), 'write');
  assert.equal(classifyDshTool('str_replace_editor', { path: 'a.txt', command: 'str_replace', old_str: 'a', new_str: 'b' }), 'write');
  assert.equal(classifyDshTool('str_replace_editor', { path: 'a.txt', command: 'insert', insert_line: 1, new_str: 'b' }), 'write');
  assert.equal(classifyDshTool('todo_write', { todos: [] }), 'control');
  assert.equal(classifyDshTool('ask_user_question', {}), 'control');
  assert.equal(classifyDshTool('subagent', {}), 'delegate');
  // `subagent_fork` is the shipped alias of the same package.
  assert.equal(classifyDshTool('subagent_fork', {}), 'delegate');
  assert.equal(classifyDshTool('spawn_teammate', { name: 'x' }), 'delegate');
  assert.equal(classifyDshTool('workflow', {}), 'delegate');
  // `run_code` is the PTC transport: no workspace effect of its own, and its
  // nested calls are gated individually when the registry schedules them.
  assert.equal(classifyDshTool('run_code', { description: 'Read', code: 'return await tools.read({});' }), 'control');
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
  assert.deepEqual(
    extractAffectedPaths('str_replace_editor', { path: 'src/a.js', command: 'create', file_text: 'x' }, root, 'write'),
    ['src/a.js']
  );
  // A read-only `view` is not in the write boundary.
  assert.deepEqual(
    extractAffectedPaths('str_replace_editor', { path: 'src/a.js', command: 'view' }, root, 'read'),
    []
  );
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

test('A malformed directive rejects the prompt instead of arming a contract', (t) => {
  const options = workspace(t);
  const session = 'dsh-prompt-error';
  start(session, options);
  const decision = handleDshHook(
    'agent/pre-step',
    prompt(session, '$stop-that-shit bogus=1 -- do the thing'),
    options
  );
  // The harness pre-step decision is `{ kind: 'reject' }` with no reason field,
  // so the adapter keeps the message for the caller rather than emitting a
  // `deny` the waterfall would silently discard.
  assert.equal(decision.kind, 'reject');
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

test('A prompt denial is shaped by the point it is returned to', () => {
  // The same control result is rendered differently per waterfall: the tool
  // gate takes a typed deny, the pre-step gate takes a bare reject.
  assert.deepEqual(
    fromControlResult('tools/pre-execute', { kind: 'prompt-error', message: 'bad directive' }),
    { kind: 'deny', reason: 'bad directive' }
  );
  assert.deepEqual(
    fromControlResult('agent/pre-step', { kind: 'prompt-error', message: 'bad directive' }),
    { kind: 'reject', reason: 'bad directive' }
  );
});

// --- Regression coverage for the reviewed classification findings. ---

test('Regression: subagent_fork reserves capacity like subagent', (t) => {
  const options = workspace(t);
  const session = 'dsh-fork-alias';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change agents=0 -- delegate the work'), options);
  const viaCanonical = handleDshHook('tools/pre-execute', pre(session, 'subagent', {}, 'call-1'), options);
  const viaAlias = handleDshHook('tools/pre-execute', pre(session, 'subagent_fork', {}, 'call-2'), options);
  assert.equal(viaCanonical.kind, 'deny');
  assert.match(viaCanonical.reason, /AGENT_BUDGET_EXHAUSTED/);
  // The alias is the same package under a config-driven name, so it must not
  // slip past the budget the canonical name is held to.
  assert.equal(viaAlias.kind, 'deny');
  assert.match(viaAlias.reason, /AGENT_BUDGET_EXHAUSTED/);
});

test('Regression: the alias still proceeds when capacity is available', (t) => {
  const options = workspace(t);
  const session = 'dsh-fork-allowed';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change agents=2 -- delegate the work'), options);
  const decision = handleDshHook('tools/pre-execute', pre(session, 'subagent_fork', {}, 'call-1'), options);
  assert.equal(decision, null);
});

test('Regression: hash-bearing file writes are caught, ordinary ones are not', (t) => {
  const options = workspace(t);
  const session = 'dsh-hash-names';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change hash=deny -- update the source'), options);

  const shell = handleDshHook('tools/pre-execute', pre(session, 'bash', { command: 'sha256sum dist/a' }, 'call-1'), options);
  assert.equal(shell.kind, 'deny');

  const written = handleDshHook(
    'tools/pre-execute',
    pre(session, 'write', { file_path: 'src/hash.js', content: "const h = require('node:crypto').createHash('sha256');" }, 'call-2'),
    options
  );
  assert.equal(written.kind, 'deny');
  assert.match(written.reason, /HASH/);

  const edited = handleDshHook(
    'tools/pre-execute',
    pre(session, 'edit', { file_path: 'src/hash.js', old_string: 'const h = 1', new_string: "const h = require('node:crypto').createHash('sha256');" }, 'call-3'),
    options
  );
  assert.equal(edited.kind, 'deny');

  // An ordinary source change under the same contract still proceeds.
  const ordinary = handleDshHook(
    'tools/pre-execute',
    pre(session, 'write', { file_path: 'src/plain.js', content: 'export const a = 1;' }, 'call-4'),
    options
  );
  assert.equal(ordinary, null);
});

test('Regression: editor dependency additions are caught, metadata edits are not', (t) => {
  const options = workspace(t);
  const session = 'dsh-editor-deps';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change deps=deny -- keep the existing stack'), options);

  const baseline = handleDshHook(
    'tools/pre-execute',
    pre(session, 'write', { file_path: 'package.json', content: '{"dependencies":{"left-pad":"1.3.0"}}' }, 'call-1'),
    options
  );
  assert.equal(baseline.kind, 'deny');

  const created = handleDshHook(
    'tools/pre-execute',
    pre(session, 'str_replace_editor', { command: 'create', path: 'package.json', file_text: '{"dependencies":{"left-pad":"1.3.0"}}' }, 'call-2'),
    options
  );
  assert.equal(created.kind, 'deny');
  assert.match(created.reason, /DEPENDENCY_NOT_AUTHORIZED/);

  // An editor mutation that is not a dependency continues.
  const rename = handleDshHook(
    'tools/pre-execute',
    pre(session, 'str_replace_editor', { command: 'str_replace', path: 'package.json', old_str: '"name": "old"', new_str: '"name": "new"' }, 'call-3'),
    options
  );
  assert.equal(rename, null);
});

test('Regression: the editor view command is permitted under review', (t) => {
  const options = workspace(t);
  const session = 'dsh-editor-view';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit review -- inspect the documentation'), options);

  const baseline = handleDshHook('tools/pre-execute', pre(session, 'read', { file_path: 'README.md' }, 'call-1'), options);
  assert.equal(baseline, null, 'the equivalent read is permitted');

  const viewed = handleDshHook(
    'tools/pre-execute',
    pre(session, 'str_replace_editor', { command: 'view', path: 'README.md' }, 'call-2'),
    options
  );
  assert.equal(viewed, null, 'viewing a file is an observation, not a mutation');

  // A real editor mutation is still refused in review mode.
  const mutated = handleDshHook(
    'tools/pre-execute',
    pre(session, 'str_replace_editor', { command: 'str_replace', path: 'README.md', old_str: 'a', new_str: 'b' }, 'call-3'),
    options
  );
  assert.equal(mutated.kind, 'deny');
});

test('Regression: run_code does not block a read-only program before it runs', (t) => {
  const options = workspace(t);
  const session = 'dsh-run-code';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit review -- inspect the readme'), options);

  const transport = handleDshHook(
    'tools/pre-execute',
    pre(session, 'run_code', { description: 'Read README', code: 'return await tools.read({ file_path: "README.md" });' }, 'call-1'),
    options
  );
  assert.equal(transport, null, 'the transport is not refused before its nested read is examined');

  // The nested mutation is refused at its own gate, under its real tool name.
  const nested = handleDshHook(
    'tools/pre-execute',
    pre(session, 'write', { file_path: 'README.md', content: 'x' }, 'call-2'),
    options
  );
  assert.equal(nested.kind, 'deny');
});

// --- The native-to-adapter bridge required by the reviewed contract. ---

test('A native DSH event is normalized into the adapter payload', () => {
  // session/created hands the listener the Session itself.
  assert.deepEqual(fromNativeEvent('session/created', { id: 's1' }), { session: { id: 's1' } });
  assert.deepEqual(fromNativeEvent('session/disposed', { id: 's1' }), { session: { id: 's1' } });

  // agent/pre-step hands { agent, messages, turn, step, signal }.
  const preStep = fromNativeEvent('agent/pre-step', {
    agent: { session: { id: 's1' } },
    messages: [{ content: [{ type: 'text', text: 'hello' }] }],
    turn: 4,
    step: 1,
    signal: new AbortController().signal
  });
  assert.deepEqual(preStep, { session: { id: 's1' }, prompt: 'hello', turnId: 4 });

  // tools/pre-execute hands a ToolExecution with the session on its agent.
  const preExec = fromNativeEvent('tools/pre-execute', {
    name: 'write',
    arguments: { file_path: 'src/a.ts', content: 'x' },
    callId: 'call-1',
    agent: { session: { id: 's1' } }
  });
  assert.deepEqual(preExec.exec.name, 'write');
  assert.equal(preExec.exec.callId, 'call-1');
  assert.equal(preExec.session.id, 's1');

  // An unmapped point is ignored rather than half-translated.
  assert.equal(fromNativeEvent('tools/execute', { name: 'write' }), null);
  assert.equal(fromNativeEvent('made/up', {}), null);
});

test('The normalized native event drives the same decision as the raw payload', (t) => {
  const options = workspace(t);
  const session = 'dsh-native-bridge';
  start(session, options);

  const normalized = fromNativeEvent('agent/pre-step', {
    agent: { session: { id: session } },
    messages: [{ content: [{ type: 'text', text: '$stop-that-shit change files=src/** -- implement' }] }],
    turn: 1
  });
  handleDshHook('agent/pre-step', normalized, options);
  assert.equal(readState(session, options.dataDir).contract.mode, 'change');

  const denied = handleDshHook(
    'tools/pre-execute',
    fromNativeEvent('tools/pre-execute', {
      name: 'write',
      arguments: { file_path: 'docs/other.md', content: 'x' },
      callId: 'call-1',
      agent: { session: { id: session } }
    }),
    options
  );
  assert.equal(denied.kind, 'deny');
});

test('A raw native payload is not silently accepted', () => {
  // Passing the host object straight through yields nothing, which is why the
  // bridge exists. This guards against a future "just accept both" shortcut
  // that would treat a missing prompt as an empty one.
  assert.equal(toControlEvent('agent/pre-step', { agent: { session: { id: 's1' } }, messages: [], turn: 1 }), null);
});

test('An intermediate result is translated into the native decision', async () => {
  let delegated = 0;
  const next = async () => { delegated += 1; return { kind: 'enter', messages: [] }; };

  // null delegates unchanged.
  assert.deepEqual(await applyDshDecision('tools/pre-execute', null, next), { kind: 'enter', messages: [] });
  assert.equal(delegated, 1);

  // A tool denial becomes the typed PreToolDecision.
  const denial = await applyDshDecision('tools/pre-execute', { kind: 'deny', reason: 'out of scope' }, next);
  assert.deepEqual(denial, { kind: 'deny', reason: 'out of scope' });
  assert.equal(delegated, 1, 'a blocking decision must not delegate');

  // A prompt rejection becomes the bare PreStepDecision, and the reason is
  // handed to the plugin because the loop cannot carry it.
  const seen = [];
  const rejected = await applyDshDecision(
    'agent/pre-step',
    { kind: 'reject', reason: 'Unknown directive field' },
    next,
    (info) => { seen.push(info); }
  );
  assert.deepEqual(rejected, { kind: 'reject' });
  assert.equal(seen[0].kind, 'reason');
  assert.match(seen[0].text, /Unknown directive field/);

  // Context preserves the downstream decision instead of replacing it.
  const downstream = { kind: 'enter', messages: ['kept'] };
  const withContext = await applyDshDecision(
    'agent/pre-step',
    { kind: 'context', text: 'reminder' },
    async () => downstream,
    (info) => (info.kind === 'context' ? { ...downstream, messages: [...info.downstream.messages, info.text] } : downstream)
  );
  assert.deepEqual(withContext.messages, ['kept', 'reminder']);

  // Without a context sink the downstream decision passes through unchanged.
  assert.deepEqual(
    await applyDshDecision('agent/pre-step', { kind: 'context', text: 'reminder' }, async () => downstream),
    downstream
  );
});

test('A tool call with no calling agent is not translated', () => {
  // The loop always sets `agent` on a root call and the PTC transport threads
  // it down, so a model-initiated call always has a session. A direct
  // ctx.tools.execute() without one has no session identity and is not gated;
  // the contract records this so a deployment does not assume otherwise.
  const payload = fromNativeEvent('tools/pre-execute', { name: 'write', arguments: { file_path: 'a' }, callId: 'c1' });
  assert.equal(payload.session.id, '');
  assert.equal(toControlEvent('tools/pre-execute', payload), null);
});

test('Regression: agent messaging is not treated as a file write', (t) => {
  const options = workspace(t);
  const session = 'dsh-send-message';
  start(session, options);
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change files=src/** -- implement and report'), options);

  // `send_message` delivers a message and writes nothing. The generic name
  // heuristic matches `send` and would demand a proven path on every status
  // update, refusing routine delegation chatter.
  const status = handleDshHook(
    'tools/pre-execute',
    pre(session, 'send_message', { agent_id: 'lead', message: 'parser done' }, 'call-1'),
    options
  );
  assert.equal(status, null);

  // A real write under the same contract is still gated.
  const write = handleDshHook(
    'tools/pre-execute',
    pre(session, 'write', { file_path: 'docs/other.md', content: 'x' }, 'call-2'),
    options
  );
  assert.equal(write.kind, 'deny');
});

test('Regression: read-only navigation and the Ralph loop classify correctly', (t) => {
  const options = workspace(t);
  const session = 'dsh-nav-and-ralph';
  start(session, options);

  // Every documented lsp operation is a navigation query.
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit review -- inspect the code'), options);
  const navigation = handleDshHook(
    'tools/pre-execute',
    pre(session, 'lsp', { operation: 'goToDefinition', line: 1, character: 1 }, 'call-1'),
    options
  );
  assert.equal(navigation, null, 'lsp navigation is an observation');

  // ralph opens a fresh child per round, so it must reserve capacity.
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit change agents=0 -- run the loop', 'turn-2'), options);
  const loop = handleDshHook('tools/pre-execute', pre(session, 'ralph', { objective: 'converge' }, 'call-2'), options);
  assert.equal(loop.kind, 'deny');
  assert.match(loop.reason, /AGENT_BUDGET_EXHAUSTED/);
});

// --- Coverage for the independent review findings. ---

test('The post-execute bridge accepts the waterfall\'s (exec, result) pair', () => {
  // The harness hands post-dispatch listeners (exec, result, next). The result
  // is a separate argument, so reading it off the execution silently yields an
  // empty action.after fact.
  const exec = { name: 'write', arguments: {}, callId: 'c1', agent: { session: { id: 's1' } } };
  const payload = fromNativeEvent('tools/post-execute', exec, { result: { kind: 'deny' } });
  assert.equal(payload.session.id, 's1');
  assert.equal(payload.exec.callId, 'c1');
  assert.deepEqual(payload.result, { kind: 'deny' });

  const event = toControlEvent('tools/post-execute', payload);
  assert.equal(event.kind, 'action.after');
  assert.equal(event.action.id, 'c1');
  // A denied call never reached the tool body.
  assert.equal(event.action.lifecycle, 'not_started');
});

test('The subagent bridge files against the parent session and keeps the child id', () => {
  // The native run info is flat { runId, provider, id, local } and carries no
  // parent session, so the parent must be supplied by the caller.
  const info = { runId: 'r1', provider: 'in-process', id: 'child-1', local: true };
  const payload = fromNativeEvent('subagent/start', info, { sessionId: 'parent-1' });
  assert.equal(payload.session.id, 'parent-1');
  assert.equal(payload.agentId, 'child-1');

  const event = toControlEvent('subagent/start', payload);
  assert.equal(event.kind, 'subagent.start');
  assert.equal(event.sessionId, 'parent-1');
  assert.equal(event.agentId, 'child-1');
});

test('A subagent fact without a parent session is not translated', () => {
  // Filing it under the child id would create an orphan contract key that the
  // parent ledger never sees.
  const info = { runId: 'r1', id: 'child-1' };
  const payload = fromNativeEvent('subagent/start', info);
  assert.equal(toControlEvent('subagent/start', payload), null);
});

test('A numeric harness turn survives translation', () => {
  // The harness counts turns numerically; a number must not silently become
  // null on the way through the identifier helper.
  const payload = fromNativeEvent('agent/pre-step', {
    agent: { session: { id: 's1' } },
    messages: [{ content: [{ type: 'text', text: 'hello' }] }],
    turn: 4
  });
  assert.equal(toControlEvent('agent/pre-step', payload).turnId, '4');
});

test('A renamed tool cannot fall out of the explicit sets', () => {
  // The registered name is configurable, so matching must not be case-sensitive
  // or a renamed delegation tool would stop reserving capacity.
  for (const name of ['SUBAGENT', 'Subagent_Fork', 'Ralph', 'WORKFLOW', 'Spawn_Teammate']) {
    assert.equal(classifyDshTool(name, {}), 'delegate', name);
  }
  assert.equal(classifyDshTool('Run_Code', { description: 'x', code: 'y' }), 'control');
  assert.equal(classifyDshTool('LSP', { operation: 'hover' }), 'read');
});

test('plugin_manager is classified by its action, not its name', (t) => {
  const options = workspace(t);
  const session = 'dsh-plugin-manager';
  start(session, options);

  // A list action only observes.
  handleDshHook('agent/pre-step', prompt(session, '$stop-that-shit review -- inspect the profile'), options);
  const listed = handleDshHook(
    'tools/pre-execute',
    pre(session, 'plugin_manager', { action: 'list_plugins' }, 'call-1'),
    options
  );
  assert.equal(listed, null);

  // Installing executes build scripts and persists across sessions, so it is a
  // mutation and must not pass a read-only contract.
  const installed = handleDshHook(
    'tools/pre-execute',
    pre(session, 'plugin_manager', { action: 'install_bundle', target: 'some-bundle' }, 'call-2'),
    options
  );
  assert.equal(installed.kind, 'deny');

  // An unrecognized action fails closed rather than reading as a list.
  const unknown = handleDshHook(
    'tools/pre-execute',
    pre(session, 'plugin_manager', {}, 'call-3'),
    options
  );
  assert.ok(unknown === null || unknown.kind === 'deny' || unknown.kind === 'require_user_approval');
});

test('applyDshDecision never returns a deny at the pre-step gate', async () => {
  // PreStepDecision is reject | enter; a deny forwarded here would be invalid.
  const seen = [];
  const decision = await applyDshDecision(
    'agent/pre-step',
    { kind: 'deny', reason: 'out of scope' },
    async () => ({ kind: 'enter', messages: [] }),
    (info) => { seen.push(info); }
  );
  assert.deepEqual(decision, { kind: 'reject' });
  assert.equal(seen[0].kind, 'reason');
  assert.match(seen[0].text, /out of scope/);
});

test('get_goal is classified once, as a read', () => {
  assert.equal(classifyDshTool('get_goal', {}), 'read');
});
