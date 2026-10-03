'use strict';

const nodePath = require('node:path');
const { analyzeShell, analyzeShellInput, classifyShell } = require('../shell-analysis.cjs');
const { patchDependencyIntent } = require('../manifest-dependencies.cjs');
const { detectHashIntent } = require('../hash-intent.cjs');

const WRITE_NAME = /(?:^|__|_)(?:add|append|apply|archive|close|commit|copy|create|delete|deploy|edit|install|merge|move|patch|post|publish|push|remove|rename|send|set|submit|update|upload|write)(?:$|__|_)/i;
const READ_NAME = /(?:^|__|_)(?:cat|check|diff|fetch|find|get|inspect|list|load|open|read|review|search|show|status|view)(?:$|__|_)/i;
const CONTROL_TOOLS = new Set(['update_plan', 'request_user_input', 'wait', 'wait_agent', 'interrupt_agent', 'close_agent']);
// Match the host's known flattened namespaces exactly; do not strip arbitrary
// prefixes from MCP or third-party tool names.
const CODEX_TOOL_NAMES = new Map([
  ...['send_input', 'resume_agent', 'wait_agent', 'close_agent']
    .map(name => [`multi_agent_v1${name}`, name]),
  ...['spawn_agent', 'followup_task', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent']
    .map(name => [`collaboration${name}`, name])
]);

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '');
}

function normalizePath(value, cwd) {
  let normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  if (cwd && nodePath.isAbsolute(normalized)) {
    normalized = nodePath.relative(String(cwd), normalized).replace(/\\/g, '/');
  }
  return normalized.replace(/^\.\//, '');
}

function extractAffectedPaths(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  if (name === 'Edit' || name === 'Write') {
    const filePath = normalizePath(toolInput && (toolInput.file_path || toolInput.path), cwd);
    return filePath ? [filePath] : [];
  }
  if (name !== 'apply_patch') return [];

  const paths = [];
  for (const line of inputText(toolInput).split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line)
      || /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (match) paths.push(normalizePath(match[1], cwd));
  }
  return [...new Set(paths.filter(Boolean))];
}

function detectDependencyIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = inputText(toolInput);
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return analyzeShell(text).dependencyIntent;
  }
  if (name === 'apply_patch') return patchDependencyIntent(text);
  return false;
}

function canonicalCodexToolName(toolName) {
  const name = String(toolName || '');
  return CODEX_TOOL_NAMES.get(name) || name;
}

function classifyCodexTool(toolName, toolInput) {
  const name = canonicalCodexToolName(toolName);
  if (name === 'apply_patch' || name === 'Edit' || name === 'Write') return 'write';
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return classifyShell(toolInput && toolInput.command);
  }
  if (name === 'Agent' || name === 'spawn_agent') return 'delegate';
  if (CONTROL_TOOLS.has(name)) return 'control';
  if (WRITE_NAME.test(name)) return 'write';
  if (READ_NAME.test(name)) return 'read';
  return 'unknown';
}

function analyzeCodexTool(toolName, toolInput, cwd) {
  const name = canonicalCodexToolName(toolName);
  let analysis;
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    analysis = analyzeShellInput(toolInput);
  } else {
    analysis = {
      mutability: classifyCodexTool(name, toolInput),
      hashIntent: detectHashIntent(name, toolInput),
      dependencyIntent: detectDependencyIntent(name, toolInput)
    };
  }
  return { ...analysis, affectedPaths: extractAffectedPaths(name, toolInput, cwd) };
}

module.exports = { analyzeCodexTool, analyzeShell, canonicalCodexToolName, classifyCodexTool, classifyShell, detectDependencyIntent, detectHashIntent, extractAffectedPaths };
