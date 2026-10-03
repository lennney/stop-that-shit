'use strict';

const { manifestEditDependencyIntent, manifestDependencyIntent, patchDependencyIntent } = require('../manifest-dependencies.cjs');

const nodePath = require('node:path');
const { analyzeShellInput, classifyShell } = require('../shell-analysis.cjs');
const { detectDependencyIntent: detectCodexDependencyIntent } = require('./codex-tool-classifier.cjs');
const { detectHashIntent: detectToolHashIntent } = require('../hash-intent.cjs');

const READ_TOOLS = new Set([
  'read_file',
  'search_files',
  'web_search',
  'web_extract',
  'vision_analyze'
]);
const WRITE_TOOLS = new Set(['write_file', 'patch']);
const DELEGATE_TOOLS = new Set(['delegate_task']);
const CONTROL_TOOLS = new Set(['clarify', 'todo']);
const DELEGATE_CONTROL_ACTIONS = new Set(['list', 'steer', 'stop']);

function isHermesDelegationControl(toolName, toolInput) {
  const action = toolInput && typeof toolInput === 'object' ? toolInput.action : null;
  return toolName === 'delegate_task'
    && DELEGATE_CONTROL_ACTIONS.has(String(action || '').toLowerCase());
}

function countHermesDelegation(toolName, toolInput) {
  if (toolName !== 'delegate_task' || isHermesDelegationControl(toolName, toolInput)) return 0;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  let tasks = input.tasks;
  // Match Hermes' task-list normalization: recover only JSON arrays; an empty
  // array falls back to goal. Invalid strings are rejected before any spawn.
  if (typeof tasks === 'string') {
    try { tasks = JSON.parse(tasks); } catch { return 0; }
    if (!Array.isArray(tasks)) return 0;
  }
  if (Array.isArray(tasks) && tasks.length) return tasks.length;
  if (typeof input.goal === 'string' && input.goal.trim()) return 1;
  return 0;
}

function classifyHermesTool(toolName, toolInput) {
  const name = String(toolName || '');
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (isHermesDelegationControl(name, toolInput)) return 'control';
  if (DELEGATE_TOOLS.has(name)) return 'delegate';
  if (CONTROL_TOOLS.has(name)) return 'control';
  if (name === 'terminal') return classifyShell(toolInput && toolInput.command);
  return 'unknown';
}

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function normalizePath(value, cwd) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return '';

  const base = String(cwd || '');
  if (isWindowsAbsolute(raw)) {
    const relative = isWindowsAbsolute(base) ? nodePath.win32.relative(base, raw) : raw;
    return relative.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  let normalized = raw.replace(/\\/g, '/');
  if (base && nodePath.posix.isAbsolute(normalized)) {
    normalized = nodePath.posix.relative(base.replace(/\\/g, '/'), normalized);
  }
  return normalized.replace(/^\.\//, '');
}

function extractAffectedPaths(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  if (name === 'write_file') {
    const target = normalizePath(input.path, cwd);
    return target ? [target] : [];
  }
  if (name !== 'patch') return [];

  const mode = input.mode || 'replace';
  if (mode === 'replace') {
    const target = normalizePath(input.path, cwd);
    return target ? [target] : [];
  }
  if (mode !== 'patch') return [];

  const paths = [];
  for (const line of String(input.patch || '').split(/\r?\n/)) {
    const file = /^\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/.exec(line);
    if (file) {
      paths.push(normalizePath(file[1], cwd));
      continue;
    }
    const move = /^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+?)\s*$/.exec(line);
    if (move) paths.push(normalizePath(move[1], cwd), normalizePath(move[2], cwd));
  }
  return [...new Set(paths.filter(Boolean))];
}

function codexIntentInput(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName !== 'patch' || (input.mode || 'replace') === 'patch') return input;
  return { path: input.path, content: input.new_string };
}

function codexToolName(toolName, toolInput) {
  if (toolName === 'terminal') return 'exec_command';
  if (toolName === 'patch') return (toolInput && toolInput.mode || 'replace') === 'patch' ? 'apply_patch' : 'Write';
  if (toolName === 'write_file') return 'Write';
  return String(toolName || '');
}

function detectDependencyIntent(toolName, toolInput) {
  if (toolName === 'terminal') return analyzeShellInput(codexIntentInput(toolName, toolInput)).dependencyIntent;
  const name = codexToolName(toolName, toolInput);
  const input = codexIntentInput(toolName, toolInput);
  if (toolName === 'patch' && name === 'Write') return manifestEditDependencyIntent(input.path, toolInput.old_string, input.content);
  if (name === 'Write') return manifestDependencyIntent(input.path, input.content);
  if (name === 'apply_patch') return patchDependencyIntent(input.patch);
  return detectCodexDependencyIntent(name, input);
}

function detectHashIntent(toolName, toolInput) {
  if (toolName === 'terminal') return analyzeShellInput(codexIntentInput(toolName, toolInput)).hashIntent;
  return detectToolHashIntent(codexToolName(toolName, toolInput), codexIntentInput(toolName, toolInput));
}

function analyzeHermesTool(toolName, toolInput, cwd) {
  const analysis = toolName === 'terminal'
    ? analyzeShellInput(codexIntentInput(toolName, toolInput))
    : {
      mutability: classifyHermesTool(toolName, toolInput),
      hashIntent: detectHashIntent(toolName, toolInput),
      dependencyIntent: detectDependencyIntent(toolName, toolInput)
    };
  return { ...analysis, affectedPaths: extractAffectedPaths(toolName, toolInput, cwd) };
}

module.exports = {
  analyzeHermesTool,
  classifyHermesTool,
  countHermesDelegation,
  extractAffectedPaths,
  detectDependencyIntent,
  detectHashIntent,
  isHermesDelegationControl
};
