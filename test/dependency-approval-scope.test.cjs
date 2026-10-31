'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleHook } = require('../src/hook-policy.cjs');
const stateStore = require('../src/state.cjs');
const contracts = require('../src/contracts.cjs');
const approvalScope = require('../src/approval-scope.cjs');
const { policyDigest } = approvalScope;
const { spawnSync } = require('node:child_process');
const { readRuntime } = require('../src/runtime-audit.cjs');

// Scope tests fingerprint package managers but must never depend on a host install.
const managerFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-scope-managers-'));
const previousPath = process.env.PATH;
const pnpmBin = path.join(managerFixture, 'node_modules', 'pnpm', 'bin');
fs.mkdirSync(pnpmBin, { recursive: true });
fs.writeFileSync(path.join(pnpmBin, 'pnpm.cjs'), '// test-only manager fixture\n');
process.env.PATH = [managerFixture, previousPath || ''].join(path.delimiter);
test.after(() => {
  process.env.PATH = previousPath;
  fs.rmSync(managerFixture, { recursive: true, force: true });
});

function supportsScopedState(sessionId, agentId, dataDir) {
  return typeof stateStore.childStatePath === 'function'
    && typeof contracts.narrowContract === 'function'
    && stateStore.childStatePath(sessionId, agentId, dataDir) !== stateStore.statePath(sessionId, dataDir);
}

test('approval policy digest binds only decision-relevant effective contract fields', () => {
  const contract = { mode: 'change', level: 'guard', hashPolicy: 'deny', dependencyPolicy: 'ask',
    allowedPaths: ['src', 'test'], agentBudget: 5, updatedAt: 'one', usageCount: 1 };
  const initial = policyDigest(contract);
  assert.equal(policyDigest({ ...contract, updatedAt: 'two', usageCount: 100, agentBudget: 1 }), initial);
  assert.notEqual(policyDigest({ ...contract, dependencyPolicy: 'deny' }), initial);
  assert.notEqual(policyDigest({ ...contract, allowedPaths: ['src'] }), initial);
  assert.equal(policyDigest({ ...contract, allowedPaths: ['test', 'src'] }), initial);
  if (typeof contracts.narrowContract === 'function') {
    const childWithPartialDirective = { ...contract, mode: 'unconfirmed', dependencyPolicy: 'deny', source: 'directive' };
    const parent = { ...contract, mode: 'change', dependencyPolicy: 'allow' };
    assert.deepEqual(approvalScope.effectiveChildContract(parent, childWithPartialDirective),
      contracts.narrowContract(parent, childWithPartialDirective),
      'effective child policy uses the host contract API without special defaults');
  }
});

test('root dependency digest retains the d0 byte-compatible shape while child digest adds identity', () => {
  const { digest } = require('../src/action-approval.cjs');
  const event = { sessionId: 'legacy-root', action: { id: 'legacy-action', name: 'Bash', cwd: '/legacy/repo',
    input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } } };
  const legacyDigest = '1d914edf24931693185e41bb5bd12570ab502babf5b3b7937157e5c4d0ca1c09';
  assert.equal(digest(event), legacyDigest);
  assert.notEqual(digest({ ...event, agent: { agentId: 'child-agent-scope' } }), legacyDigest);
});

test('child dependency and contract events never fall back to the parent when scoped state is unavailable', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-approval-scope-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sessionId = 'parent-allow-child-deny';
  const agentId = 'child-agent-approval-scope';
  const base = { session_id: sessionId, turn_id: 'turn-1', cwd: process.cwd() };
  const input = { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' };
  const prompt = (text, scope = {}) => handleHook({ ...base, ...scope,
    hook_event_name: 'UserPromptSubmit', prompt: text }, { dataDir });
  const before = (id, scope = {}) => handleHook({ ...base, ...scope, hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_use_id: id, tool_input: input }, { dataDir });
  const scopedStateAvailable = typeof stateStore.childStatePath === 'function'
    && typeof contracts.narrowContract === 'function'
    && stateStore.childStatePath(sessionId, agentId, dataDir) !== stateStore.statePath(sessionId, dataDir);

  prompt('$stop-that-shit change deps=allow -- parent install');
  const parentFile = stateStore.statePath(sessionId, dataDir);
  const originalTime = new Date(Date.now() - 120000);
  fs.utimesSync(parentFile, originalTime, originalTime);
  const originalMtime = fs.statSync(parentFile).mtimeMs;

  const childPrompt = prompt('$stop-that-shit review deps=deny -- child install', { agent_id: agentId });
  assert.equal(fs.statSync(parentFile).mtimeMs, originalMtime, 'child contract prompt must not write the parent ledger');
  const parentAfterPrompt = stateStore.readState(sessionId, dataDir);
  assert.equal(parentAfterPrompt.contract.mode, 'change', 'child prompt must not replace the parent mode');
  assert.equal(parentAfterPrompt.contract.dependencyPolicy, 'allow', 'child prompt must not replace the parent dependency policy');
  if (!scopedStateAvailable) {
    const parentFile = stateStore.statePath(sessionId, dataDir);
    const aged = new Date(Date.now() - 120000);
    fs.utimesSync(parentFile, aged, aged);
    const beforeRead = fs.statSync(parentFile).mtimeMs;
    const ordinaryAsync = handleHook({ ...base, agent_id: agentId, hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async', tool_use_id: 'child-ordinary-async-question',
      tool_input: { questions: [{ title: 'What should I inspect next?', options: ['Read the docs', 'Check the tests'] }] } }, { dataDir });
    assert.equal(ordinaryAsync, null, 'lack of child APIs must not block an ordinary async clarification');
    assert.equal(fs.statSync(parentFile).mtimeMs, beforeRead, 'ordinary async clarification does not write the parent ledger');
    const ordinaryRead = handleHook({ ...base, agent_id: agentId, hook_event_name: 'PreToolUse',
      tool_name: 'Read', tool_use_id: 'child-ordinary-read',
      tool_input: { file_path: path.join(process.cwd(), 'README.md') } }, { dataDir });
    assert.equal(ordinaryRead, null, 'lack of PR109 APIs must not block an ordinary child read');
    assert.equal(fs.statSync(parentFile).mtimeMs, beforeRead, 'ordinary child reads do not write the parent ledger');
  }
  if (!scopedStateAvailable) {
    assert.equal(childPrompt.decision, 'block', 'unsupported child contract changes fail closed');
  } else {
    assert.notEqual(childPrompt?.hookSpecificOutput?.additionalContext, undefined);
    const child = stateStore.readState(sessionId, dataDir, { agentId });
    assert.equal(child.contract.mode, 'review');
    assert.equal(child.contract.dependencyPolicy, 'deny');
  }

  const childAttempt = before('child-install', { agent_id: agentId });
  if (scopedStateAvailable) {
    assert.equal(childAttempt?.hookSpecificOutput?.permissionDecision, 'deny',
      'the effective child contract must deny the dependency operation');
  } else {
    assert.equal(childAttempt, null,
      'without child state APIs, retain the generic parent deps=allow decision without touching approval state');
  }
  assert.equal(before('parent-install'), null, 'the parent deps=allow contract continues to allow its operation');
});

test('without scoped APIs, child dependency intents retain generic parent decision semantics without approval state', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-child-dependency-fallback-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'child-dependency-fallback-no-api';
  const agent_id = 'child-agent-dependency-fallback';
  if (supportsScopedState(session_id, agent_id, dataDir)) {
    t.skip('the generic fallback is only used by standalone PR120 without PR109 scoped APIs');
    return;
  }
  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const options = { dataDir };
  const prompt = (text, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const install = (id, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } }, options);

  assert.equal(install('default-watch', true), null,
    'a fresh child should preserve the parent default watch decision without a false approval denial');
  assert.equal(readRuntime({ sessionId: session_id }, options).events[0]?.decision.reasonCode, 'CONTROL_INACTIVE',
    'the default watch attempt remains recorded as an observation');
  assert.equal(stateStore.readState(session_id, dataDir).actionApproval, null,
    'default watch must not create a root approval proposal');

  prompt('$stop-that-shit review watch deps=ask -- parent watch');
  assert.equal(stateStore.readState(session_id, dataDir).contract.mode, 'review');
  assert.equal(stateStore.readState(session_id, dataDir).contract.level, 'watch');
  const watched = install('explicit-watch', true);
  assert.equal(watched?.hookSpecificOutput?.permissionDecision, undefined,
    'explicit watch reports instead of denying a child dependency intent');
  assert.match(watched?.hookSpecificOutput?.additionalContext || watched?.systemMessage || '', /WATCH/,
    JSON.stringify(watched));
  assert.equal(stateStore.readState(session_id, dataDir).actionApproval, null);

  prompt('$stop-that-shit change deps=ask -- root approval remains root-owned');
  install('root-proposal');
  const denied = install('root-proposal');
  assert.equal(denied?.hookSpecificOutput?.permissionDecision, 'deny');
  const parentRecord = stateStore.readState(session_id, dataDir).actionApproval;
  assert.equal(parentRecord.status, 'pending');
  const childDenied = install('child-cannot-reuse-parent-proposal', true);
  assert.equal(childDenied?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.doesNotMatch(childDenied?.hookSpecificOutput?.permissionDecisionReason || '', /Approval question:/,
    'the child cannot issue a root proposal card');
  assert.deepEqual(stateStore.readState(session_id, dataDir).actionApproval, parentRecord,
    'child attempts do not consume, rewrite, or issue the root approval');
  assert.equal(parentRecord.ticket, undefined);
  assert.equal(parentRecord.handoff, undefined);
});

test('a parent approval is never a child approval', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-approval-parent-child-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'parent-approval-not-child';
  const agent_id = 'child-agent-approval-scope';
  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const command = 'pnpm install --offline --frozen-lockfile --ignore-scripts';
  const prompt = text => handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: text }, { dataDir });
  const before = (id, tool_name = 'Bash', agent_id) => handleHook({ ...base, agent_id,
    hook_event_name: 'PreToolUse', tool_name, tool_use_id: id,
    tool_input: tool_name === 'Bash' ? { command } : { questions: [question] } }, { dataDir });
  const scopedStateAvailable = typeof stateStore.childStatePath === 'function'
    && typeof contracts.narrowContract === 'function'
    && stateStore.childStatePath(session_id, agent_id, dataDir) !== stateStore.statePath(session_id, dataDir);

  prompt('$stop-that-shit change deps=ask -- exact install');
  handleHook({ ...base, agent_id, hook_event_name: 'UserPromptSubmit',
    prompt: '$stop-that-shit change deps=ask -- child owns a separate approval' }, { dataDir });
  before('parent-approval-action');
  const denial = before('parent-approval-action');
  const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denial.hookSpecificOutput.permissionDecisionReason);
  assert.ok(match);
  const question = { id: 'parent-card-id', header: 'Approval',
    question: `${match[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd()))}`,
    options: [
      { label: match[2], description: 'Authorize this operation once.' },
      { label: match[3], description: 'Do not authorize this operation.' }
    ] };
  assert.equal(before('parent-question-card', 'request_user_input'), null);
  const registered = stateStore.readState(session_id, dataDir).actionApproval;
  assert.equal(registered.status, 'question');
  handleHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'request_user_input',
    tool_use_id: 'parent-question-card', tool_input: { questions: [question] },
    tool_response: { answers: { [question.id]: { answers: [match[2]] } } } }, { dataDir });
  assert.equal(stateStore.readState(session_id, dataDir).actionApproval.status, 'approved');

  const child = before('child-retry', 'Bash', agent_id);
  assert.equal(child?.hookSpecificOutput?.permissionDecision, 'deny', 'child cannot consume a parent-scoped approval');
  assert.equal(stateStore.readState(session_id, dataDir).actionApproval.status, 'approved');
  if (scopedStateAvailable) {
    assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval.status, 'pending',
      'the child can receive a distinct proposal under its own ledger');
  }
});

test('an explicit child review contract denies dependency work while the parent change contract allows it', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-child-review-policy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'parent-change-child-review';
  const agent_id = 'child-review-policy';
  if (!supportsScopedState(session_id, agent_id, dataDir)) {
    t.skip('requires PR109 scoped child-state APIs');
    return;
  }
  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const options = { dataDir };
  const prompt = (text, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const install = (id, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } }, options);

  prompt('$stop-that-shit change deps=allow -- parent permits this dependency');
  prompt('$stop-that-shit review -- child remains read-only', true);
  const child = install('child-review-install', true);
  assert.equal(child?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).contract.mode, 'review');
  assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval, null,
    'a review decision cannot create a change-mode one-time approval');
  assert.equal(install('parent-change-install'), null,
    'the matching parent operation remains allowed by the parent change contract');
});

test('a fresh child partial directive preserves PR109 raw child defaults and stays child-owned', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-child-partial-directive-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'child-partial-directive-inherit';
  const agent_id = 'child-agent-partial-directive';
  if (!supportsScopedState(session_id, agent_id, dataDir)) {
    t.skip('requires the real childStatePath and narrowContract APIs from PR109 integration');
    return;
  }
  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const options = { dataDir };
  const prompt = (text, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const action = (id, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id,
    tool_input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } }, options);
  prompt('$stop-that-shit change deps=allow hash=allow -- parent permits');
  prompt('$stop-that-shit deps=deny -- child narrows only dependencies', true);
  const child = stateStore.readState(session_id, dataDir, { agentId: agent_id });
  assert.equal(child.contract.mode, 'unconfirmed', 'partial directive leaves the child raw mode at its default');
  assert.equal(child.contract.hashPolicy, 'deny', 'partial directive leaves the child raw hash policy at its default');
  assert.equal(child.contract.allowedPaths, null, 'parent file bounds stay effective-only, not copied into child raw state');
  assert.equal(child.contract.dependencyPolicy, 'deny');
  const parentContract = stateStore.readState(session_id, dataDir).contract;
  assert.deepEqual(approvalScope.effectiveChildContract(parentContract, child.contract),
    contracts.narrowContract(parentContract, child.contract));
  assert.equal(stateStore.readState(session_id, dataDir).contract.dependencyPolicy, 'allow',
    'the child directive does not mutate parent state');
  assert.equal(action('child-unconfirmed', true), null,
    'a partial directive does not activate a child change approval or inherit the parent change mode');
  assert.equal(action('parent-allowed'), null);
});

test('an uninitialized child matches the host narrowContract default without creating an approval', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-approval-scope-inherit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'parent-ask-child-default';
  const agent_id = 'child-agent-inherited-policy';
  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const options = { dataDir };
  const prompt = (text, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const parentAction = () => handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'parent-action', tool_input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } }, options);
  const childAction = () => handleHook({ ...base, agent_id, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_use_id: 'child-action', tool_input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } }, options);
  prompt('$stop-that-shit change deps=ask -- parent policy');
  assert.equal(parentAction()?.hookSpecificOutput?.permissionDecision, 'deny');
  const parentRecord = stateStore.readState(session_id, dataDir).actionApproval;
  const { childStatePath } = stateStore;
  const supported = typeof childStatePath === 'function' && typeof contracts.narrowContract === 'function'
    && childStatePath(session_id, agent_id, dataDir) !== stateStore.statePath(session_id, dataDir);
  const childRaw = supported ? stateStore.readState(session_id, dataDir, { agentId: agent_id }).contract : contracts.defaultContract();
  const parentContract = stateStore.readState(session_id, dataDir).contract;
  const hostEffective = supported ? contracts.narrowContract(parentContract, childRaw) : parentContract;
  const childResult = childAction();
  assert.deepEqual(supported ? approvalScope.effectiveChildContract(parentContract, childRaw) : parentContract, hostEffective);
  if (supported) {
    assert.equal(childResult, null,
      'a fresh child remains at the host default; it does not automatically open a deps=ask approval card');
  } else {
    assert.equal(childResult?.hookSpecificOutput?.permissionDecision, 'deny',
      'without scoped APIs, the standalone fallback denies deps=ask without consuming parent approval');
  }
  assert.equal(stateStore.readState(session_id, dataDir).contract.dependencyPolicy, 'ask');
  if (supported) {
    const childState = stateStore.readState(session_id, dataDir, { agentId: agent_id });
    assert.equal(childState.contract.source, 'default', 'effective parent policy stays out of child state');
    assert.equal(childState.actionApproval, null, 'fresh child default creates no child approval proposal');
    assert.deepEqual(stateStore.readState(session_id, dataDir).actionApproval, parentRecord,
      'child default evaluation does not consume or rewrite a parent approval');
  }
});

test('without scoped APIs, child delegation still shares the original parent budget', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-child-budget-fallback-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'child-budget-no-scope-api';
  const agent_id = 'child-agent-global-budget';
  if (supportsScopedState(session_id, agent_id, dataDir)) {
    t.skip('the shared-budget fallback is specific to standalone PR120 without scoped APIs');
    return;
  }
  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const options = { dataDir };
  handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '$stop-that-shit change agents=1 -- child budget' }, options);
  const spawn = id => handleHook({ ...base, agent_id, hook_event_name: 'PreToolUse', tool_name: 'spawn_agent',
    tool_use_id: id, tool_input: { task: `bounded child ${id}` } }, options);
  assert.equal(spawn('first-child-spawn'), null);
  const parentAfterFirst = stateStore.readState(session_id, dataDir);
  assert.equal(require('../src/delegation-state.cjs').inspectDelegation(parentAfterFirst.delegation).reservedUpperBound, 1);
  const second = spawn('second-child-spawn');
  assert.equal(second?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /AGENT_BUDGET_EXHAUSTED/);
  assert.equal(stateStore.readState(session_id, dataDir).actionApproval, null, 'child delegation does not write approval state');
});

test('scoped answer and fresh runner process recheck the latest parent contract', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-approval-scope-runner-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'scope-runner-policy-recheck';
  const agent_id = 'child:/子/δ';
  if (!supportsScopedState(session_id, agent_id, dataDir)) {
    t.skip('requires the real childStatePath and narrowContract APIs from PR109 integration');
    return;
  }

  const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-scope-manager-'));
  t.after(() => fs.rmSync(managerRoot, { recursive: true, force: true }));
  const entry = path.join(managerRoot, 'node_modules', 'pnpm', 'bin');
  fs.mkdirSync(entry, { recursive: true });
  const marker = path.join(managerRoot, 'manager-ran.txt');
  fs.writeFileSync(path.join(entry, 'pnpm.cjs'), "require('node:fs').writeFileSync(process.env.STS_TEST_MARKER, 'ran');\n");
  const oldPath = process.env.PATH;
  process.env.PATH = [managerRoot, oldPath || ''].join(path.delimiter);
  t.after(() => { process.env.PATH = oldPath; });

  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const options = { dataDir };
  const prompt = (text, child = false) => handleHook({ ...base, ...(child ? { agent_id } : {}),
    hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const command = 'pnpm install --offline --frozen-lockfile --ignore-scripts';
  const action = (id, tool_name, child = true, input = { command }) => handleHook({ ...base,
    ...(child ? { agent_id } : {}), hook_event_name: 'PreToolUse', tool_name, tool_use_id: id,
    tool_input: input }, options);
  prompt('$stop-that-shit change deps=ask -- parent asks');
  prompt('$stop-that-shit change deps=ask -- child explicitly enables its own approval', true);
  const denied = action('child-dependency', 'Bash');
  assert.equal(denied?.hookSpecificOutput?.permissionDecision, 'deny');
  const record = stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval;
  assert.equal(record.status, 'pending');
  const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
  assert.ok(match);
  const question = { id: 'child-native-approval', header: 'Approval',
    question: match[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd())),
    options: [
      { label: match[2], description: 'Authorize this operation once.' },
      { label: match[3], description: 'Do not authorize this operation.' }
    ] };
  assert.equal(action('child-question', 'request_user_input', true, { questions: [question] }), null);
  handleHook({ ...base, agent_id, hook_event_name: 'PostToolUse', tool_name: 'request_user_input',
    tool_use_id: 'child-question', tool_input: { questions: [question] },
    tool_response: { answers: { [question.id]: { answers: [match[2]] } } } }, options);
  assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval.status, 'approved');

  const retry = action('child-retry', 'Bash');
  assert.equal(retry?.hookSpecificOutput?.permissionDecision, 'allow');
  const issued = stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval;
  assert.equal(issued.status, 'issued');
  prompt('$stop-that-shit change deps=deny -- tighten before runner claim');

  const runnerPath = path.join(__dirname, '..', 'src', 'dependency-runner.cjs');
  const invocation = `require(${JSON.stringify(runnerPath)}).run(process.argv[1], process.argv[2], process.argv[3], process.argv[4]);`;
  const result = spawnSync(process.execPath, ['-e', invocation, session_id, dataDir, issued.ticket, agent_id], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: process.env.PATH, STS_TEST_MARKER: marker }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /current policy|Approval is unavailable/i);
  assert.equal(fs.existsSync(marker), false, 'a fresh runner process must not spawn after parent policy tightens');
  assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval.status, 'issued');

  const hashSession = 'scope-runner-irrelevant-hash-change';
  const hashAgent = 'child-agent-hash-policy';
  const hashBase = { session_id: hashSession, turn_id: 'turn-1', cwd: process.cwd() };
  const hashPrompt = (text, child = false) => handleHook({ ...hashBase, ...(child ? { agent_id: hashAgent } : {}),
    hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const hashAction = (id, tool_name, input = { command }, child = true) => handleHook({ ...hashBase,
    ...(child ? { agent_id: hashAgent } : {}), hook_event_name: 'PreToolUse', tool_name, tool_use_id: id,
    tool_input: input }, options);
  hashPrompt('$stop-that-shit change deps=ask hash=deny -- initial policy');
  hashPrompt('$stop-that-shit change deps=ask hash=deny -- child opts into approval', true);
  const hashDenied = hashAction('hash-child-command', 'Bash');
  const hashMatch = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(hashDenied.hookSpecificOutput.permissionDecisionReason);
  assert.ok(hashMatch);
  const hashQuestion = { id: 'hash-child-qid', header: 'Approval',
    question: hashMatch[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd())),
    options: [
      { label: hashMatch[2], description: 'Authorize this operation once.' },
      { label: hashMatch[3], description: 'Do not authorize this operation.' }
    ] };
  hashAction('hash-child-card', 'request_user_input', { questions: [hashQuestion] });
  handleHook({ ...hashBase, agent_id: hashAgent, hook_event_name: 'PostToolUse', tool_name: 'request_user_input',
    tool_use_id: 'hash-child-card', tool_input: { questions: [hashQuestion] },
    tool_response: { answers: { [hashQuestion.id]: { answers: [hashMatch[2]] } } } }, options);
  const hashRetry = hashAction('hash-child-retry', 'Bash');
  assert.equal(hashRetry?.hookSpecificOutput?.permissionDecision, 'allow');
  const hashRecord = stateStore.readState(hashSession, dataDir, { agentId: hashAgent }).actionApproval;
  assert.equal(hashRecord.proposedAction.hashIntent, false);
  assert.equal(hashRecord.status, 'issued');
  hashPrompt('$stop-that-shit change deps=ask hash=allow -- harmless policy change');
  const markerAfterHarmlessChange = path.join(managerRoot, 'manager-ran-after-hash-change.txt');
  const hashInvocation = `require(${JSON.stringify(runnerPath)}).run(process.argv[1], process.argv[2], process.argv[3], process.argv[4]);`;
  const hashResult = spawnSync(process.execPath, ['-e', hashInvocation, hashSession, dataDir, hashRecord.ticket, hashAgent], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: process.env.PATH, STS_TEST_MARKER: markerAfterHarmlessChange }
  });
  assert.equal(hashResult.status, 0, hashResult.stderr);
  assert.equal(fs.readFileSync(markerAfterHarmlessChange, 'utf8'), 'ran',
    'hash=deny to hash=allow does not invalidate an operation with hashIntent=false');

  const answerSession = 'scope-answer-policy-recheck';
  const answerAgent = 'child-agent-answer-policy';
  const answerBase = { session_id: answerSession, turn_id: 'turn-1', cwd: process.cwd() };
  const answerPrompt = (text, child = false) => handleHook({ ...answerBase,
    ...(child ? { agent_id: answerAgent } : {}), hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const answerAction = (id, tool_name, child = true, input = { command }) => handleHook({ ...answerBase,
    ...(child ? { agent_id: answerAgent } : {}), hook_event_name: 'PreToolUse', tool_name, tool_use_id: id,
    tool_input: input }, options);
  answerPrompt('$stop-that-shit change deps=ask -- ask before answer');
  answerPrompt('$stop-that-shit change deps=ask -- child opts into approval', true);
  const answerDenied = answerAction('answer-child-dependency', 'Bash');
  const answerMatch = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(answerDenied.hookSpecificOutput.permissionDecisionReason);
  assert.ok(answerMatch);
  const answerQuestion = { id: 'answer-race-qid', header: 'Approval',
    question: answerMatch[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd())),
    options: [
      { label: answerMatch[2], description: 'Authorize this operation once.' },
      { label: answerMatch[3], description: 'Do not authorize this operation.' }
    ] };
  answerAction('answer-race-call', 'request_user_input', true, { questions: [answerQuestion] });
  const wrongScope = handleHook({ ...answerBase, agent_id: 'different-child-agent',
    hook_event_name: 'PostToolUse', tool_name: 'request_user_input', tool_use_id: 'answer-race-call',
    tool_input: { questions: [answerQuestion] },
    tool_response: { answers: { [answerQuestion.id]: { answers: [answerMatch[2]] } } } }, options);
  assert.equal(wrongScope, null, 'a matching call/question ID in another child scope is not an answer');
  assert.equal(stateStore.readState(answerSession, dataDir, { agentId: answerAgent }).actionApproval.status, 'question');
  answerPrompt(match && match[2], true);
  assert.equal(stateStore.readState(answerSession, dataDir, { agentId: answerAgent }).actionApproval.status, 'question',
    'ordinary text that looks like an option label is not consent');
  answerPrompt('ordinary child follow-up', true);
  assert.equal(stateStore.readState(answerSession, dataDir, { agentId: answerAgent }).actionApproval.status, 'question');
  answerPrompt('$stop-that-shit change deps=deny -- parent tightens before answer');
  handleHook({ ...answerBase, agent_id: answerAgent, hook_event_name: 'PostToolUse',
    tool_name: 'request_user_input', tool_use_id: 'answer-race-call',
    tool_input: { questions: [answerQuestion] },
    tool_response: { answers: { [answerQuestion.id]: { answers: [answerMatch[2]] } } } }, options);
  assert.equal(stateStore.readState(answerSession, dataDir, { agentId: answerAgent }).actionApproval.status, 'question',
    'the latest parent policy must veto a stale affirmative answer');
});

test('asynchronous proposal replies remain inside the registered child scope', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-child-async-scope-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'child-async-answer-scope';
  const agent_id = 'child-agent-async-answer';
  if (!supportsScopedState(session_id, agent_id, dataDir)) {
    t.skip('requires the real childStatePath and narrowContract APIs from PR109 integration');
    return;
  }
  const base = { session_id, turn_id: 'turn-1', cwd: process.cwd() };
  const options = { dataDir };
  const command = 'pnpm install --offline --frozen-lockfile --ignore-scripts';
  const prompt = (text, child = true, id = agent_id) => handleHook({ ...base,
    ...(child ? { agent_id: id } : {}), hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const before = (id, tool_name, input, child = true, agent = agent_id) => handleHook({ ...base,
    ...(child ? { agent_id: agent } : {}), hook_event_name: 'PreToolUse', tool_name, tool_use_id: id,
    tool_input: input }, options);
  prompt('$stop-that-shit change deps=ask -- async child approval', false);
  prompt('$stop-that-shit change deps=ask -- child opts into approval', true);
  const denied = before('async-child-action', 'Bash', { command });
  const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
  assert.ok(match);
  const question = match[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd()));
  assert.equal(before('async-child-question', 'request_user_input_async', {
    questions: [{ title: question, options: [match[2], match[3]] }]
  }), null);
  const record = stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval;
  assert.equal(record.status, 'question');
  const answerText = `<send_user_message_question_reply>${JSON.stringify([{
    questionItemId: record.questionId, question: record.question, answer: match[2]
  }])}</send_user_message_question_reply>`;
  prompt(answerText, true, 'different-child-agent');
  assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval.status, 'question',
    'an identical question ID and reply in another child does not change the registered record');
  prompt(match[2]);
  assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval.status, 'question',
    'plain option text is not a structured async answer');
  const accepted = prompt(answerText);
  assert.match(accepted?.hookSpecificOutput?.additionalContext || '', /One-time approval is available/);
  assert.equal(stateStore.readState(session_id, dataDir, { agentId: agent_id }).actionApproval.status, 'approved');
  assert.equal(stateStore.readState(session_id, dataDir).actionApproval, null,
    'the parent ledger does not receive the child approval');
});
