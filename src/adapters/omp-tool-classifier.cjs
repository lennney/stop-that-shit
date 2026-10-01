'use strict';

const pi = require('./pi-tool-classifier.cjs');
const { normalizePath } = require('./opencode-tool-classifier.cjs');
const codex = require('./codex-tool-classifier.cjs');
const { manifestDependencyIntent, manifestEditDependencyIntent, patchDependencyIntent } = require('../manifest-dependencies.cjs');
const HUB_READ = new Set(['wait', 'inbox', 'list', 'jobs', 'ps', 'logs', 'describe']);

function editDependencyIntent(input) {
  if (typeof input.input === 'string') {
    return patchDependencyIntent(input.input.replace(/^\[(.+)#[0-9a-fA-F]{4}\]$/gm, '*** Update File: $1'));
  }
  if (!Array.isArray(input.edits)) {
    return manifestEditDependencyIntent(input.path, input.old_string, input.new_string);
  }
  return input.edits.some(edit => edit && (edit.op === 'create'
    ? manifestDependencyIntent(input.path, edit.diff)
    : typeof edit.new_string === 'string'
      ? manifestEditDependencyIntent(input.path, edit.old_string, edit.new_string)
      : patchDependencyIntent(`*** Update File: ${input.path}\n${edit.diff || ''}`)));
}

function classifyOmpAction(name, input, cwd) {
  const protocolPath = typeof input.path === 'string' ? input.path.trim() : '';
  if (name === 'write' && /^(?:agent|proc):\/\//i.test(protocolPath)) {
    // These are native protocol effects, not filesystem writes. Agent mail
    // can wake one or many parked agents without a call-qualified lifecycle.
    return {
      mutability: /^proc:\/\/[^/]+\/kill$/i.test(protocolPath) ? 'control' : 'unknown',
      affectedPaths: [], delegationCount: 0, unboundedDelegation: false,
      delegationLifecycleUnproven: /^agent:\/\//i.test(protocolPath),
      dependencyIntent: false, hashIntent: false
    };
  }
  const task = name === 'task';
  const batch = Array.isArray(input.tasks) && input.tasks.length > 0;
  const validTask = batch ? input.tasks.every(item => typeof item?.task === 'string' && item.task.trim())
    : typeof input.task === 'string' && input.task.trim();
  let mutability = pi.classifyPiTool(name, input);
  if (task) mutability = 'delegate';
  if (name === 'subagent') mutability = 'unknown';
  if (['glob', 'web_search'].includes(name)) mutability = 'read';
  if (['ask', 'todo', 'yield'].includes(name)) mutability = 'control';
  if (name === 'hub') {
    mutability = HUB_READ.has(input.op) ? 'read'
      : ['cancel', 'stop'].includes(input.op) ? 'control' : 'unknown';
  }
  const delegationLifecycleUnproven = ['eval', 'subagent'].includes(name)
    || (name === 'hub' && input.op === 'send' && !input.name?.trim());
  let params = input;
  let affectedPaths = pi.extractAffectedPaths(name, input, cwd);
  if (name === 'edit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const added = edits.map(edit => edit.new_string ?? (edit.op === 'create' ? edit.diff
      : String(edit.diff || '').split(/\r?\n/).filter(line => line.startsWith('+')).join('\n'))).join('\n');
    params = { ...input, edits: undefined, newText: input.new_string ?? added };
    affectedPaths.push(...edits.filter(edit => edit.rename).map(edit => normalizePath(edit.rename, cwd)));
    if (typeof input.input === 'string') {
      // OMP's apply_patch and hashline transports carry several file sections.
      affectedPaths = codex.extractAffectedPaths('apply_patch', input.input, cwd);
      for (const line of input.input.split(/\r?\n/)) {
        const match = /^\[(.+)#[0-9a-fA-F]{4}\]$/.exec(line) || /^MV (.+)$/.exec(line);
        if (match) affectedPaths.push(normalizePath(match[1], cwd));
      }
      params = { newText: input.input.split(/\r?\n/).filter(line => line.startsWith('+')).join('\n') };
    }
  }
  return {
    mutability, affectedPaths: [...new Set(affectedPaths)],
    delegationCount: task ? (batch ? input.tasks.length : 1) : 0,
    unboundedDelegation: task && !validTask,
    delegationLifecycleUnproven,
    dependencyIntent: name === 'edit'
      ? editDependencyIntent(input)
      : pi.detectDependencyIntent(name, params),
    hashIntent: name === 'edit'
      ? affectedPaths.some(target => pi.detectHashIntent('edit', { ...params, path: target }))
      : pi.detectHashIntent(name, params)
  };
}

module.exports = { classifyOmpAction };
