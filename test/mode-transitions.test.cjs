'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const root = path.join(__dirname, '..');

test('Codex stdin preserves role-scoped review and honors explicit review boundaries', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-entry-repro-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entry = path.join(root, 'hooks', 'stop-that-shit.cjs');
  const { readState } = require('../src/state.cjs');
  const call = (session, event, fields) => {
    const result = spawnSync(process.execPath, [entry], {
      env: { ...process.env, PLUGIN_DATA: dataDir, STS_RUNTIME_DATA: dataDir },
      input: JSON.stringify({ session_id: session, turn_id: 't', hook_event_name: event, ...fields }), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  for (const [session, text] of [['heartbeat', '<heartbeat>\n主只审查协调；GUI前端协调、共享写入串行。\n</heartbeat>'], ['plain', '主只审查协调；GUI前端协调、共享写入串行。'], ['role-negative', '主不要修改代码，执行器继续实现。'], ['role-read', '主只看不改，执行器继续实现。'], ['role-colon', '主：只审查；执行器继续修改。']]) {
    call(session, 'UserPromptSubmit', { prompt: '$stop-that-shit change -- 执行任务' });
    call(session, 'UserPromptSubmit', { prompt: text });
    assert.equal(readState(session, dataDir).contract.mode, 'change');
    assert.equal(readState(session, dataDir).contract.hashPolicy, 'deny');
  }
  for (const [session, prompt] of [['polite-review', '请你不要修改代码'], ['attention-review', '注意：不要修改代码']]) {
    call(session, 'UserPromptSubmit', { prompt: '$stop-that-shit change -- task' });
    call(session, 'UserPromptSubmit', { prompt });
    assert.equal(readState(session, dataDir).contract.mode, 'review', session);
    assert.match(call(session, 'PreToolUse', { tool_name: 'apply_patch', tool_use_id: 'write', tool_input: { patch: '*** Begin Patch' } }).hookSpecificOutput.permissionDecisionReason, /MODE_FORBIDS_MUTATION/);
  }
  const auditPath = path.join(dataDir, 'runtime', 'mode-changes', `${require('../src/state.cjs').sessionKey('plain')}.jsonl`);
  const audit = fs.readFileSync(auditPath, 'utf8');
  assert.doesNotMatch(audit, /主只审查|执行任务/);
  assert.deepEqual(JSON.parse(audit.trim()).previousMode, 'unconfirmed');
  assert.equal(JSON.parse(audit.trim()).nextMode, 'change');
  for (const [session, prompt] of [['natural', '只审查，不要修改代码'], ['observe', '只观察，不要修改代码'], ['negative', '不要修改文件'], ['negative-any', '不要修改任何文件。'], ['negative-anything', '不要修改任何东西。'], ['diff-review', '只审查这个 diff，不要修改任何代码。'], ['directive', '$stop-that-shit review -- inspect'], ['qualified', '$stop-that-shit:stop-that-shit review -- inspect']]) {
    call(session, 'UserPromptSubmit', { prompt: '$stop-that-shit change -- work' });
    call(session, 'UserPromptSubmit', { prompt });
    assert.equal(readState(session, dataDir).contract.mode, 'review');
    const changes = fs.readFileSync(path.join(dataDir, 'runtime', 'mode-changes', `${require('../src/state.cjs').sessionKey(session)}.jsonl`), 'utf8').trim().split(/\s*\n\s*/).map(JSON.parse);
    assert.equal(changes.length, 2);
    assert.deepEqual(changes.map(({ previousMode, nextMode, source, eventKind, hostFamily }) => ({ previousMode, nextMode, source, eventKind, hostFamily })), [
      { previousMode: 'unconfirmed', nextMode: 'change', source: 'directive', eventKind: 'prompt.submit', hostFamily: 'codex' },
      { previousMode: 'change', nextMode: 'review', source: session === 'directive' || session === 'qualified' ? 'directive' : 'natural-explicit', eventKind: 'prompt.submit', hostFamily: 'codex' }
    ]);
    assert.ok(changes[0].occurredAt <= changes[1].occurredAt);
    assert.equal(call(session, 'PreToolUse', { tool_name: 'mcp__codex_app__read_thread', tool_use_id: 'read', tool_input: {} }), null);
    assert.match(call(session, 'PreToolUse', { tool_name: 'mcp__codex_app__send_message_to_thread', tool_use_id: 'send', tool_input: { prompt: '修改文件' } }).hookSpecificOutput.permissionDecisionReason, /MODE_FORBIDS_MUTATION/);
  }
});

test('mode audit failure reports warning while persisting the contract', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-mode-audit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'runtime', 'mode-changes'), 'not a directory');
  const result = spawnSync(process.execPath, [path.join(root, 'hooks', 'stop-that-shit.cjs')], {
    env: { ...process.env, PLUGIN_DATA: dataDir, STS_RUNTIME_DATA: dataDir },
    input: JSON.stringify({ session_id: 'audit-failure', turn_id: 't', hook_event_name: 'UserPromptSubmit', prompt: '$stop-that-shit review -- inspect' }), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /MODE_AUDIT_UNAVAILABLE/);
  assert.equal(require('../src/state.cjs').readState('audit-failure', dataDir).contract.mode, 'review');
  const denied = spawnSync(process.execPath, [path.join(root, 'hooks', 'stop-that-shit.cjs')], {
    env: { ...process.env, PLUGIN_DATA: dataDir, STS_RUNTIME_DATA: dataDir },
    input: JSON.stringify({ session_id: 'audit-failure', turn_id: 't', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'write', tool_input: { patch: '*** Begin Patch' } }), encoding: 'utf8'
  });
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /MODE_FORBIDS_MUTATION/);
});

test('mode audit retains supported host family names', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-host-audit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { recordModeChange } = require('../src/runtime-audit.cjs');
  const { sessionKey } = require('../src/state.cjs');
  for (const family of ['codex', 'claude-code', 'deepseek-harness', 'opencode', 'pi', 'omp', 'hermes-agent']) {
    recordModeChange({ sessionId: family, host: { family } }, 'unconfirmed', { mode: 'change', source: 'directive' }, { dataDir });
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime', 'mode-changes', `${sessionKey(family)}.jsonl`), 'utf8').trim());
    assert.equal(record.hostFamily, family);
  }
});
