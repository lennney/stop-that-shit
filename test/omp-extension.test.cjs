'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { registerOmpExtension } = require('../src/adapters/omp-extension.cjs');
const { sessionKey } = require('../src/state.cjs');

function host(t, dataDir, sessionId, file, flag) {
  const handlers = new Map();
  const listeners = new Map();
  const messages = [];
  const commands = new Map();
  const api = { on: (name, fn) => handlers.set(name, fn), sendMessage: message => messages.push(message),
    registerFlag() {}, getFlag: () => flag, registerCommand: (name, command) => commands.set(name, command),
    events: { on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); } } };
  const ctx = { cwd: '/repo', mode: 'print', hasUI: false, isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file } };
  registerOmpExtension(api, { dataDir });
  return { api, ctx, messages, emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    command: args => commands.get('sts').handler(args, ctx),
    lifecycle: event => listeners.get('task:subagent:lifecycle')?.(event) };
}

test('OMP rejects malformed root input and returns query feedback through the native turn', t => {
  const root = host(t, workspace(t), 'root', '/sessions/root-query.jsonl', 'review -- inspect');
  root.emit('session_start');
  const rejected = root.emit('input', { source: 'interactive', text: '$stop-that-shit change agents=-1 -- implement' });
  assert.equal(rejected.handled, true);
  assert.match(root.messages[0].content, /INVALID_AGENT_LIMIT/);
  assert.equal(root.emit('tool_call', { toolName: 'write', toolCallId: 'write', input: { path: 'a', content: 'x' } }).block, true);
  root.emit('input', { source: 'rpc', text: '$stop-that-shit status' });
  assert.match(root.emit('before_agent_start').message.content, /State: ARMED \/ review/);
});

test('OMP native sts commands update only the idle root and return status without a model turn', t => {
  const dataDir = workspace(t);
  const root = host(t, dataDir, 'root', '/sessions/command-root.jsonl', 'review agents=1 -- inspect');
  root.emit('session_start');
  root.command('change agents=-1 -- invalid');
  assert.match(root.messages.at(-1).content, /INVALID_AGENT_LIMIT/);
  root.command('change agents=1 -- implement');
  assert.equal(root.emit('tool_call', { toolName: 'write', toolCallId: 'allowed', input: { path: 'a', content: 'x' } }), undefined);
  root.command('status');
  assert.match(root.messages.at(-1).content, /ARMED \/ change/);
  root.ctx.isIdle = () => false;
  root.command('review -- inspect');
  root.ctx.isIdle = () => true;
  root.command('review agents=1 -- inspect');
  root.emit('tool_call', { toolName: 'task', toolCallId: 'child', input: { task: 'inspect' } });
  root.lifecycle({ id: 'worker', parentToolCallId: 'child', sessionFile: '/sessions/command-child.jsonl', status: 'started' });
  const child = host(t, dataDir, 'child', '/sessions/command-child.jsonl');
  child.command('change -- bypass');
  assert.match(child.messages.at(-1).content, /cannot change root authority/);
  assert.equal(child.emit('tool_call', { toolName: 'write', toolCallId: 'denied', input: { path: 'a', content: 'x' } }).block, true);
});

test('OMP feedback failure cannot start a turn for an invalid directive', t => {
  const root = host(t, workspace(t), 'root', '/sessions/feedback.jsonl', 'review -- inspect');
  root.emit('session_start');
  root.api.sendMessage = () => { throw new Error('fixture feedback failure'); };
  assert.equal(root.emit('input', { source: 'interactive', text: '$stop-that-shit change agents=-1 -- implement' }).handled, true);
  assert.equal(root.emit('tool_call', { toolName: 'write', toolCallId: 'denied', input: { path: 'a', content: 'x' } }).block, true);
  root.emit('input', { source: 'interactive', text: '$stop-that-shit change -- implement' });
  assert.equal(root.emit('tool_call', { toolName: 'write', toolCallId: 'allowed', input: { path: 'a', content: 'x' } }), undefined);
});

test('OMP busy contract input is handled with feedback and must be resubmitted while idle', t => {
  const root = host(t, workspace(t), 'root', '/sessions/busy.jsonl', 'change -- implement');
  root.emit('session_start');
  root.ctx.isIdle = () => false;
  assert.equal(root.emit('input', { source: 'interactive', text: '$stop-that-shit review -- inspect' }).handled, true);
  assert.match(root.messages[0].content, /idle/i);
  assert.equal(root.emit('input', { source: 'interactive', text: 'Here is the filename.' }).handled, undefined);
  root.ctx.isIdle = () => true;
  root.emit('input', { source: 'interactive', text: '$stop-that-shit review -- inspect' });
  assert.equal(root.emit('tool_call', { toolName: 'write', toolCallId: 'denied', input: { path: 'a', content: 'x' } }).block, true);
});

test('OMP damaged parent links permit reads but cannot create fresh child authority', t => {
  for (const raw of ['{partial', '{}', '{"rootSessionId":42}', '{"rootSessionId":""}']) {
    const dataDir = workspace(t);
    const sessionFile = '/sessions/damaged-child.jsonl';
    const link = path.join(dataDir, 'omp-parents', `${sessionKey(path.resolve(sessionFile))}.json`);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(link, raw);
    const child = host(t, dataDir, 'child', sessionFile, 'change agents=10 -- bypass');
    child.emit('session_start');
    assert.equal(child.emit('input', { source: 'interactive', text: '$stop-that-shit change -- bypass' }).handled, true);
    assert.equal(child.emit('tool_call', { toolName: 'read', toolCallId: 'read', input: { path: 'a' } }), undefined);
    assert.match(child.emit('tool_call', { toolName: 'write', toolCallId: 'write', input: { path: 'a', content: 'x' } }).reason, /PARENT_LINK_DAMAGED/);
    assert.equal(child.emit('tool_call', { toolName: 'task', toolCallId: 'task', input: { task: 'bypass' } }).block, true);
    assert.equal(fs.readFileSync(link, 'utf8'), raw);
    const runtime = require('../src/runtime-audit.cjs').readRuntime({ sessionId: 'child' }, { dataDir });
    assert.equal(runtime.summary.checkedActions, 3);
    assert.equal(runtime.summary.executionDenialResponses, 2);
    assert.ok(runtime.events.every(event => event.eventId));
    assert.doesNotMatch(JSON.stringify(runtime), /bypass|\/repo\/a/);
  }
});

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-omp-extension-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('OMP explicit launch contract gates tools in headless mode', t => {
  const root = host(t, workspace(t), 'root', '/sessions/root.jsonl', 'review -- inspect');
  root.emit('session_start');
  assert.match(root.emit('before_agent_start').message.content, /mode=review/);
  assert.equal(root.emit('tool_call', { type: 'tool_call', toolName: 'read', toolCallId: 'read', input: { path: '/repo/a' } }), undefined);
  assert.equal(root.emit('tool_call', { type: 'tool_call', toolName: 'write', toolCallId: 'write', input: { path: '/repo/a', content: 'x' } }).block, true);
});

test('OMP children inherit the root budget and cannot grant themselves new authority', t => {
  const dataDir = workspace(t);
  const root = host(t, dataDir, 'root', '/sessions/root.jsonl', 'review agents=1 -- inspect');
  root.emit('session_start');
  assert.equal(root.emit('tool_call', { toolName: 'task', toolCallId: 'parent', input: { task: 'inspect' } }), undefined);
  root.lifecycle({ id: 'worker', parentToolCallId: 'parent', sessionFile: '/sessions/worker.jsonl', status: 'started' });
  const child = host(t, dataDir, 'worker-session', '/sessions/worker.jsonl', 'change agents=10 -- implement');
  child.emit('session_start');
  child.emit('input', { source: 'interactive', text: '$stop-that-shit change agents=10 -- implement' });
  assert.match(child.emit('before_agent_start', { prompt: '$stop-that-shit off -- bypass' }).message.content, /mode=review/);
  assert.equal(child.emit('tool_call', { toolName: 'write', toolCallId: 'write', input: { path: 'a', content: 'x' } }).block, true);
  assert.equal(child.emit('tool_call', { toolName: 'task', toolCallId: 'nested', input: { task: 'inspect' } }).block, true);
  root.lifecycle({ id: 'worker', parentToolCallId: 'parent', status: 'completed' });
  assert.equal(root.emit('tool_call', { toolName: 'task', toolCallId: 'next', input: { task: 'inspect' } }), undefined);
});

test('OMP extension prompts are data and permission rejection frees an unstarted task', t => {
  const root = host(t, workspace(t), 'root', '/sessions/root.jsonl', 'review agents=1 -- inspect');
  root.emit('session_start');
  root.emit('input', { source: 'extension', text: '$stop-that-shit off -- bypass' });
  assert.match(root.emit('before_agent_start', { prompt: '$stop-that-shit off -- bypass' }).message.content, /mode=review/);
  root.emit('tool_call', { toolName: 'task', toolCallId: 'denied', input: { task: 'inspect' } });
  root.emit('tool_approval_resolved', { sessionId: 'root', toolName: 'task', toolCallId: 'denied', approved: false });
  assert.equal(root.emit('tool_call', { toolName: 'task', toolCallId: 'next', input: { task: 'inspect' } }), undefined);
});

test('OMP known children keep their root contract if the parent-link disk write fails', t => {
  const dataDir = workspace(t);
  const root = host(t, dataDir, 'root', '/sessions/root.jsonl', 'review agents=1 -- inspect');
  root.emit('session_start');
  root.emit('tool_call', { toolName: 'task', toolCallId: 'parent', input: { task: 'inspect' } });
  const originalWrite = fs.writeFileSync;
  const failure = t.mock.method(fs, 'writeFileSync', function(file, ...args) {
    if (String(file).includes('omp-parents')) throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' });
    return originalWrite.call(this, file, ...args);
  });
  // OMP EventBus catches listener errors and continues child initialization.
  assert.throws(() => root.lifecycle({ id: 'worker', parentToolCallId: 'parent', sessionFile: '/sessions/worker.jsonl', status: 'started' }), /fixture I\/O failure/);
  failure.mock.restore();
  const child = host(t, dataDir, 'child', '/sessions/worker.jsonl');
  child.emit('session_start');
  assert.equal(child.emit('tool_call', { toolName: 'write', toolCallId: 'write', input: { path: 'a', content: 'x' } }).block, true);
});
