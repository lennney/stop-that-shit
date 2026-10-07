import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Effect, Exit, PubSub, Scope, Stream } from 'effect';
import * as entry from '../opencode/stop-that-shit.mjs';
import { acquireSessionLock, statePath } from '../src/state.cjs';

async function host(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-opencode-v2-'));
  const scope = Scope.makeUnsafe();
  const hooks = { session: {}, tool: {} };
  const storage = new Map();
  const events = await Effect.runPromise(PubSub.unbounded());
  const sessions = new Map([['root', { id: 'root', location: { directory: '/repo' }, agent: 'build' }]]);
  const messages = new Map([['root', []]]);
  const run = (effect) => Effect.runPromise(Effect.provideService(effect, Scope.Scope, scope));
  const ctx = {
    options: { dataDir }, location: { directory: '/plugin' },
    storage: {
      get: (key) => Effect.sync(() => storage.get(key)),
      set: (key, value) => Effect.sync(() => { storage.set(key, value); }),
      remove: (key) => Effect.sync(() => { storage.delete(key); }),
    },
    session: {
      get: ({ sessionID }) => Effect.sync(() => sessions.get(sessionID)),
      context: ({ sessionID }) => Effect.sync(() => messages.get(sessionID) || []),
      hook: (name, callback) => Effect.sync(() => { hooks.session[name] = callback; }),
    },
    tool: { hook: (name, callback) => Effect.sync(() => { hooks.tool[name] = callback; }) },
    event: { subscribe: () => Stream.fromPubSub(events) },
    agent: { get: () => Effect.succeed({ data: { permissions: [{ action: '*', resource: '*', effect: 'allow' }] } }) },
  };
  t.after(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.equal(typeof entry.default?.effect, 'function');
  await run(entry.default.effect(ctx));
  return { ctx, hooks, run, messages, sessions, storage, dataDir,
    emit: async (event) => { await run(PubSub.publish(events, event)); await run(Effect.sleep('20 millis')); },
  };
}

const write = (id = 'call-write', sessionID = 'root', file = '/repo/a.txt') => ({
  tool: 'write', id, sessionID, agent: 'build', messageID: 'assistant-1', input: { path: file, content: 'hello' },
});
const user = (id, text) => ({ type: 'user', id, text, time: { created: 1 } });

test('V2 ordinary tool results return watch context without rewriting session state', async t => {
  const h = await host(t);
  h.messages.get('root').push(user('u1', '$stop-that-shit watch review'));
  const call = write();
  await h.run(h.hooks.tool['execute.before'](call));
  const file = statePath('root', h.dataDir);
  const before = fs.readFileSync(file, 'utf8');
  const release = acquireSessionLock('root', h.dataDir);
  const result = { ...call, status: 'completed', result: { content: 'written' } };
  try {
    await h.run(h.hooks.tool['execute.after'](result));
    assert.match(result.result.content, /WATCH/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    release();
  }
});

test('V2 rejects review writes as a typed tool error, then permits an explicit change', async (t) => {
  const h = await host(t);
  h.messages.get('root').push(user('msg_001', '$stop-that-shit review'));
  const denied = await h.run(Effect.result(h.hooks.tool['execute.before'](write())));
  assert.equal(denied._tag, 'Failure');
  assert.equal(denied.failure._tag, 'Tool.Error');
  assert.match(denied.failure.message, /MODE_FORBIDS_MUTATION/);
  h.messages.get('root').push(user('msg_002', '$stop-that-shit change'));
  await h.run(h.hooks.tool['execute.before'](write('call-allowed')));
});

test('V2 uses native shell, patch and subagent inputs while preserving file and agent bounds', async (t) => {
  const h = await host(t);
  h.messages.get('root').push(user('msg_001', '$stop-that-shit change files=** agents=1 deps=deny'));
  const before = (tool, input, id = tool) => h.run(Effect.result(h.hooks.tool['execute.before']({ ...write(id), tool, input })));
  assert.equal((await before('shell', { command: 'git status', workdir: '/repo' }))._tag, 'Success');
  assert.match((await before('shell', { command: 'npm install example' })).failure.message, /DEPENDENCY/);
  h.messages.get('root').push(user('msg_002', '$stop-that-shit change files=src/** agents=1 deps=deny'));
  assert.equal((await before('patch', { patchText: '*** Begin Patch\n*** Add File: src/a.txt\n+ok\n*** End Patch' }))._tag, 'Success');
  assert.match((await before('patch', { patchText: '*** Begin Patch\n*** Add File: other.txt\n+no\n*** End Patch' })).failure.message, /PATH/);
  assert.equal((await before('subagent', { agent: 'general', prompt: 'read', description: 'read' }, 'launch-1'))._tag, 'Success');
  assert.match((await before('subagent', { agent: 'general', prompt: 'read', description: 'read' }, 'launch-2')).failure.message, /AGENT/);
});

test('V2 reconciles joined and background subagents without treating shutdown as completion', async (t) => {
  const h = await host(t);
  h.messages.get('root').push(user('msg_001', '$stop-that-shit change agents=1'));
  const call = (id) => ({ ...write(id), tool: 'subagent', input: { agent: 'general', prompt: 'read', description: 'read' } });
  await h.run(h.hooks.tool['execute.before'](call('first')));
  assert.equal(typeof h.hooks.tool['execute.after'], 'function');
  await h.run(h.hooks.tool['execute.after']({ ...call('first'), status: 'completed', result: { output: { sessionID: 'child1', status: 'completed', output: 'done' } } }));
  await h.run(h.hooks.tool['execute.before'](call('second')));
  h.sessions.set('child2', { id: 'child2', parentID: 'root', location: { directory: '/repo' } });
  await h.run(h.hooks.tool['execute.after']({ ...call('second'), status: 'completed', result: { output: { sessionID: 'child2', status: 'running', output: 'running' } } }));
  await h.emit({ type: 'session.execution.interrupted', data: { sessionID: 'child2', reason: 'shutdown' } });
  assert.equal((await h.run(Effect.result(h.hooks.tool['execute.before'](call('third')))))._tag, 'Failure');
  await h.emit({ type: 'session.execution.succeeded', data: { sessionID: 'child2' } });
  await h.run(h.hooks.tool['execute.before'](call('third')));
});

test('V2 only accepts delivered root user directives and retains invalid directives across reload', async (t) => {
  const h = await host(t);
  h.messages.get('root').push(user('msg_001', '$stop-that-shit review'));
  const before = (sessionID = 'root') => h.run(Effect.result(h.hooks.tool['execute.before'](write('write', sessionID))));
  assert.equal((await before())._tag, 'Failure');
  if (h.hooks.session.prompt) await h.run(h.hooks.session.prompt({ sessionID: 'root', messageID: 'msg_002', prompt: { text: '$stop-that-shit change' }, delivery: 'queue' }));
  h.messages.get('root').push({ ...user('msg_003', '$stop-that-shit change'), type: 'synthetic' });
  h.sessions.set('child', { id: 'child', parentID: 'root', location: { directory: '/other' } });
  h.messages.set('child', [user('msg_004', '$stop-that-shit change')]);
  assert.equal((await before('child'))._tag, 'Failure');
  h.messages.get('root').push(user('msg_005', '$stop-that-shit change agents=banana'));
  assert.match((await before()).failure.message, /directive rejected/);
  await h.run(entry.default.effect(h.ctx));
  assert.match((await before('child')).failure.message, /directive rejected/);
  h.messages.get('root').push(user('msg_006', '$stop-that-shit change agents=0'));
  assert.equal((await before())._tag, 'Success');
});

test('V2 follows an editable host agent for a new plain root prompt but not a quoted directive', async (t) => {
  const h = await host(t);
  const before = () => h.run(Effect.result(h.hooks.tool['execute.before'](write())));
  h.messages.get('root').push(user('msg_001', '$stop-that-shit review'));
  assert.equal((await before())._tag, 'Failure');
  h.messages.get('root').push(user('msg_002', 'Explain `$stop-that-shit change` to me.'));
  assert.equal((await before())._tag, 'Failure');
  h.messages.get('root').push(user('msg_003', 'Now implement the fix.'));
  assert.equal((await before())._tag, 'Success');
});

test('V2 follows session permission overrides when inferring editable host mode', async (t) => {
  const h = await host(t);
  const before = () => h.run(Effect.result(h.hooks.tool['execute.before'](write())));
  h.messages.get('root').push(user('msg_001', '$stop-that-shit review'));
  assert.equal((await before())._tag, 'Failure');
  h.sessions.get('root').permissions = [{ action: 'edit', resource: '*', effect: 'deny' }];
  h.messages.get('root').push(user('msg_002', 'Continue checking.'));
  assert.equal((await before())._tag, 'Failure');
  h.ctx.agent.get = () => Effect.succeed({ data: { permissions: [{ action: '*', resource: '*', effect: 'deny' }] } });
  h.sessions.get('root').permissions = [{ action: 'edit', resource: '*', effect: 'allow' }];
  h.messages.get('root').push(user('msg_003', 'Implement the fix.'));
  assert.equal((await before())._tag, 'Success');
});

test('V2 consumes delivered messages in context order when IDs are not monotonic across compaction', async (t) => {
  const h = await host(t);
  const before = () => h.run(Effect.result(h.hooks.tool['execute.before'](write())));
  h.messages.get('root').push(user('msg_003', '$stop-that-shit change'));
  assert.equal((await before())._tag, 'Success');
  h.messages.set('root', [user('msg_002', '$stop-that-shit review')]);
  assert.equal((await before())._tag, 'Failure');
  await h.run(entry.default.effect(h.ctx));
  h.messages.get('root').push(user('msg_003', '$stop-that-shit change'));
  assert.equal((await before())._tag, 'Failure', 'Already delivered directives must not replay after reload');
  h.messages.get('root').push(user('msg_001', '$stop-that-shit change'));
  assert.equal((await before())._tag, 'Success');
});

test('V2 keeps an unrelated root responsive while another root waits for context', async (t) => {
  const h = await host(t);
  h.sessions.set('other', { id: 'other', location: { directory: '/repo' }, agent: 'build' });
  h.messages.set('other', [user('other-1', '$stop-that-shit review')]);
  h.messages.get('root').push(user('root-1', '$stop-that-shit change'));
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  h.ctx.session.context = ({ sessionID }) => sessionID === 'root'
    ? Effect.promise(async () => { entered(); await blocked; return h.messages.get('root'); })
    : Effect.succeed(h.messages.get(sessionID));
  const first = h.run(h.hooks.tool['execute.before'](write('slow')));
  await started;
  try {
    const other = await h.run(Effect.result(h.hooks.tool['execute.before'](write('fast', 'other'))).pipe(
      Effect.timeout('1 second'),
    ));
    assert.equal(other._tag, 'Failure');
    assert.match(other.failure.message, /MODE_FORBIDS_MUTATION/);
  } finally {
    release();
    await first;
  }
});

test('V2 refreshes permissions after waiting for another hook in the same root', async (t) => {
  const h = await host(t);
  h.messages.get('root').push(user('u1', '$stop-that-shit review'));
  await h.run(Effect.result(h.hooks.tool['execute.before'](write())));
  let entered, release, secondResolved;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const queued = new Promise(resolve => { secondResolved = resolve; });
  let contexts = 0;
  h.ctx.session.get = ({ sessionID }) => Effect.sync(() => {
    if (contexts === 1) secondResolved();
    return structuredClone(h.sessions.get(sessionID));
  });
  h.ctx.session.context = () => Effect.promise(async () => {
    if (++contexts === 1) { const snapshot = [...h.messages.get('root')]; entered(); await blocked; return snapshot; }
    return h.messages.get('root');
  });
  const first = h.run(Effect.result(h.hooks.tool['execute.before'](write('first'))));
  await started;
  const second = h.run(Effect.result(h.hooks.tool['execute.before'](write('second'))));
  // Initial lookup of the second hook happens before it waits on the root.
  await queued;
  h.sessions.get('root').permissions = [{ action: 'edit', resource: '*', effect: 'deny' }];
  h.messages.get('root').push(user('u2', 'Continue reviewing.'));
  release();
  await first;
  assert.equal((await second)._tag, 'Failure');
});

for (const consumer of ['tool', 'child context']) {
  test(`V2 retains a runtime reply when ${consumer} synchronizes root messages first`, async (t) => {
    const h = await host(t);
    h.messages.get('root').push(user('u1', '$stop-that-shit runtime'));
    if (consumer === 'tool') {
      await h.run(h.hooks.tool['execute.before']({ ...write(), tool: 'read' }));
    } else {
      h.sessions.set('child', { id: 'child', parentID: 'root', location: { directory: '/repo' } });
      const child = { sessionID: 'child', system: [] };
      await h.run(h.hooks.session.context(child));
      assert.ok(!JSON.stringify(child.system).includes('Checked actions:'));
    }
    await h.run(entry.default.effect(h.ctx));
    const rootContext = { sessionID: 'root', system: [] };
    await h.run(h.hooks.session.context(rootContext));
    assert.match(JSON.stringify(rootContext.system), /Checked actions:/);
    const next = { sessionID: 'root', system: [] };
    await h.run(h.hooks.session.context(next));
    assert.ok(!JSON.stringify(next.system).includes('Checked actions:'));
  });
}
