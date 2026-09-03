'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  handleOpenCodeMessage,
  handleOpenCodeTool,
  promptText,
  toActionEvent
} = require('../src/adapters/opencode-hooks.cjs');
const {
  classifyOpenCodeTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  normalizePath
} = require('../src/adapters/opencode-tool-classifier.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-opencode-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

function message(sessionID, text) {
  return [
    { sessionID, agent: 'build', model: { providerID: 'openai', modelID: 'test' } },
    { message: { id: 'msg-1' }, parts: [{ type: 'text', text }] }
  ];
}

function tool(sessionID, name, args) {
  return [{ tool: name, sessionID, callID: `${name}-1` }, { args }];
}

test('OpenCode Adapter maps native tool fields to ControlEvent v1', () => {
  const event = toActionEvent(...tool('session-1', 'edit', {
    filePath: '/repo/src/config.cjs',
    oldString: 'old',
    newString: 'new'
  }), { directory: '/repo' });

  assert.equal(event.kind, 'action.before');
  assert.equal(event.host.family, 'opencode');
  assert.equal(event.action.mutability, 'write');
  assert.deepEqual(event.action.affectedPaths, ['src/config.cjs']);
  assert.equal(event.action.cwd, '/repo');
});

test('OpenCode prompt extraction ignores synthetic host messages', () => {
  assert.equal(promptText([
    { type: 'text', text: '$stop-that-shit review -- inspect only' },
    { type: 'text', text: 'Fix everything', synthetic: true },
    { type: 'file', filename: 'x' }
  ]), '$stop-that-shit review -- inspect only');
});

test('review blocks OpenCode writes and records execution denial', (t) => {
  const options = workspace(t);
  handleOpenCodeMessage(...message('review-session', '$stop-that-shit review -- inspect only'), {}, options);
  const result = handleOpenCodeTool(...tool('review-session', 'apply_patch', {
    patchText: '*** Begin Patch\n*** Add File: src/value.cjs\n+module.exports = 1;\n*** End Patch'
  }), { directory: '/repo' }, options);

  assert.equal(result.kind, 'deny');
  assert.match(result.message, /pre-execution denial/);
  const runtime = readRuntime({ sessionId: 'review-session' }, options);
  assert.equal(runtime.summary.executionDenialResponses, 1);
  assert.equal(runtime.summary.permissionDenyResponses, 0);
});

test('change allows a bounded OpenCode edit', (t) => {
  const options = workspace(t);
  handleOpenCodeMessage(...message('change-session', '$stop-that-shit change files=src/value.cjs -- update value'), {}, options);
  const result = handleOpenCodeTool(...tool('change-session', 'edit', {
    filePath: '/repo/src/value.cjs',
    oldString: '1',
    newString: '2'
  }), { directory: '/repo' }, options);
  assert.equal(result.kind, 'none');
});

test('OpenCode patch paths and Windows paths normalize without host guessing', () => {
  assert.deepEqual(extractAffectedPaths('apply_patch', {
    patchText: '*** Begin Patch\n*** Update File: src/a.cjs\n*** Move to: src/b.cjs\n*** End Patch'
  }, '/repo'), ['src/a.cjs', 'src/b.cjs']);
  assert.equal(normalizePath('C:\\repo\\src\\a.cjs', 'C:\\repo'), 'src/a.cjs');
});

test('OpenCode detects dependency and hash intent in native fields', () => {
  assert.equal(detectDependencyIntent('write', {
    filePath: '/repo/package.json',
    content: '{"dependencies":{"yaml":"^2.0.0"}}'
  }), true);
  assert.equal(detectHashIntent('edit', {
    filePath: '/repo/src/hash.cjs',
    newString: "createHash('sha256').update(value).digest('hex')"
  }), true);
});

test('task continuations do not consume a new agent budget', () => {
  assert.equal(classifyOpenCodeTool('task', { prompt: 'inspect' }), 'delegate');
  assert.equal(classifyOpenCodeTool('task', { task_id: 'session-child', prompt: 'continue' }), 'control');
  assert.equal(classifyOpenCodeTool('bash', { command: 'git diff --stat' }), 'read');
  assert.equal(classifyOpenCodeTool('bash', { command: 'node scripts/change.js' }), 'unknown');
});
