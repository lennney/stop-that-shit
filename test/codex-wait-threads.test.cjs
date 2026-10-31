'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const root = path.join(__dirname, '..');

test('Codex stdin permits desktop thread waits in review but denies messages', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-wait-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const call = (event, fields) => {
    const result = spawnSync(process.execPath, [path.join(root, 'hooks', 'stop-that-shit.cjs')], {
      env: { ...process.env, PLUGIN_DATA: dataDir, STS_RUNTIME_DATA: dataDir },
      input: JSON.stringify({ session_id: 'wait-review', turn_id: 't', hook_event_name: event, ...fields }), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  call('UserPromptSubmit', { prompt: '$stop-that-shit review -- inspect' });
  for (const timeoutMs of [0, 30000]) assert.equal(call('PreToolUse', { tool_name: 'mcp__codex_app__wait_threads', tool_use_id: `wait-${timeoutMs}`, tool_input: { timeoutMs } }), null);
  assert.match(call('PreToolUse', { tool_name: 'mcp__codex_app__send_message_to_thread', tool_use_id: 'send', tool_input: { prompt: 'edit files' } }).hookSpecificOutput.permissionDecisionReason, /MODE_FORBIDS_MUTATION/);
});
