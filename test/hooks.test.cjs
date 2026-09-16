'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleHook } = require('../src/hook-policy.cjs');
const { acquireSessionLock, readState } = require('../src/state.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

function prompt(session, text) {
  return {
    session_id: session,
    turn_id: 'turn-1',
    hook_event_name: 'UserPromptSubmit',
    prompt: text
  };
}

function pre(session, toolName, toolInput, turnId = 'turn-1') {
  return {
    session_id: session,
    turn_id: turnId,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: `${toolName}-1`,
    tool_input: toolInput
  };
}

test('shell denial and explain show a specific reason without recording command input', (t) => {
  const options = workspace(t);
  const session = 'shell-analysis-reason';
  const command = 'rg --hostname-bin=PRIVATE_HELPER PRIVATE_PATTERN PRIVATE_FILE';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  const denied = handleHook(pre(session, 'exec_command', { command }), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /I\/MUTABILITY_UNPROVEN/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /This ripgrep option can execute another program/);
  const runtime = readRuntime({ sessionId: session }, options);
  const event = runtime.events[0];
  assert.equal(event.action.analysisReason, 'shell_execution_option');
  assert.doesNotMatch(JSON.stringify(runtime), /PRIVATE_HELPER|PRIVATE_PATTERN|PRIVATE_FILE/);
  const explain = handleHook(prompt(session, `$stop-that-shit explain ${event.eventId}`), options);
  assert.match(explain.hookSpecificOutput.additionalContext, /Analysis: This ripgrep option can execute another program/);
  assert.equal(handleHook(pre(session, 'exec_command', { command: "rg -e '--hostname-bin=PRIVATE_HELPER' README.md" }), options), null);
  handleHook(prompt(session, '$stop-that-shit change -- run the helper'), options);
  assert.equal(handleHook(pre(session, 'exec_command', { command }), options), null);
});

test('review contract blocks apply_patch', (t) => {
  const options = workspace(t);
  handleHook(prompt('review-session', '$stop-that-shit review -- inspect only'), options);
  const output = handleHook(pre('review-session', 'apply_patch', { command: '*** Begin Patch' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /I\/MODE_FORBIDS_MUTATION/);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Guard returned permission deny\./);
  assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason, /pre-execution denial/);
  const runtime = readRuntime({ sessionId: 'review-session' }, options);
  assert.equal(runtime.events[0].decision.responseOutcome, 'permission_deny_returned');
  assert.equal(runtime.summary.executionDenialResponses, undefined);
});

test('explicit change contract preserves the paired good case', (t) => {
  const options = workspace(t);
  handleHook(prompt('change-session', '$stop-that-shit change -- fix P1 only'), options);
  const output = handleHook(pre('change-session', 'apply_patch', { command: '*** Begin Patch' }), options);
  assert.equal(output, null);
});

test('Codex permits documenting review examples but denies writes after a real review correction', (t) => {
  const options = workspace(t);
  const session = 'document-review-example';
  const patch = { patch: '*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+review only\n*** End Patch' };
  handleHook(prompt(session, '$stop-that-shit change -- update README.md'), options);
  handleHook(prompt(session, 'Add this usage example to README.md:\n```text\n$stop-that-shit review -- review only\n```'), options);
  assert.equal(readState(session, options.dataDir).contract.mode, 'change');
  assert.equal(handleHook(pre(session, 'apply_patch', patch), options), null);

  handleHook(prompt(session, 'Review only. Do not edit anything.'), options);
  assert.match(handleHook(pre(session, 'apply_patch', patch), options).hookSpecificOutput.permissionDecisionReason, /MODE_FORBIDS_MUTATION/);
  assert.equal(handleHook(pre(session, 'Bash', { command: 'git diff -- README.md' }), options), null);
});

test('Codex ignores a quoted authorization and permits the same explicitly authorized task', (t) => {
  const options = workspace(t);
  const session = 'quoted-authorization';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  const previous = readState(session, options.dataDir).contract;
  handleHook(prompt(session, '请解释这段示例：$stop-that-shit change hash=allow -- 不执行'), options);
  assert.deepEqual(readState(session, options.dataDir).contract, previous);

  const patch = {
    patch: "*** Begin Patch\n*** Add File: checksum.cjs\n+const digest = createHash('sha256').update(value).digest('hex');\n*** End Patch"
  };
  const denied = handleHook(pre(session, 'apply_patch', patch), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /I\/MODE_FORBIDS_MUTATION/);
  assert.equal(handleHook(pre(session, 'Bash', { command: 'git diff --stat' }), options), null);

  handleHook(prompt(session, '$stop-that-shit change hash=allow -- add the required checksum'), options);
  assert.equal(handleHook(pre(session, 'apply_patch', patch), options), null);
});

test('default hash policy blocks a newly added hashing API', (t) => {
  const options = workspace(t);
  handleHook(prompt('hash-deny-session', '$stop-that-shit change -- add the requested field'), options);
  const output = handleHook(pre('hash-deny-session', 'apply_patch', {
    patch: "*** Begin Patch\n+const digest = createHash('sha256').update(value).digest('hex');\n*** End Patch"
  }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /H\/HASH_NOT_AUTHORIZED/);
});

test('explicit hash allow preserves a required checksum good case', (t) => {
  const options = workspace(t);
  handleHook(prompt('hash-allow-session', '$stop-that-shit change hash=allow -- add the required release checksum'), options);
  const output = handleHook(pre('hash-allow-session', 'Bash', { command: 'sha256sum dist/release.zip' }), options);
  assert.equal(output, null);
});

test('hash ask requires user approval before a covered action', (t) => {
  const options = workspace(t);
  handleHook(prompt('hash-ask-session', '$stop-that-shit change hash=ask -- prepare the artifact'), options);
  const output = handleHook(pre('hash-ask-session', 'Bash', { command: 'Get-FileHash dist/release.zip -Algorithm SHA256' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /H\/HASH_NOT_AUTHORIZED/);
});

test('ordinary prose containing hash is not blocked', (t) => {
  const options = workspace(t);
  handleHook(prompt('hash-prose-session', '$stop-that-shit change -- update the docs'), options);
  const output = handleHook(pre('hash-prose-session', 'apply_patch', {
    patch: '*** Begin Patch\n+Explain why a hash is not an anonymity boundary.\n*** End Patch'
  }), options);
  assert.equal(output, null);
});

test('files contract blocks a patch outside the declared write boundary', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-deny-session', '$stop-that-shit change files=src/config.cjs|test/config.test.cjs -- update config shape'), options);
  const output = handleHook(pre('files-deny-session', 'apply_patch', {
    patch: '*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch'
  }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /S\/PATH_OUTSIDE_CONTRACT/);
});

test('files contract preserves mixed-case paths and keeps differently cased paths outside the boundary', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-case-session', '$stop-that-shit lock change files=/Workspace/example/Config.toml -- update config'), options);

  assert.equal(handleHook(pre('files-case-session', 'Write', {
    file_path: '/Workspace/example/Config.toml', content: 'x'
  }), options), null);

  const denied = handleHook(pre('files-case-session', 'Write', {
    file_path: '/workspace/example/config.toml', content: 'x'
  }), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/PATH_OUTSIDE_CONTRACT/);
});

test('files contract matches Windows paths case-insensitively without weakening POSIX matching', (t) => {
  const options = workspace(t);
  handleHook(prompt(
    'files-windows-case-session',
    '$stop-that-shit lock change files=D:/Workspace/Project/Config.toml|Src/Rules.cjs -- update config'
  ), options);

  assert.equal(handleHook({
    ...pre('files-windows-case-session', 'Write', {
      file_path: 'd:\\workspace\\project\\config.toml', content: 'x'
    }),
    cwd: 'D:\\Workspace\\Project'
  }, options), null);

  assert.equal(handleHook({
    ...pre('files-windows-case-session', 'Write', {
      file_path: 'src/rules.cjs', content: 'x'
    }),
    cwd: 'D:\\Workspace\\Project'
  }, options), null);

  const denied = handleHook({
    ...pre('files-windows-case-session', 'Write', {
      file_path: 'd:\\workspace\\project\\other.toml', content: 'x'
    }),
    cwd: 'D:\\Workspace\\Project'
  }, options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/PATH_OUTSIDE_CONTRACT/);
});

test('files contract matches an absolute allowlist when the host reports cwd-relative paths', (t) => {
  const options = workspace(t);
  const cwd = process.platform === 'win32' ? 'D:\\Workspace\\project' : '/Workspace/project';
  const allowed = process.platform === 'win32'
    ? 'D:/Workspace/Config.toml'
    : '/Workspace/Config.toml';
  const target = process.platform === 'win32'
    ? 'D:\\Workspace\\Config.toml'
    : '/Workspace/Config.toml';

  handleHook(prompt('files-absolute-session', `$stop-that-shit lock change files=${allowed} -- update config`), options);

  assert.equal(handleHook({
    ...pre('files-absolute-session', 'Write', { file_path: target, content: 'x' }),
    cwd
  }, options), null);
});

test('empty files contract blocks every write instead of becoming unbounded', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-empty-session', '$stop-that-shit lock change files= -- update nothing'), options);

  const output = handleHook(pre('files-empty-session', 'Write', {
    file_path: 'README.md', content: 'x'
  }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /S\/PATH_OUTSIDE_CONTRACT/);
});

test('files contract blocks a dot-segment escape from a wildcard boundary', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-dot-segment-session', '$stop-that-shit lock change files=src/** -- update source files'), options);

  const output = handleHook(pre('files-dot-segment-session', 'Write', {
    file_path: 'src/../README.md', content: 'x'
  }), options);
  assert.notEqual(output, null);
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /S\/PATH_OUTSIDE_CONTRACT/);
});

test('files contract allows equivalent paths after dot-segment normalization', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-normalized-session', '$stop-that-shit lock change files=./src/config.cjs -- update config'), options);

  assert.equal(handleHook(pre('files-normalized-session', 'Write', {
    file_path: 'src/config.cjs', content: 'x'
  }), options), null);
});

test('files contract requires approval when a write path is unproven', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-unknown-session', '$stop-that-shit change files=src/config.cjs -- update config'), options);
  const output = handleHook(pre('files-unknown-session', 'Bash', { command: "Set-Content -Path src/config.cjs -Value 'x'" }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /S\/WRITE_PATH_UNPROVEN/);
});

test('files contract requires approval when tool mutability is unproven', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-mutability-session', '$stop-that-shit lock change files=src/** -- update source'), options);

  const output = handleHook(pre('files-mutability-session', 'plugin_custom_tool', { path: 'README.md' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /S\/WRITE_PATH_UNPROVEN/);
});

test('files contract requires approval for a dynamic shell with unproven effects', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-dynamic-session', '$stop-that-shit lock change files=src/** -- update source'), options);

  const output = handleHook(pre('files-dynamic-session', 'Bash', { command: 'node -e "process.exit(0)"' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /S\/WRITE_PATH_UNPROVEN/);
});

test('unbounded files contract preserves an explicitly authorized unknown tool', (t) => {
  const options = workspace(t);
  handleHook(prompt('files-unbounded-session', '$stop-that-shit lock change files=** -- run the custom tool'), options);

  assert.equal(handleHook(pre('files-unbounded-session', 'plugin_custom_tool', { path: 'README.md' }), options), null);
});

test('dependency installation asks before expanding the task', (t) => {
  const options = workspace(t);
  handleHook(prompt('deps-deny-session', '$stop-that-shit change -- format one existing value'), options);
  const output = handleHook(pre('deps-deny-session', 'Bash', { command: 'npm install lodash' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /S\/DEPENDENCY_NOT_AUTHORIZED/);
});

test('deps allow preserves an explicitly requested dependency', (t) => {
  const options = workspace(t);
  handleHook(prompt('deps-allow-session', '$stop-that-shit change deps=allow -- add the requested parser package'), options);
  assert.equal(handleHook(pre('deps-allow-session', 'Bash', { command: 'npm install yaml' }), options), null);
});

test('review contract allows a clearly read-only shell command', (t) => {
  const options = workspace(t);
  handleHook(prompt('read-session', '$stop-that-shit review -- inspect only'), options);
  const output = handleHook(pre('read-session', 'Bash', { command: 'git diff --stat' }), options);
  assert.equal(output, null);
});

test('review contract blocks a shell command with unproven mutability', (t) => {
  const options = workspace(t);
  handleHook(prompt('unknown-session', '$stop-that-shit review -- inspect only'), options);
  const output = handleHook(pre('unknown-session', 'Bash', { command: 'node scripts/custom-task.js' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /MUTABILITY_UNPROVEN/);
});

test('Codex review rejects branch mutation and restore while keeping branch queries', (t) => {
  const options = workspace(t);
  const session = 'git-review';
  handleHook(prompt(session, '$stop-that-shit review -- inspect repository state'), options);
  for (const command of ['git branch scratch', 'Git branch scratch', 'git branch -D scratch', 'git branch -M old new', 'git branch --list -D scratch', 'git status --short; git restore -- src/config.cjs']) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of ['git branch', 'git branch --show-current', 'git branch -a', "git branch --list 'fix/*'", 'git branch --contains HEAD']) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
  handleHook(prompt(session, '$stop-that-shit change -- create the requested branch'), options);
  assert.equal(handleHook(pre(session, 'Bash', { command: 'git branch scratch' }), options), null);
});

test('Codex review checks every command instead of allowing a partial read match', (t) => {
  const options = workspace(t);
  const session = 'compound-review';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    'git status --short; git config --local sts.probe value',
    'git status --short\rgit config --local sts.probe value',
    'git status --short\ncustom-build',
    'git diff --stat && custom-build',
    'git status || custom-build',
    'Get-Content fixture.txt | custom-build',
    "custom-build --description 'git status'",
    'git status; git -C fixture restore -- tracked.txt',
    'git diff --output=changed.txt; git status',
    'rg --pre=custom-build needle; git status'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  handleHook(prompt(session, '$stop-that-shit change -- set the requested local Git setting'), options);
  assert.equal(handleHook(pre(session, 'Bash', { command: 'git status --short; git config --local sts.probe value' }), options), null);
});

test('Codex review keeps static query chains and quoted command examples readable', (t) => {
  const options = workspace(t);
  const session = 'literal-review';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    'git status --short; git diff --stat',
    'git status --short\rgit diff --stat',
    'git status --short\r\n\r\ngit diff --stat',
    'git status --short && git --no-pager diff --stat',
    "git -C 'repo folder' status --short",
    "rg -n 'git restore; custom-build' src",
    "rg -n '$(example)' src",
    'rg -n "git restore; custom-build" src',
    "Get-Content -LiteralPath 'C:\\source files\\fixture.txt' | Select-Object -First 5",
    "git branch --list 'fix/*'"
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
});

test('Codex review rejects shell-dependent quote boundaries and preserves literal searches', (t) => {
  const options = workspace(t);
  const session = 'shell-quotes';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const [quote, alternatives] of [["'", ['\u2018', '\u2019', '\u201a', '\u201b']], ['"', ['\u201c', '\u201d', '\u201e']]]) {
    for (const closing of alternatives) {
      const command = `Get-Content ${quote}missing${closing}; Set-Content -LiteralPath marker.txt -Value fixture; #${quote}`;
      assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
    }
  }
  for (const command of [
    'rg -F "it\u2019s ready" README.md',
    "rg -F 'say \u201chello\u201d' README.md",
    "Get-Content -LiteralPath 'C:\\source files\\fixture.txt'",
    'Get-Content -LiteralPath "C:\\source files\\fixture.txt"'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
});

test('Codex review checks Git option boundaries and disabled branch listing', (t) => {
  const options = workspace(t);
  const session = 'git-option-boundaries';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    'git branch --list --no-list created',
    'git branch --list --no-l created',
    'git branch --list --no-list --mov victim moved'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of [
    "git branch --list '--format=%(refname:short) -D'",
    "git branch --list --format '%(refname:short) -D'",
    'git branch --list -- -D',
    'git branch --list --sort=-committerdate',
    'git branch --contains HEAD',
    'git branch --no-merged HEAD',
    'git diff -- --output=tracked.txt',
    'git log -- --output=tracked.txt',
    'git show HEAD -- --output=tracked.txt'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
});

test('Codex review does not treat unquoted shell escapes as literal arguments', (t) => {
  const options = workspace(t);
  const session = 'shell-escapes';
  const command = String.raw`git --no-pager diff --no-index before.txt after.txt --out\put=marker.txt`;
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny');
  handleHook(prompt(session, '$stop-that-shit change -- write the requested diff'), options);
  assert.equal(handleHook(pre(session, 'Bash', { command }), options), null);
});

test('Codex review leaves legacy native argument quoting unproven while cmdlet searches work', (t) => {
  const options = workspace(t);
  const session = 'legacy-native-quotes';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    `git --no-pager diff --no-index before.txt after.txt '--src-prefix= " --output=marker.txt "--dst-prefix= '`,
    'git --no-pager diff --no-index before.txt after.txt "--src-prefix= "" --output=marker.txt ""--dst-prefix= "'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of [
    `Select-String -SimpleMatch 'say "hello"' -LiteralPath README.md`,
    'Select-String -SimpleMatch "say ""hello""" -LiteralPath README.md'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
});

test('Codex review leaves dynamic and incomplete shell structure unproven', (t) => {
  const options = workspace(t);
  const session = 'dynamic-review';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    'git status; $tool',
    'git status; & custom-build',
    'git status; powershell -Command custom-build',
    'git status; bash -c custom-build',
    'Get-Content "$(custom-build)"',
    'Get-Content "`custom-build`"',
    "rg 'unterminated git status",
    'git status &&',
    'git status |',
    'git status; ForEach-Object { custom-build }',
    'git status; echo %COMMAND%'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('Codex review blocks ripgrep executable options while literal searches remain readable', (t) => {
  const options = workspace(t);
  const session = 'ripgrep-executables';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    'rg --hostname-bin=helper fixture input.txt',
    'rg --hostname-bin helper fixture input.txt',
    'rg fixture input.txt --hostname-bin=helper',
    'rg --pre=helper fixture input.txt',
    'rg --pre helper fixture input.txt',
    'rg -e -- --hostname-bin=helper input.txt',
    'rg --regexp -- --hostname-bin=helper input.txt',
    'rg --glob -- --hostname-bin=helper input.txt',
    'rg -ne -- --hostname-bin=helper input.txt'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of [
    'rg -n fixture input.txt',
    'rg -n -- --hostname-bin=helper input.txt',
    'rg fixture -- --hostname-bin=helper',
    'rg fixture -- --pre=helper',
    "rg -e '--hostname-bin=helper' input.txt",
    "rg --regexp '--hostname-bin=helper' input.txt",
    "rg -ne '--hostname-bin=helper' input.txt",
    'rg -e--hostname-bin=helper input.txt',
    'rg --regexp=--hostname-bin=helper input.txt',
    "rg -e '--pre=helper' input.txt",
    "rg --glob '--hostname-bin=helper' fixture .",
    "rg --file '--hostname-bin=helper' input.txt"
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
  handleHook(prompt(session, '$stop-that-shit change -- run the requested search helper'), options);
  assert.equal(handleHook(pre(session, 'Bash', { command: 'rg --hostname-bin=helper fixture input.txt' }), options), null);
});

test('Codex review distinguishes Git option values from the end of options', (t) => {
  const options = workspace(t);
  const session = 'git-option-values';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    'git --no-pager diff --no-index --word-diff-regex -- --output=marker.txt before.txt after.txt',
    'git diff --src-prefix -- --output=marker.txt',
    'git log -S -- --output=marker.txt',
    'git show --future-option -- --output=marker.txt'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of [
    'git diff --word-diff-regex -- -- README.md',
    'git diff --src-prefix=-- -- --output=tracked.txt',
    'git diff --stat', 'git diff --check', 'git diff --name-only', 'git diff --cached -U3',
    'git log --oneline -n 5', "git log --format='%h %s' -- README.md",
    'git show --stat HEAD', 'git rev-parse --show-toplevel', 'git status --porcelain=v1 -uno',
    'git diff -- --output=tracked.txt'
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
});

test('Codex review checks native commands with and without empty arguments', (t) => {
  const options = workspace(t);
  const session = 'empty-native-arguments';
  handleHook(prompt(session, '$stop-that-shit review -- inspect only'), options);
  for (const command of [
    "rg -e '' -- --hostname-bin=helper input.txt",
    'rg -e "" -- --pre=helper input.txt',
    "git --no-pager diff --no-index --word-diff-regex '' -- --output=marker.txt before.txt after.txt"
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of ["rg '' input.txt", "rg -e '' -- input.txt", "Select-String -Pattern '' -LiteralPath input.txt"]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
  handleHook(prompt(session, '$stop-that-shit change -- run the requested hostname helper'), options);
  assert.equal(handleHook(pre(session, 'Bash', { command: "rg -e '' -- --hostname-bin=helper input.txt" }), options), null);
});

test('shell intent checks preserve literal searches and still inspect real operations', (t) => {
  const options = workspace(t);
  const session = 'literal-shell-intents';
  handleHook(prompt(session, '$stop-that-shit review -- search examples'), options);
  for (const command of [
    "rg -n 'npm install' README.md", "rg -n 'Get-FileHash' README.md", "rg -n 'sha256sum' README.md",
    "Select-String -SimpleMatch 'npm install' -LiteralPath README.md",
    "rg -e 'npm install' README.md; rg -e 'sha256sum' README.md"
  ]) {
    assert.equal(handleHook(pre(session, 'Bash', { command }), options), null, command);
  }
  handleHook(prompt(session, '$stop-that-shit change -- inspect the requested command'), options);
  for (const [command, reason] of [
    ["rg -n 'sha256sum' README.md; npm install fixture", 'DEPENDENCY_NOT_AUTHORIZED'],
    ["rg -n 'npm install' README.md; sha256sum fixture.txt", 'HASH_NOT_AUTHORIZED'],
    ['sha256sum fixture.txt', 'HASH_NOT_AUTHORIZED'],
    ['npm install fixture', 'DEPENDENCY_NOT_AUTHORIZED'],
    ['sh -c "sha256sum fixture.txt"', 'HASH_NOT_AUTHORIZED']
  ]) {
    assert.match(handleHook(pre(session, 'Bash', { command }), options)?.hookSpecificOutput?.permissionDecisionReason || '', new RegExp(reason), command);
  }
  handleHook(prompt(session, '$stop-that-shit change hash=allow deps=allow -- run the requested operations'), options);
  assert.equal(handleHook(pre(session, 'Bash', { command: 'sha256sum fixture.txt; npm install fixture' }), options), null);
});

test('watch level warns but does not deny mutation', (t) => {
  const options = workspace(t);
  handleHook(prompt('watch-session', '$stop-that-shit watch review -- inspect only'), options);
  const output = handleHook(pre('watch-session', 'apply_patch', { command: 'patch' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /MODE_FORBIDS_MUTATION/);
});

test('unchanged prompt context is emitted once per contract state', (t) => {
  const options = workspace(t);

  const first = handleHook(prompt('context-session', 'Inspect the current behavior.'), options);
  const repeated = handleHook(prompt('context-session', 'Continue the inspection.'), options);
  const changed = handleHook(prompt('context-session', '$stop-that-shit review -- inspect only'), options);
  const repeatedReview = handleHook(prompt('context-session', 'Continue the review.'), options);

  assert.match(first.hookSpecificOutput.additionalContext, /watch-only mode/);
  assert.equal(repeated, null);
  assert.match(changed.hookSpecificOutput.additionalContext, /mode=review/);
  assert.equal(repeatedReview, null);
});

test('default sessions are observing and record checks without returning deny', (t) => {
  const options = workspace(t);
  const output = handleHook(pre('observe-session', 'apply_patch', { command: 'patch' }), options);
  assert.equal(output, null);
  const runtime = readRuntime({ sessionId: 'observe-session' }, options);
  assert.equal(runtime.summary.checkedActions, 1);
  assert.equal(runtime.events[0].controlState, 'observing');
  assert.equal(runtime.events[0].decision.responseOutcome, 'none');
});

test('status, runtime, explain, and label commands do not mutate the active contract', (t) => {
  const options = workspace(t);
  handleHook(prompt('query-session', '$stop-that-shit review -- inspect only'), options);
  const denied = handleHook(pre('query-session', 'apply_patch', { command: 'patch' }), options);
  const eventId = denied.hookSpecificOutput.permissionDecisionReason.match(/evt_[0-9a-f-]+/)[0];
  const before = readState('query-session', options.dataDir).contract;

  const status = handleHook(prompt('query-session', '$stop-that-shit status'), options);
  const runtime = handleHook(prompt('query-session', '$stop-that-shit runtime'), options);
  const explain = handleHook(prompt('query-session', `$stop-that-shit explain ${eventId}`), options);
  const label = handleHook(prompt('query-session', `$stop-that-shit label ${eventId} correct`), options);

  assert.match(status.hookSpecificOutput.additionalContext, /ARMED \/ review/);
  assert.match(runtime.hookSpecificOutput.additionalContext, /checked actions: 1/i);
  assert.doesNotMatch(runtime.hookSpecificOutput.additionalContext, /Execution-denial responses/);
  assert.match(explain.hookSpecificOutput.additionalContext, new RegExp(eventId));
  assert.match(label.hookSpecificOutput.additionalContext, /correct/);
  assert.deepEqual(readState('query-session', options.dataDir).contract, before);
  assert.equal(readRuntime({ eventId }, options).events[0].label, 'correct');

  for (const example of [
    `    $stop-that-shit label ${eventId} incorrect`,
    `\t$stop-that-shit label ${eventId} incorrect`,
    `\`$stop-that-shit label ${eventId} incorrect\``,
    `$stop-that-shit label\n${eventId} incorrect`
  ]) {
    handleHook(prompt('query-session', example), options);
    assert.equal(readRuntime({ eventId }, options).events[0].label, 'correct', example);
    assert.deepEqual(readState('query-session', options.dataDir).contract, before);
  }
});

// These fixtures use the model-facing Rust SpawnAgentResult / WaitAgentResult
// shapes; no host-invented reservation_id or async_launched completion flag.
test('Codex maps spawn output to running and never turns request intent into completion', () => {
  const { toControlEvent } = require('../src/adapters/codex-hooks.cjs');
  const base = { session_id: 'parent', hook_event_name: 'PostToolUse', tool_name: 'spawn_agent', tool_use_id: 'spawn-1', tool_input: { async: false } };
  const id = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
  for (const tool_response of [{ agent_id: id, nickname: null }, JSON.stringify({ agent_id: id, nickname: 'Scout' })]) {
    const action = toControlEvent({ ...base, tool_response }).action;
    assert.equal(action.lifecycle, 'running');
    assert.equal(action.agentId, id);
  }
  assert.equal(toControlEvent(base).action.lifecycle, 'unknown');
});

test('Codex wait releases only explicit UUID targets with proven terminal results', () => {
  const { toControlEvent } = require('../src/adapters/codex-hooks.cjs');
  const id = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
  const base = { session_id: 'parent', hook_event_name: 'PostToolUse', tool_name: 'wait_agent', tool_use_id: 'wait-1', tool_input: { targets: [id] } };
  for (const status of [{ completed: 'done' }, 'shutdown']) {
    assert.deepEqual(toControlEvent({ ...base, tool_response: { status: { [id]: status }, timed_out: false } }).action.endedAgentIds, [id]);
  }
  for (const status of ['running', 'interrupted', { errored: 'transport failed' }]) {
    assert.equal(toControlEvent({ ...base, tool_response: { status: { [id]: status }, timed_out: false } }), null);
  }
  assert.equal(toControlEvent({ ...base, tool_input: { targets: ['/root/scout'] }, tool_response: { status: { '/root/scout': { completed: 'done' } }, timed_out: false } }), null);
});

test('Codex stop attempts cannot release parent accounting and resumes expose uncertainty', () => {
  const { toControlEvent } = require('../src/adapters/codex-hooks.cjs');
  assert.equal(toControlEvent({ session_id: 'child', hook_event_name: 'SubagentStop', agent_id: 'child' }), null);
  for (const tool_name of ['send_input', 'resume_agent', 'followup_task', 'multi_agent_v1send_input', 'multi_agent_v1resume_agent']) {
    assert.equal(toControlEvent({ session_id: 'parent', hook_event_name: 'PreToolUse', tool_name, tool_use_id: 'resume-1', tool_input: {} }).action.delegationLifecycleUnproven, true);
  }
});

test('Codex v2 follow-up cannot restart an agent under a finite Guard limit', (t) => {
  const options = workspace(t);
  for (const limit of [0, 1]) {
    const session = `v2-followup-${limit}`;
    handleHook(prompt(session, `$stop-that-shit change agents=${limit} -- inspect`), options);
    const output = handleHook(pre(session, 'followup_task', { target: '/root/scout', message: 'Continue' }), options);
    assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /DELEGATION_LIFECYCLE_UNPROVEN/);
    assert.deepEqual(readState(session, options.dataDir).delegation.unresolved, {});
    assert.equal(handleHook(pre(session, 'send_message', { target: '/root/scout', message: 'Context only' }), options), null);
  }
});

test('Codex v2 follow-up preserves watch behavior and records uncertainty before a finite limit', (t) => {
  const options = workspace(t);
  for (const directive of ['watch change agents=1', 'change']) {
    const session = `v2-followup-${directive}`;
    handleHook(prompt(session, `$stop-that-shit ${directive} -- inspect`), options);
    const output = handleHook(pre(session, 'followup_task', { target: '/root/scout', message: 'Continue' }), options);
    assert.notEqual(output?.hookSpecificOutput?.permissionDecision, 'deny');
    if (directive.startsWith('watch')) assert.match(output?.hookSpecificOutput?.additionalContext, /DELEGATION_LIFECYCLE_UNPROVEN/);
    assert.equal(readState(session, options.dataDir).delegation.unresolved['followup_task-1'], 'unversioned_resume');
    handleHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
    const spawn = handleHook(pre(session, 'spawn_agent', { task_name: 'next', message: 'Inspect' }), options);
    assert.match(spawn.hookSpecificOutput.permissionDecisionReason, /DELEGATION_STATE_UNPROVEN/);
  }
});

test('Codex v2 mailbox activity and path-only snapshots do not release an unbound spawn', (t) => {
  const options = workspace(t);
  const session = 'v2-unbound-spawn';
  handleHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
  assert.equal(handleHook(pre(session, 'spawn_agent', { task_name: 'scout', message: 'Inspect' }), options), null);
  const post = (tool_name, tool_use_id, tool_response) => handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name, tool_use_id, tool_input: {}, tool_response }, options);
  post('spawn_agent', 'spawn_agent-1', { task_name: '/root/scout', nickname: 'Scout' });
  post('wait_agent', 'wait-1', { message: 'Wait completed.', timed_out: false });
  post('list_agents', 'list-1', { agents: [{ agent_name: '/root/scout', agent_status: { completed: 'Done' } }] });
  post('interrupt_agent', 'interrupt-1', { previous_status: 'running' });
  const next = { ...pre(session, 'spawn_agent', { task_name: 'next', message: 'Inspect' }), tool_use_id: 'spawn-2' };
  assert.match(handleHook(next, options).hookSpecificOutput.permissionDecisionReason, /AGENT_BUDGET_EXHAUSTED/);
  assert.equal(handleHook(pre(session, 'Bash', { command: 'git status --short' }), options), null);
});

// Codex flat_tool_name concatenates the multi_agent_v1 namespace and tool name.
// spawn_agent alone gets a canonical-name override in function_hook_tool_name.
test('Codex namespaced v1 waits release UUID reservations and resumes retain the finite gate', (t) => {
  const options = workspace(t);
  const session = 'v1-namespaced';
  const id = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
  handleHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
  assert.equal(handleHook(pre(session, 'spawn_agent', { message: 'Inspect' }), options), null);
  handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'spawn_agent', tool_use_id: 'spawn_agent-1', tool_input: {}, tool_response: JSON.stringify({ agent_id: id, nickname: null }) }, options);
  handleHook(prompt(session, '$stop-that-shit review agents=1 -- inspect'), options);
  assert.equal(handleHook(pre(session, 'multi_agent_v1wait_agent', { targets: [id] }), options), null);
  handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'multi_agent_v1wait_agent', tool_use_id: 'wait-1', tool_input: { targets: [id] }, tool_response: JSON.stringify({ status: { [id]: { completed: 'Done' } }, timed_out: false }) }, options);
  assert.equal(handleHook({ ...pre(session, 'spawn_agent', { message: 'Inspect next' }), tool_use_id: 'spawn-2' }, options), null);
  handleHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
  for (const name of ['multi_agent_v1send_input', 'multi_agent_v1resume_agent']) {
    const result = handleHook(pre(session, name, { id, message: 'Continue' }), options);
    assert.match(result?.hookSpecificOutput?.permissionDecisionReason, /DELEGATION_LIFECYCLE_UNPROVEN/);
  }
});

// Codex desktop 0.154.0-alpha.6.2 emits collaboration + tool name to hooks.
test('Codex desktop collaboration names obey no-delegation limits while reads remain available', (t) => {
  const options = workspace(t);
  const session = 'desktop-collaboration';
  handleHook(prompt(session, '$stop-that-shit change agents=0 -- no delegation'), options);
  const spawn = handleHook(pre(session, 'collaborationspawn_agent', { task_name: 'scout', message: 'Inspect' }), options);
  assert.match(spawn?.hookSpecificOutput?.permissionDecisionReason, /AGENT_BUDGET_EXHAUSTED/);
  const resume = handleHook(pre(session, 'collaborationfollowup_task', { target: '/root/scout', message: 'Continue' }), options);
  assert.match(resume?.hookSpecificOutput?.permissionDecisionReason, /DELEGATION_LIFECYCLE_UNPROVEN/);
  assert.equal(handleHook(pre(session, 'collaborationsend_message', { target: '/root/scout', message: 'Context only' }), options), null);
  handleHook(prompt(session, '$stop-that-shit review agents=0 -- inspect'), options);
  assert.equal(handleHook(pre(session, 'collaborationlist_agents', {}), options), null);
  assert.equal(handleHook(pre(session, 'collaborationwait_agent', { timeout_ms: 10000 }), options), null);
  assert.equal(handleHook(pre(session, 'mcp__example__collaborationlist_agents', {}), options)?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('Codex ordinary tool results do not contend with a delegation writer', (t) => {
  const options = workspace(t);
  const session = 'ordinary-results';
  handleHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
  handleHook(pre(session, 'spawn_agent', { message: 'Inspect' }), options);
  const before = readState(session, options.dataDir);
  const release = acquireSessionLock(session, options.dataDir);
  try {
    for (const tool_name of ['Bash', 'apply_patch', 'collaborationlist_agents', 'collaborationinterrupt_agent', 'mcp__example__read_file']) {
      assert.equal(handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name, tool_use_id: `result-${tool_name}`, tool_input: {}, tool_response: 'Done' }, options), null);
    }
    assert.equal(handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'collaborationwait_agent', tool_use_id: 'wait-1', tool_input: {}, tool_response: { message: 'Wait completed.', timed_out: false } }, options), null);
    assert.deepEqual(readState(session, options.dataDir), before);
  } finally {
    release();
  }
});

test('Codex read results do not create unused session state', (t) => {
  const options = workspace(t);
  handleHook({ session_id: 'unused-result', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'read-1', tool_input: { command: 'git status' }, tool_response: 'clean' }, options);
  assert.deepEqual(fs.readdirSync(options.dataDir), []);
});

test('Codex review permits stopping agents without treating previous status as completion', (t) => {
  const options = workspace(t);
  const session = 'cancel-review';
  handleHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
  handleHook(pre(session, 'spawn_agent', { message: 'Inspect' }), options);
  const id = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
  handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'spawn_agent', tool_use_id: 'spawn_agent-1', tool_input: { message: 'Inspect' }, tool_response: { agent_id: id, nickname: null } }, options);
  handleHook(prompt(session, '$stop-that-shit review agents=0 -- stop delegated work and report'), options);
  const before = readState(session, options.dataDir).delegation;
  for (const tool_name of ['interrupt_agent', 'collaborationinterrupt_agent', 'close_agent', 'multi_agent_v1close_agent']) {
    const tool_input = tool_name.endsWith('close_agent') ? { id } : { target: '/root/scout' };
    assert.equal(handleHook(pre(session, tool_name, tool_input), options), null);
    handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_name, tool_use_id: `${tool_name}-1`, tool_input, tool_response: { previous_status: { completed: 'Done' } } }, options);
  }
  assert.deepEqual(readState(session, options.dataDir).delegation, before);
  assert.equal(handleHook(pre(session, 'mcp__github__close_issue', { number: 50 }), options)?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('Codex audit records the same default delegation count used for admission', (t) => {
  const options = workspace(t);
  for (const budget of [0, 1]) {
    const session = `audit-default-count-${budget}`;
    handleHook(prompt(session, `$stop-that-shit change agents=${budget} -- inspect`), options);
    handleHook(pre(session, 'collaborationspawn_agent', { task_name: 'scout', message: 'PRIVATE_TASK' }), options);
    const [event] = readRuntime({ sessionId: session }, options).events;
    assert.equal(event.action.toolName, 'collaborationspawn_agent');
    assert.equal(event.action.delegationCount, 1);
    assert.equal(event.contract.reservedUpperBound, budget);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_TASK/);
  }
});
