'use strict';

const { manifestDependencyIntent, manifestEditDependencyIntent } = require('../manifest-dependencies.cjs');

const { analyzeShell, classifyShell } = require('../shell-analysis.cjs');
const { normalizePath } = require('./opencode-tool-classifier.cjs');
const { fileHashIntent } = require('../hash-intent.cjs');

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const WRITE_TOOLS = new Set(['write', 'edit']);

function piDelegationShape(toolName, toolInput) {
  if (String(toolName || '') !== 'subagent') return { count: 0, unbounded: false };
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const hasTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
  const hasChain = Array.isArray(input.chain) && input.chain.length > 0;
  const hasSingle = typeof input.agent === 'string' && input.agent.trim()
    && typeof input.task === 'string' && input.task.trim();
  const modes = Number(hasTasks) + Number(hasChain) + Number(Boolean(hasSingle));
  if (modes !== 1) return { count: 0, unbounded: true };
  if (hasTasks) return { count: input.tasks.length, unbounded: false };
  if (hasChain) return { count: 1, unbounded: false };
  return { count: 1, unbounded: false };
}

function classifyPiTool(toolName, toolInput) {
  const name = String(toolName || '').toLowerCase();
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'bash' || name === 'powershell') {
    return classifyShell(toolInput && toolInput.command);
  }
  if (name === 'subagent') return 'delegate';
  return 'unknown';
}

function editAddedText(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (Array.isArray(input.edits)) {
    return input.edits
      .map((edit) => edit && typeof edit === 'object' ? edit.newText : '')
      .filter((text) => typeof text === 'string')
      .join('\n');
  }
  return String(input.newText || '');
}

function extractAffectedPaths(toolName, toolInput, cwd) {
  const name = String(toolName || '').toLowerCase();
  if (!WRITE_TOOLS.has(name)) return [];
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const target = normalizePath(input.path, cwd);
  return target ? [target] : [];
}

function detectDependencyIntent(toolName, toolInput) {
  const name = String(toolName || '').toLowerCase();
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (name === 'bash' || name === 'powershell') {
    return analyzeShell(input.command).dependencyIntent;
  }
  if (name === 'write') return manifestDependencyIntent(input.path, input.content);
  if (name === 'edit') {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    return edits.some(edit => edit && manifestEditDependencyIntent(input.path, edit.oldText, edit.newText));
  }
  return false;
}

function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '').toLowerCase();
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (name === 'bash' || name === 'powershell') {
    return analyzeShell(input.command).hashIntent;
  }
  if (name === 'write') {
    return fileHashIntent(input.path, input.content);
  }
  if (name === 'edit') {
    return fileHashIntent(input.path, editAddedText(input));
  }
  return false;
}

function analyzePiTool(toolName, toolInput, cwd) {
  const name = String(toolName || '').toLowerCase();
  const analysis = name === 'bash' || name === 'powershell'
    ? analyzeShell(toolInput && toolInput.command)
    : {
      mutability: classifyPiTool(toolName, toolInput),
      hashIntent: detectHashIntent(toolName, toolInput),
      dependencyIntent: detectDependencyIntent(toolName, toolInput)
    };
  return { ...analysis, affectedPaths: extractAffectedPaths(toolName, toolInput, cwd) };
}

module.exports = {
  analyzePiTool,
  classifyPiTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  piDelegationShape
};
