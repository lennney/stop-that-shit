'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readState, statePath, freshState, writeState, updateSession } = require('../src/state.cjs');
const { parseContractPrompt } = require('../src/contracts.cjs');

test('a partial state write preserves the contract and ledger, cleans up, and releases the lock', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-write-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sessionId = 'partial-write';
  const state = freshState();
  state.contract = { ...state.contract, mode: 'review', level: 'guard', agentBudget: 1 };
  state.delegation = require('../src/delegation-state.cjs').applyDelegationFact(state.delegation,
    { kind: 'accepted', id: 'running-call', count: 1 });
  writeState(sessionId, state, dataDir);
  const file = statePath(sessionId, dataDir);
  const before = fs.readFileSync(file, 'utf8');
  const write = fs.writeFileSync;
  const failure = Object.assign(new Error('disk full after a partial write'), { code: 'ENOSPC' });
  const mock = t.mock.method(fs, 'writeFileSync', function (target, ...args) {
    if (String(target).startsWith(`${file}.`) && String(target).endsWith('.tmp')) {
      write.call(this, target, '{partial');
      throw failure;
    }
    return write.call(this, target, ...args);
  });
  try {
    assert.throws(() => updateSession(sessionId, dataDir, current => {
      current.contract.mode = 'change';
      current.delegation.reservations = {};
    }), error => error === failure);
  } finally {
    mock.mock.restore();
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  // A later successful update still sees the original reservation.
  updateSession(sessionId, dataDir, current => { current.contract.mode = 'change'; });
  const recovered = readState(sessionId, dataDir);
  assert.equal(recovered.contract.mode, 'change');
  assert.equal(recovered.delegation.reservations['reservation:running-call'].pendingCount, 1);
});

test('saved and in-memory legacy contracts preserve the same agent limit and authority', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-contract-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('migration', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unlimited = Number.MAX_SAFE_INTEGER;
  const cases = [
    [{ agentBudget: 0, concurrentAgentBudget: 2, totalAgentBudget: 7 }, 0],
    [{ agentBudget: unlimited, concurrentAgentBudget: 2 }, unlimited],
    [{ agentBudget: 7, concurrentAgentBudget: 2 }, 7],
    [{ concurrentAgentBudget: 0, totalAgentBudget: 7 }, 0],
    [{ concurrentAgentBudget: 2, totalAgentBudget: 0 }, 2],
    [{ concurrentAgentBudget: unlimited, totalAgentBudget: 0 }, 0],
    [{ concurrentAgentBudget: -1, totalAgentBudget: 3 }, 3],
    [{ totalAgentBudget: unlimited }, unlimited],
    [{}, unlimited]
  ];
  for (const [fields, expected] of cases) {
    const legacy = {
      mode: 'change', level: 'guard', hashPolicy: 'allow', dependencyPolicy: 'deny',
      allowedPaths: ['src/**'], source: 'directive', agentsUsed: 3, ...fields
    };
    const saved = JSON.stringify({ schemaVersion: 2, contract: legacy });
    fs.writeFileSync(file, saved);
    const fromDisk = readState('migration', dataDir).contract;
    const fromPrompt = parseContractPrompt('Continue', legacy).contract;
    const expectedContract = {
      mode: 'change', level: 'guard', hashPolicy: 'allow', dependencyPolicy: 'deny',
      allowedPaths: ['src/**'], source: 'directive', agentBudget: expected
    };
    assert.deepEqual(fromDisk, expectedContract, JSON.stringify(fields));
    assert.deepEqual(fromPrompt, expectedContract, JSON.stringify(fields));
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.equal(legacy.agentsUsed, 3);
  }
});

test('readState migrates legacy agent state to schema 4', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('legacy-session', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    contract: {
      mode: 'change',
      level: 'guard',
      agentBudget: 8,
      agentsUsed: 5,
      hashPolicy: 'allow',
      allowedPaths: ['src/**'],
      dependencyPolicy: 'deny',
      source: 'directive'
    },
    lastPromptContext: 'legacy context'
  }));

  const state = readState('legacy-session', dataDir);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.contract.mode, 'change');
  assert.equal(state.contract.hashPolicy, 'allow');
  assert.deepEqual(state.contract.allowedPaths, ['src/**']);
  assert.equal(state.contract.agentBudget, 8);
  assert.equal('totalAgentBudget' in state.contract, false);
  assert.equal('concurrentAgentBudget' in state.contract, false);
  assert.equal('agentsUsed' in state.contract, false);
  assert.deepEqual(state.delegation.reservations, {});
  assert.deepEqual(state.delegation.agentIdsSeen, []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 1);
  require('../src/controller.cjs').handleControlEvent({ protocolVersion: 1,
    kind: 'prompt.submit', sessionId: 'legacy-session', prompt: 'Continue' }, { dataDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).delegation.agentIdsSeen, []);
  assert.equal(state.directiveError, null);
  assert.equal(state.directiveWarning, null);
  assert.equal(state.lastPromptContext, null);
});

test('readState preserves a legacy zero agent budget', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-zero-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('legacy-zero', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    contract: { mode: 'change', level: 'guard', agentBudget: 0, agentsUsed: 2 }
  }));

  const state = readState('legacy-zero', dataDir);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.contract.agentBudget, 0);
  assert.equal('totalAgentBudget' in state.contract, false);
  assert.deepEqual(state.delegation.reservations, {});
});

test('readState migrates current split state conservatively', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-split-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('split-session', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    contract: {
      mode: 'change',
      level: 'guard',
      totalAgentBudget: 0,
      concurrentAgentBudget: Number.MAX_SAFE_INTEGER,
      directiveWarning: { code: 'DEPRECATED_AGENT_DIRECTIVE' }
    },
    delegation: {
      totalAgentsUsed: 9,
      reservations: {
        'reservation:old-call': {
          actionId: 'old-call',
          asyncLaunched: true,
          pendingCount: 1,
          agentIds: ['agent-old']
        }
      },
      agentIdsSeen: ['agent-old'],
      stoppedAgentIds: ['agent-stopped'],
      acceptedActions: { 'old-call': 2 }
    },
    directiveWarning: { code: 'DEPRECATED_AGENT_DIRECTIVE' },
    directiveError: null,
    lastPromptContext: 'old split context'
  }));

  const state = readState('split-session', dataDir);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.contract.agentBudget, 0);
  assert.equal(state.delegation.totalAgentsUsed, undefined);
  assert.equal(state.delegation.reservations['reservation:old-call'].pendingCount, 1);
  assert.deepEqual(state.delegation.agentIdsSeen, ['agent-old']);
  assert.deepEqual(state.delegation.stoppedAgentIds, ['agent-stopped']);
  assert.deepEqual(state.delegation.acceptedActions, { 'old-call': 2 });
  assert.equal(state.directiveWarning, null);
  assert.equal(state.lastPromptContext, null);
});

test('readState prefers a finite previous concurrent limit over total limit', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-priority-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('priority-session', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    contract: { totalAgentBudget: 7, concurrentAgentBudget: 2 }
  }));

  assert.equal(readState('priority-session', dataDir).contract.agentBudget, 2);
});
