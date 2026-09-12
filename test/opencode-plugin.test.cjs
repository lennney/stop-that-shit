'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { readState } = require('../src/state.cjs');

const root = path.join(__dirname, '..');
const pluginUrl = pathToFileURL(path.join(root, 'opencode', 'stop-that-shit.mjs')).href;

const DEFAULT_AGENTS = [
  { name: 'build', mode: 'primary', builtIn: true, permission: { edit: 'allow', bash: {} }, tools: {}, options: {} },
  { name: 'general', mode: 'all', builtIn: true, permission: { edit: 'allow', bash: {} }, tools: {}, options: {} },
  { name: 'plan', mode: 'primary', builtIn: true, permission: { edit: 'deny', bash: {} }, tools: {}, options: {} },
  { name: 'explore', mode: 'subagent', builtIn: true, permission: { edit: 'deny', bash: {} }, tools: {}, options: {} }
];

test('package exposes the OpenCode plugin entrypoint for GitHub installs', async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  const [module, packageModule, serverModule] = await Promise.all([
    import(pluginUrl),
    import('stop-that-shit'),
    import('stop-that-shit/server')
  ]);

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.main, './opencode/stop-that-shit.mjs');
  assert.equal(packageJson.exports['./server'], './opencode/stop-that-shit.mjs');
  assert.ok(packageJson.files.includes('opencode/'));
  assert.ok(packageJson.files.includes('src/'));
  assert.ok(release.include.includes('opencode'));
  assert.equal(typeof module.StopThatShitPlugin, 'function');
  assert.deepEqual(Object.keys(module), ['StopThatShitPlugin']);
  assert.equal(packageModule.StopThatShitPlugin, module.StopThatShitPlugin);
  assert.equal(serverModule.StopThatShitPlugin, module.StopThatShitPlugin);
});

test('plugin initialization makes no reentrant OpenCode SDK request', async () => {
  const module = await import(pluginUrl);
  const client = fakeClient('/unused', {}, {});
  const hooks = await module.StopThatShitPlugin({ client, directory: '/repo' });
  assert.equal(typeof hooks['tool.execute.before'], 'function');
  assert.equal(client.calls.sessionGet, 0);
  assert.equal(client.calls.sessionMessage, 0);
  assert.equal(client.calls.sessionPrompt, 0);
  assert.equal(client.calls.appAgents, 0);
});

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-opencode-plugin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function userInfo(sessionID, messageID, extra = {}) {
  return {
    id: messageID,
    sessionID,
    role: 'user',
    agent: 'build',
    model: { providerID: 'openai', modelID: 'test' },
    ...extra
  };
}

function textPart(sessionID, messageID, text, extra = {}) {
  return { id: `${messageID}-part`, sessionID, messageID, type: 'text', text, ...extra };
}

function message(sessionID, messageID, textParts, extraInfo = {}) {
  const parts = (Array.isArray(textParts) ? textParts : [textParts])
    .map((entry) => (typeof entry === 'string' ? textPart(sessionID, messageID, entry) : entry));
  return { info: userInfo(sessionID, messageID, extraInfo), parts };
}

function fakeClient(dataDir, sessions = {}, messages = {}, options = {}) {
  const logs = [];
  const prompts = [];
  const calls = { sessionGet: 0, sessionMessage: 0, sessionPrompt: 0, appAgents: 0 };
  const delay = options.delay || 0;
  const agents = options.agents || DEFAULT_AGENTS;
  return {
    logs,
    prompts,
    calls,
    path: { get: async () => ({ data: { state: dataDir } }) },
    session: {
      get: async ({ path: input }) => {
        calls.sessionGet += 1;
        const info = sessions[input.id];
        if (!info) throw new Error(`missing session ${input.id}`);
        return { data: info };
      },
      message: async ({ path: input }) => {
        calls.sessionMessage += 1;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const entry = messages[input.messageID];
        if (!entry) throw new Error(`missing message ${input.messageID}`);
        return { data: entry };
      },
      prompt: async ({ body }) => {
        calls.sessionPrompt += 1;
        prompts.push(body);
        return { data: { info: { id: `synthetic-${calls.sessionPrompt}`, role: 'user' }, parts: body.parts } };
      }
    },
    app: {
      log: async (entry) => {
        logs.push(entry);
        return { data: true };
      },
      agents: async () => {
        calls.appAgents += 1;
        if (options.agentsError) throw new Error('agents API unavailable');
        return { data: agents };
      }
    }
  };
}

async function plugin(t, sessions, messages = {}, options = {}) {
  const dataDir = options.dataDir || workspace(t);
  const client = fakeClient(dataDir, sessions, messages, options);
  const module = await import(pluginUrl);
  const hooks = await module.StopThatShitPlugin({ client, directory: '/repo' }, { dataDir });
  return { client, dataDir, hooks };
}

function sendPartEvent(hooks, part) {
  return hooks.event({ event: { type: 'message.part.updated', properties: { part } } });
}

test('documented message.part.updated arms a review contract and blocks writes', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-1': message('root', 'msg-1', '$stop-that-shit review -- inspect only')
  };
  const { client, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-1', '$stop-that-shit review -- inspect only'));

  assert.equal(client.calls.sessionMessage, 1);
  assert.equal(client.prompts.length, 1);
  assert.equal(client.prompts[0].noReply, true);
  assert.equal(client.prompts[0].parts[0].synthetic, true);
  assert.match(client.prompts[0].parts[0].text, /mode=review/);

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 'root', callID: 'edit-1' },
      { args: { filePath: '/repo/src/a.cjs', oldString: 'a', newString: 'b' } }
    ),
    /I\/MODE_FORBIDS_MUTATION/
  );
});

test('multi-part user messages are joined before parsing the contract', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-2': message('root', 'msg-2', ['$stop-that-shit', ' review -- inspect only'])
  };
  const { hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-2', ' review -- inspect only'));

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'root', callID: 'write-1' },
      { args: { filePath: '/repo/src/a.cjs', content: 'changed' } }
    ),
    /MODE_FORBIDS_MUTATION/
  );
});

test('synthetic and ignored parts never arm a contract', async (t) => {
  const sessions = { root: { id: 'root' } };
  const { client, dataDir, hooks } = await plugin(t, sessions, {});

  await sendPartEvent(hooks, textPart('root', 'msg-synthetic', '$stop-that-shit change -- mutate', { synthetic: true }));
  await sendPartEvent(hooks, textPart('root', 'msg-ignored', '$stop-that-shit change -- mutate', { ignored: true }));

  assert.equal(client.calls.sessionMessage, 0);
  assert.equal(client.prompts.length, 0);
  assert.equal(readState('root', dataDir).contract.mode, 'unconfirmed');
});

test('assistant parts never arm a contract', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-assistant': {
      info: {
        id: 'msg-assistant',
        sessionID: 'root',
        role: 'assistant',
        mode: 'build',
        modelID: 'test',
        providerID: 'openai'
      },
      parts: [textPart('root', 'msg-assistant', '$stop-that-shit change -- mutate')]
    }
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-assistant', '$stop-that-shit change -- mutate'));

  assert.equal(readState('root', dataDir).contract.mode, 'unconfirmed');
});

test('child sessions inherit the root contract without gaining authority from child prompts', async (t) => {
  const sessions = {
    root: { id: 'root' },
    child: { id: 'child', parentID: 'root' }
  };
  const messages = {
    'msg-root': message('root', 'msg-root', '$stop-that-shit review agents=1 -- inspect'),
    'msg-child': message('child', 'msg-child', 'Fix every issue you find.')
  };
  const { client, dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-root', '$stop-that-shit review agents=1 -- inspect'));
  await hooks.event({ event: { type: 'session.created', properties: { info: sessions.child } } });
  await sendPartEvent(hooks, textPart('child', 'msg-child', 'Fix every issue you find.'));

  assert.equal(readState('root', dataDir).contract.mode, 'review');
  const childInjection = client.prompts[client.prompts.length - 1];
  assert.match(childInjection.parts[0].text, /mode=review/);

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'child', callID: 'write-1' },
      { args: { filePath: '/repo/src/a.cjs', content: 'changed' } }
    ),
    /MODE_FORBIDS_MUTATION/
  );
});

test('parent and child task launches share one active agent budget', async (t) => {
  const sessions = {
    root: { id: 'root' },
    child: { id: 'child', parentID: 'root' }
  };
  const messages = {
    'msg-root': message('root', 'msg-root', '$stop-that-shit change agents=1 -- implement')
  };
  const { hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-root', '$stop-that-shit change agents=1 -- implement'));
  await hooks['tool.execute.before'](
    { tool: 'task', sessionID: 'root', callID: 'task-1' },
    { args: { prompt: 'inspect', subagent_type: 'explore', async_launched: false } }
  );
  await hooks.event({ event: { type: 'session.created', properties: { info: sessions.child } } });
  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'task', sessionID: 'child', callID: 'task-2' },
      { args: { prompt: 'inspect again', subagent_type: 'explore' } }
    ),
    /AGENT_BUDGET_EXHAUSTED/
  );

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'task', sessionID: 'child', callID: 'task-continue' },
      { args: { task_id: 'child', prompt: 'continue', subagent_type: 'explore' } }
    ),
    /DELEGATION_LIFECYCLE_UNPROVEN/
  );
});

test('OpenCode task completion releases the delegation reservation', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-delegation': message('root', 'msg-delegation', '$stop-that-shit change agents=1 -- delegate')
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-delegation', '$stop-that-shit change agents=1 -- delegate'));
  await hooks['tool.execute.before'](
    { tool: 'task', sessionID: 'root', callID: 'task-1' },
    { args: { prompt: 'inspect', subagent_type: 'explore', async_launched: false } }
  );
  await hooks['tool.execute.after'](
    { tool: 'task', sessionID: 'root', callID: 'task-1', async_launched: false },
    { output: 'done', metadata: { sessionId: 'completed-child' } }
  );

  assert.deepEqual(readState('root', dataDir).delegation.reservations, {});
  await assert.doesNotReject(
    hooks['tool.execute.before'](
      { tool: 'task', sessionID: 'root', callID: 'task-2' },
      { args: { prompt: 'inspect again', subagent_type: 'explore', async_launched: false } }
    )
  );
});

test('OpenCode child idle lifecycle releases an explicitly associated background reservation', async (t) => {
  const sessions = {
    root: { id: 'root' },
    child: { id: 'child', parentID: 'root' }
  };
  const messages = {
    'msg-background': message('root', 'msg-background', '$stop-that-shit change agents=1 -- delegate')
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-background', '$stop-that-shit change agents=1 -- delegate'));
  await hooks['tool.execute.before'](
    { tool: 'task', sessionID: 'root', callID: 'task-1' },
    { args: { prompt: 'inspect', subagent_type: 'explore', async_launched: true } }
  );
  await hooks.event({ event: { type: 'session.created', properties: { info: sessions.child } } });
  await hooks['tool.execute.after'](
    { tool: 'task', sessionID: 'root', callID: 'task-1', args: {} },
    { output: 'launched', metadata: { sessionId: 'child', background: true } }
  );
  assert.equal(readState('root', dataDir).delegation.reservations['reservation:task-1'].agentIds[0], 'child');

  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'child' } } });
  assert.deepEqual(readState('root', dataDir).delegation.reservations, {});
});

test('child session deletion preserves root mapping until the child task completes', async (t) => {
  const sessions = {
    root: { id: 'root' },
    child: { id: 'child', parentID: 'root' }
  };
  const messages = {
    'msg-root': message('root', 'msg-root', '$stop-that-shit change agents=1 -- delegate')
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-root', '$stop-that-shit change agents=1 -- delegate'));
  await hooks.event({ event: { type: 'session.created', properties: { info: sessions.child } } });
  await hooks['tool.execute.before'](
    { tool: 'task', sessionID: 'child', callID: 'task-child' },
    { args: { prompt: 'inspect', subagent_type: 'explore', async_launched: false } }
  );
  await hooks.event({ event: { type: 'session.deleted', properties: { info: sessions.child } } });
  delete sessions.child;

  await hooks['tool.execute.after'](
    { tool: 'task', sessionID: 'child', callID: 'task-child', async_launched: false },
    { output: 'done', metadata: { sessionId: 'completed-child' } }
  );

  assert.deepEqual(readState('root', dataDir).delegation.reservations, {});
});

test('root session deletion alone does not prove child completion', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-root-end': message('root', 'msg-root-end', '$stop-that-shit change agents=1 -- delegate')
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-root-end', '$stop-that-shit change agents=1 -- delegate'));
  await hooks['tool.execute.before'](
    { tool: 'task', sessionID: 'root', callID: 'task-root' },
    { args: { prompt: 'inspect', subagent_type: 'explore' } }
  );
  await hooks.event({ event: { type: 'session.deleted', properties: { info: sessions.root } } });

  assert.equal(readState('root', dataDir).delegation.reservations['reservation:task-root'].pendingCount, 1);
});

test('watch context is appended after the tool without denying execution', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-watch': message('root', 'msg-watch', '$stop-that-shit watch review -- inspect')
  };
  const { hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-watch', '$stop-that-shit watch review -- inspect'));
  await hooks['tool.execute.before'](
    { tool: 'edit', sessionID: 'root', callID: 'edit-watch' },
    { args: { filePath: '/repo/src/a.cjs', oldString: 'a', newString: 'b' } }
  );

  const output = { title: 'src/a.cjs', output: 'Edit applied.', metadata: {} };
  await hooks['tool.execute.after'](
    { tool: 'edit', sessionID: 'root', callID: 'edit-watch', args: {} },
    output
  );
  assert.match(output.output, /WATCH \/ INTENT/);
});

test('tool execution waits for in-flight message processing before deciding', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-slow': message('root', 'msg-slow', '$stop-that-shit review -- inspect only')
  };
  const { hooks } = await plugin(t, sessions, messages, { delay: 40 });

  const eventPromise = sendPartEvent(hooks, textPart('root', 'msg-slow', '$stop-that-shit review -- inspect only'));
  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'root', callID: 'write-race' },
      { args: { filePath: '/repo/src/a.cjs', content: 'changed' } }
    ),
    /MODE_FORBIDS_MUTATION/
  );
  await eventPromise;
});

test('adapter failures log and fail open while policy denials still throw', async (t) => {
  const directory = workspace(t);
  const blocker = path.join(directory, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-fail': message('root', 'msg-fail', '$stop-that-shit review -- inspect')
  };
  const client = fakeClient(blocker, sessions, messages);
  const module = await import(pluginUrl);
  const hooks = await module.StopThatShitPlugin({ client, directory: '/repo' }, { dataDir: blocker });

  await assert.doesNotReject(sendPartEvent(hooks, textPart('root', 'msg-fail', '$stop-that-shit review -- inspect')));
  await assert.doesNotReject(
    hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 'root', callID: 'edit-fail-open' },
      { args: { filePath: '/repo/src/a.cjs', oldString: 'a', newString: 'b' } }
    )
  );
  assert.ok(client.logs.length >= 1);
});

test('uncertain session ancestry cannot parse a child prompt as user authority', async (t) => {
  const dataDir = workspace(t);
  const messages = {
    'msg-unknown': message('unknown-child', 'msg-unknown', '$stop-that-shit change -- mutate the repository')
  };
  const client = fakeClient(dataDir, {}, messages);
  const module = await import(pluginUrl);
  const hooks = await module.StopThatShitPlugin({ client, directory: '/repo' }, { dataDir });

  await sendPartEvent(hooks, textPart('unknown-child', 'msg-unknown', '$stop-that-shit change -- mutate the repository'));

  assert.equal(readState('unknown-child', dataDir).contract.mode, 'unconfirmed');
  assert.ok(client.logs.length >= 1);
});

test('an edit-capable agent message advances a review contract to change', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-review': message('root', 'msg-review', '$stop-that-shit review -- inspect only'),
    'msg-build': message('root', 'msg-build', 'Execute the changes we discussed.')
  };
  const { client, dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-review', '$stop-that-shit review -- inspect only'));
  assert.equal(readState('root', dataDir).contract.mode, 'review');

  await sendPartEvent(hooks, textPart('root', 'msg-build', 'Execute the changes we discussed.'));
  const state = readState('root', dataDir).contract;
  assert.equal(state.mode, 'change');
  assert.equal(state.source, 'host');
  assert.equal(state.level, 'guard');

  await assert.doesNotReject(
    hooks['tool.execute.before'](
      { tool: 'edit', sessionID: 'root', callID: 'edit-1' },
      { args: { filePath: '/repo/src/a.cjs', oldString: 'a', newString: 'b' } }
    )
  );

  const injection = client.prompts[client.prompts.length - 1];
  assert.match(injection.parts[0].text, /mode=change/);
});

test('explicit directives win over the host agent switch', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-directive': message('root', 'msg-directive', '$stop-that-shit review -- inspect only')
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-directive', '$stop-that-shit review -- inspect only'));
  assert.equal(readState('root', dataDir).contract.mode, 'review');

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'root', callID: 'write-1' },
      { args: { filePath: '/repo/src/a.cjs', content: 'changed' } }
    ),
    /MODE_FORBIDS_MUTATION/
  );
});

test('a read-only agent message does not advance a review contract', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-review': message('root', 'msg-review', '$stop-that-shit review -- inspect only'),
    'msg-plan': message('root', 'msg-plan', 'Proceed with the next step.', { agent: 'plan' })
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-review', '$stop-that-shit review -- inspect only'));
  await sendPartEvent(hooks, textPart('root', 'msg-plan', 'Proceed with the next step.'));

  assert.equal(readState('root', dataDir).contract.mode, 'review');
});

test('subagent messages do not advance the root contract', async (t) => {
  const sessions = {
    root: { id: 'root' },
    child: { id: 'child', parentID: 'root' }
  };
  const messages = {
    'msg-review': message('root', 'msg-review', '$stop-that-shit review -- inspect only'),
    'msg-child': message('child', 'msg-child', 'Execute the changes now.')
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-review', '$stop-that-shit review -- inspect only'));
  await hooks.event({ event: { type: 'session.created', properties: { info: sessions.child } } });
  await sendPartEvent(hooks, textPart('child', 'msg-child', 'Execute the changes now.'));

  assert.equal(readState('root', dataDir).contract.mode, 'review');
  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'child', callID: 'write-1' },
      { args: { filePath: '/repo/src/a.cjs', content: 'changed' } }
    ),
    /MODE_FORBIDS_MUTATION/
  );
});

test('a quoted directive mention does not advance the review contract', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-quoted': message('root', 'msg-quoted', '"$stop-that-shit review -- inspect only"')
  };
  const { dataDir, hooks } = await plugin(t, sessions, messages);

  await sendPartEvent(hooks, textPart('root', 'msg-quoted', '"$stop-that-shit review -- inspect only"'));
  assert.equal(readState('root', dataDir).contract.mode, 'review');

  await assert.rejects(
    hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'root', callID: 'write-1' },
      { args: { filePath: '/repo/src/a.cjs', content: 'changed' } }
    ),
    /MODE_FORBIDS_MUTATION/
  );
});

test('an unreachable agent list fails open and advances the review contract', async (t) => {
  const sessions = { root: { id: 'root' } };
  const messages = {
    'msg-review': message('root', 'msg-review', '$stop-that-shit review -- inspect only'),
    'msg-build': message('root', 'msg-build', 'Execute the changes we discussed.')
  };
  const { client, dataDir, hooks } = await plugin(t, sessions, messages, { agentsError: true });

  await sendPartEvent(hooks, textPart('root', 'msg-review', '$stop-that-shit review -- inspect only'));
  await sendPartEvent(hooks, textPart('root', 'msg-build', 'Execute the changes we discussed.'));

  assert.equal(readState('root', dataDir).contract.mode, 'change');
  assert.ok(client.logs.length >= 1);
});
