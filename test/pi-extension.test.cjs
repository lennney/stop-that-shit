'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { registerPiExtension } = require('../src/adapters/pi-extension.cjs');
const { readState } = require('../src/state.cjs');

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-pi-extension-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    }
  };
}

function fakeContext(sessionId = 'pi-session', extra = {}) {
  const notifications = [];
  return {
    notifications,
    cwd: '/repo',
    mode: 'tui',
    hasUI: true,
    model: { provider: 'openai', id: 'test' },
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    ...extra
  };
}

function input(text, extra = {}) {
  return { type: 'input', text, source: 'interactive', ...extra };
}

test('Pi Extension registers only the input, context, pre-tool, and watch-result surface', () => {
  const pi = fakePi();
  registerPiExtension(pi, { dataDir: '/unused' });
  assert.deepEqual([...pi.handlers.keys()], ['input', 'before_agent_start', 'tool_call', 'tool_result']);
});

test('interactive input arms review, injects context, and blocks a write without terminate', (t) => {
  const dataDir = workspace(t);
  const pi = fakePi();
  const ctx = fakeContext('review-session');
  registerPiExtension(pi, { dataDir });

  assert.deepEqual(
    pi.handlers.get('input')(input('$stop-that-shit review -- inspect only'), ctx),
    { action: 'continue' }
  );
  const injection = pi.handlers.get('before_agent_start')({ type: 'before_agent_start' }, ctx);
  assert.equal(injection.message.customType, 'stop-that-shit-context');
  assert.equal(injection.message.display, false);
  assert.match(injection.message.content, /mode=review/);

  const blocked = pi.handlers.get('tool_call')({
    type: 'tool_call', toolCallId: 'write-1', toolName: 'write', input: { path: '/repo/out.txt', content: 'x' }
  }, ctx);
  assert.equal(blocked.block, true);
  assert.equal(Object.hasOwn(blocked, 'terminate'), false);
  assert.match(blocked.reason, /MODE_FORBIDS_MUTATION/);
});

test('extension-origin input cannot arm or switch a contract', (t) => {
  const dataDir = workspace(t);
  const pi = fakePi();
  const ctx = fakeContext('extension-source');
  registerPiExtension(pi, { dataDir });

  const event = input('$stop-that-shit change -- mutate', { source: 'extension' });
  assert.deepEqual(pi.handlers.get('input')(event, ctx), { action: 'continue' });
  assert.equal(readState('extension-source', dataDir).contract.mode, 'unconfirmed');
});

test('mid-turn contract switches are handled without changing the active contract', (t) => {
  const dataDir = workspace(t);
  const pi = fakePi();
  const ctx = fakeContext('streaming-session');
  registerPiExtension(pi, { dataDir });
  pi.handlers.get('input')(input('$stop-that-shit review -- inspect'), ctx);

  const result = pi.handlers.get('input')(input('$stop-that-shit change -- fix', {
    streamingBehavior: 'followUp'
  }), ctx);
  assert.deepEqual(result, { action: 'handled' });
  assert.equal(readState('streaming-session', dataDir).contract.mode, 'review');
  assert.match(ctx.notifications[0].message, /not applied mid-turn/);
});

test('ordinary streaming follow-ups continue without changing authority', (t) => {
  const dataDir = workspace(t);
  const pi = fakePi();
  const ctx = fakeContext('follow-up-session');
  registerPiExtension(pi, { dataDir });
  pi.handlers.get('input')(input('$stop-that-shit review -- inspect'), ctx);

  assert.deepEqual(pi.handlers.get('input')(input('Continue reading the next file.', {
    streamingBehavior: 'followUp'
  }), ctx), { action: 'continue' });
  assert.equal(readState('follow-up-session', dataDir).contract.mode, 'review');
});

test('watch-only tool context is appended after the tool result', (t) => {
  const dataDir = workspace(t);
  const pi = fakePi();
  const ctx = fakeContext('watch-session');
  registerPiExtension(pi, { dataDir });
  pi.handlers.get('input')(input('$stop-that-shit watch review -- inspect'), ctx);

  assert.equal(pi.handlers.get('tool_call')({
    type: 'tool_call', toolCallId: 'write-watch', toolName: 'write', input: { path: '/repo/out.txt', content: 'x' }
  }, ctx), undefined);
  const result = pi.handlers.get('tool_result')({
    type: 'tool_result', toolCallId: 'write-watch', toolName: 'write', input: {},
    content: [{ type: 'text', text: 'written' }], isError: false
  }, ctx);
  assert.equal(result.content.length, 2);
  assert.match(result.content[1].text, /WATCH \/ INTENT/);
});

test('adapter operational errors fail open while policy denials still block', (t) => {
  const directory = workspace(t);
  const blocker = path.join(directory, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const pi = fakePi();
  const ctx = fakeContext('failure-session');
  registerPiExtension(pi, { dataDir: blocker });

  assert.deepEqual(
    pi.handlers.get('input')(input('$stop-that-shit review -- inspect'), ctx),
    { action: 'continue' }
  );
  assert.equal(pi.handlers.get('tool_call')({
    type: 'tool_call', toolCallId: 'write-1', toolName: 'write', input: { path: '/repo/out.txt', content: 'x' }
  }, ctx), undefined);
  assert.ok(ctx.notifications.length >= 1);
});
