'use strict';

const pi = require('./pi-tool-classifier.cjs');
const { normalizePath } = require('./opencode-tool-classifier.cjs');
const codex = require('./codex-tool-classifier.cjs');
const { manifestDependencyIntent, manifestEditDependencyIntent, patchDependencyIntent } = require('../manifest-dependencies.cjs');
const HUB_READ = new Set(['wait', 'inbox', 'list', 'jobs', 'ps', 'logs', 'describe']);

function anchoredEdits(text) {
  if (!/^\*\*\* Edit File:/m.test(text)) return null;
  const edits = [];
  let path = '', phase = '', action = '', before = [], body = [];
  const flush = () => {
    if (!path || !action) return;
    const oldText = before.join('\n');
    const addedText = body.join('\n');
    const newText = action === 'Replace' ? addedText
      : action === 'Insert Before' ? `${addedText}\n${oldText}` : `${oldText}\n${addedText}`;
    edits.push({ path, oldText, newText, addedText });
  };
  for (const line of text.split(/\r?\n/)) {
    const file = /^\*\*\* Edit File:\s*(.*?)\s*$/.exec(line);
    if (file || line === '*** Find') {
      flush();
      before = []; body = []; action = ''; phase = file ? '' : 'find';
      if (file) {
        const target = file[1].replace(/(?:^|\s+)all$/, '').trim();
        if (target) {
          try { path = target.startsWith('"') ? JSON.parse(target) : target; }
          catch { path = target; }
        }
      }
    } else if (/^\*\*\* (?:Replace|Insert Before|Insert After)$/.test(line)) {
      action = line.slice(4); phase = 'body';
    } else if (phase === 'find') before.push(line);
    else if (phase === 'body') body.push(line);
  }
  flush();
  return edits;
}

function editDependencyIntent(input, anchored) {
  if (anchored) return anchored.some(edit => manifestEditDependencyIntent(edit.path, edit.oldText, edit.newText));
  if (typeof input.input === 'string') {
    return patchDependencyIntent(input.input
      .replace(/^\[(.+)#[0-9a-fA-F]{4}\]\r?$/gm, '*** Update File: $1')
      .replace(/^MV (.+?)\r?$/gm, '*** Move to: $1'));
  }
  if (!Array.isArray(input.edits)) {
    return manifestEditDependencyIntent(input.path, input.old_string, input.new_string);
  }
  // OMP stages all entries for one file, then writes its final destination.
  const target = input.edits.reduce((file, edit) => edit?.rename || file, input.path);
  return input.edits.some(edit => edit && (edit.op === 'create'
    ? manifestDependencyIntent(target, edit.diff)
    : typeof edit.new_string === 'string'
      ? manifestEditDependencyIntent(target, edit.old_string, edit.new_string, input.path)
      : patchDependencyIntent(`*** Update File: ${input.path}\n${target !== input.path ? `*** Move to: ${target}\n` : ''}${edit.diff || ''}`)));
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
  const anchored = name === 'edit' && typeof input.input === 'string' ? anchoredEdits(input.input) : null;
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
    if (anchored) affectedPaths = anchored.map(edit => normalizePath(edit.path, cwd));
  }
  return {
    mutability, affectedPaths: [...new Set(affectedPaths)],
    delegationCount: task ? (batch ? input.tasks.length : 1) : 0,
    unboundedDelegation: task && !validTask,
    delegationLifecycleUnproven,
    dependencyIntent: name === 'edit'
      ? editDependencyIntent(input, anchored)
      : pi.detectDependencyIntent(name, params),
    hashIntent: anchored
      ? anchored.some(edit => pi.detectHashIntent('edit', { path: edit.path, newText: edit.addedText }))
      : name === 'edit'
      ? affectedPaths.some(target => pi.detectHashIntent('edit', { ...params, path: target }))
      : pi.detectHashIntent(name, params)
  };
}

module.exports = { classifyOmpAction };
