'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const bridge = require('../dsh/lib/bridge.cjs');

function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-dsh-bridge-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  const docs = path.join(workspace, 'docs');
  const nested = path.join(workspace, 'elsewhere');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(path.join(nested, 'docs'), { recursive: true });
  const listeners = new Map();
  bridge.apply({
    on: (event, listener) => listeners.set(event, listener),
    subagents: {
      rootOf(agent) {
        if (agent.detached) throw Object.assign(new Error('Missing live root'), { code: 'UNAUTHORIZED' });
        return agent.root || agent;
      }
    },
    workingDirectory: { get: (session) => session.cwd }
  }, { dataDir: path.join(temp, 'state') });

  return {
    workspace, docs, nested,
    arm(agent, directive) {
      const messages = [{ source: { kind: 'user' }, content: [{ text: directive }] }];
      return listeners.get('agent/pre-step')({ agent, messages, turn: 1 }, () => ({ kind: 'enter', messages }));
    },
    tool(agent, name, file, next) {
      return listeners.get('tools/pre-execute')({ agent, name, arguments: { file_path: file }, callId: `${agent.session.id}:${file}` }, next);
    }
  };
}

function agent(id, cwd, parentSession) {
  return { session: { id, header: { cwd, parentSession }, cwd } };
}

test('DSH bridge uses live delegation identity and treats ordinary forks as independent', async (t) => {
  const { workspace, docs, arm, tool } = setup(t);
  const root = agent('root', workspace);
  const child = { ...agent('child', workspace, 'offline-intermediate'), root };
  const fork = agent('fork', workspace, root.session.id);
  await arm(root, '$stop-that-shit review lock');
  await arm(child, '$stop-that-shit change lock files=docs/**');
  await arm(fork, '$stop-that-shit change lock files=docs/**');

  const target = path.join(docs, 'ok.md');
  const write = () => { fs.writeFileSync(target, 'allowed'); return 'wrote'; };
  const rejected = await tool(child, 'write', 'docs/ok.md', write);
  assert.match(rejected.reason, /MODE_FORBIDS_MUTATION/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(await tool(child, 'read', 'docs/ok.md', () => 'read'), 'read');
  assert.equal(await tool(fork, 'write', 'docs/ok.md', write), 'wrote');
  assert.equal(fs.readFileSync(target, 'utf8'), 'allowed');

  const detached = { ...agent('detached', workspace), detached: true };
  const missing = await tool(detached, 'write', 'docs/ok.md', () => assert.fail('unknown root ran'));
  assert.match(missing.reason, /verified root session/);
});

test('DSH bridge compares tool paths against the contract workspace after a directory change', async (t) => {
  const { workspace, docs, nested, arm, tool } = setup(t);
  const root = agent('root', workspace);
  await arm(root, '$stop-that-shit change lock files=docs/**');
  root.session.cwd = nested;

  const misplaced = path.join(nested, 'docs', 'note.md');
  const rejected = await tool(root, 'write', 'docs/note.md', () => fs.writeFileSync(misplaced, 'outside'));
  assert.match(rejected.reason, /PATH_OUTSIDE_CONTRACT/);
  assert.equal(fs.existsSync(misplaced), false);

  const target = path.join(docs, 'note.md');
  await tool(root, 'write', '../docs/note.md', () => fs.writeFileSync(target, 'inside'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'inside');
});
