'use strict';

const {
  detectDependencyIntent: detectCodexDependencyIntent,
  detectHashIntent: detectCodexHashIntent,
  classifyShell
} = require('./codex-tool-classifier.cjs');
const {
  detectDependencyIntent: detectOpenCodeDependencyIntent,
  detectHashIntent: detectOpenCodeHashIntent,
  normalizePath
} = require('./opencode-tool-classifier.cjs');

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
    return detectCodexDependencyIntent('Bash', { command: input.command });
  }
  if (name === 'write') {
    return detectOpenCodeDependencyIntent('write', {
      filePath: input.path,
      content: input.content
    });
  }
  if (name === 'edit') {
    return detectOpenCodeDependencyIntent('edit', {
      filePath: input.path,
      newString: editAddedText(input)
    });
  }
  return false;
}

function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '').toLowerCase();
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (name === 'bash' || name === 'powershell') {
    return detectCodexHashIntent('Bash', { command: input.command });
  }
  if (name === 'write') {
    return detectOpenCodeHashIntent('write', {
      filePath: input.path,
      content: input.content
    });
  }
  if (name === 'edit') {
    return detectOpenCodeHashIntent('edit', {
      filePath: input.path,
      newString: editAddedText(input)
    });
  }
  return false;
}

module.exports = {
  classifyPiTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  piDelegationShape
};
