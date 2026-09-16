'use strict';

const nodePath = require('node:path');
const {
  analyzeCodexTool,
  classifyCodexTool,
  classifyShell,
  detectDependencyIntent: detectCodexDependencyIntent,
  detectHashIntent: detectCodexHashIntent
} = require('./codex-tool-classifier.cjs');

const CLAUDE_READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'ReadMcpResourceTool',
  'WebFetch',
  'WebSearch'
]);

const CLAUDE_CONTROL_TOOLS = new Set([
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EndConversation',
  'EnterPlanMode',
  'ExitPlanMode',
  'ExitWorktree',
  'PushNotification',
  'ReportFindings',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
  'ToolSearch',
  'WaitForMcpServers'
]);

const MANIFEST_PATH = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
const DEPENDENCY_DECLARATION = /["']?(?:dependencies|devDependencies|optionalDependencies|peerDependencies)["']?\s*[:=]|(?:^|\n)\s*[^#\s][^\r\n]*(?:==|>=|~=|\^\d)/i;
const HASH_API = /\b(?:createHash|createHmac)\s*\(|\bcrypto\.subtle\.digest\s*\(|\bhashlib\.(?:md5|sha1|sha224|sha256|sha384|sha512|blake2[bs])\s*\(|\bMessageDigest\.getInstance\s*\(|\bDigestUtils\.[A-Za-z0-9_]+\s*\(|\bsha(?:1|256|512)\.(?:New|Sum\w*)\s*\(|\b(?:bcrypt|argon2)\.hash\s*\(|\bpassword_hash\s*\(|\bPasswordHasher\s*\(/i;

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || '')) || /^\\\\[^\\]+\\[^\\]+/.test(String(value || ''));
}

function normalizePath(value, cwd) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return '';

  const windowsStyle = isWindowsAbsolute(raw) || isWindowsAbsolute(cwd);
  const pathApi = windowsStyle ? nodePath.win32 : nodePath;
  let normalized = raw.replace(/\\/g, '/');
  const normalizedCwd = String(cwd || '').replace(/\\/g, '/');

  if (cwd && (pathApi.isAbsolute(raw) || isWindowsAbsolute(raw))) {
    try {
      normalized = pathApi.relative(String(cwd), raw).replace(/\\/g, '/');
    } catch {
      normalized = raw.replace(/\\/g, '/');
    }
  } else if (normalizedCwd && normalized.startsWith(`${normalizedCwd.replace(/\/+$/, '')}/`)) {
    normalized = normalized.slice(normalizedCwd.replace(/\/+$/, '').length + 1);
  }

  return normalized.replace(/^\.\//, '');
}

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(
    toolInput.command
      || toolInput.patch
      || toolInput.content
      || toolInput.new_string
      || toolInput.new_source
      || ''
  );
}

function classifyClaudeTool(toolName, toolInput) {
  const name = String(toolName || '');

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' || name === 'EnterWorktree') return 'write';
  if (name === 'Bash' || name === 'PowerShell' || name === 'Monitor') {
    if (name === 'Monitor' && toolInput && toolInput.ws && !toolInput.command) return 'read';
    return classifyShell(toolInput && toolInput.command);
  }
  if (name === 'Agent' || name === 'Workflow') return 'delegate';
  if (CLAUDE_READ_TOOLS.has(name)) return 'read';
  if (CLAUDE_CONTROL_TOOLS.has(name)) return 'control';

  // MCP/plugin tools use names such as mcp__server__create_item. The existing
  // name-based fallback is host-neutral for these separator-delimited names.
  return classifyCodexTool(name, toolInput);
}

function extractAffectedPaths(toolName, toolInput, cwd, mutability) {
  const name = String(toolName || '');
  let value = '';

  if (name === 'Write' || name === 'Edit') {
    value = toolInput && (toolInput.file_path || toolInput.path);
  } else if (name === 'NotebookEdit') {
    value = toolInput && toolInput.notebook_path;
  } else if (toolInput && typeof toolInput === 'object' && (mutability ?? classifyCodexTool(name, toolInput)) === 'write') {
    // For third-party/MCP mutating tools, only trust an explicit single path
    // field. Read-only tools do not participate in the write boundary. If a
    // mutating tool has no provable path, the controller's file lock fails closed.
    value = toolInput.file_path || toolInput.path || '';
  }

  const normalized = normalizePath(value, cwd);
  return normalized ? [normalized] : [];
}

function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '');
  if (name === 'PowerShell' || name === 'Monitor') {
    return detectCodexHashIntent('Bash', toolInput);
  }
  if (name === 'NotebookEdit') {
    return HASH_API.test(inputText(toolInput));
  }
  return detectCodexHashIntent(name, toolInput);
}

function detectDependencyIntent(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  if (name === 'PowerShell' || name === 'Monitor') {
    return detectCodexDependencyIntent('Bash', toolInput);
  }
  if (name === 'Bash') {
    return detectCodexDependencyIntent(name, toolInput);
  }
  if (name !== 'Write' && name !== 'Edit') return false;

  const filePath = normalizePath(toolInput && (toolInput.file_path || toolInput.path), cwd);
  if (!MANIFEST_PATH.test(filePath)) return false;

  if (name === 'Write') {
    return DEPENDENCY_DECLARATION.test(String(toolInput && toolInput.content || ''));
  }
  return DEPENDENCY_DECLARATION.test(String(toolInput && toolInput.new_string || ''));
}

function analyzeClaudeTool(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  let analysis;
  if (name === 'Bash' || name === 'PowerShell' || name === 'Monitor') {
    analysis = analyzeCodexTool('Bash', toolInput, cwd);
    if (name === 'Monitor' && toolInput && toolInput.ws && !toolInput.command) {
      analysis.mutability = 'read';
      delete analysis.analysisReason;
    }
  } else {
    analysis = {
      mutability: classifyClaudeTool(name, toolInput),
      hashIntent: detectHashIntent(name, toolInput),
      dependencyIntent: detectDependencyIntent(name, toolInput, cwd)
    };
  }
  // Claude's legacy path fallback uses the Codex tool-name classification.
  // Reuse it only for names with the same classification on both surfaces.
  const pathMutability = name === 'Bash' ? analysis.mutability : undefined;
  return { ...analysis, affectedPaths: extractAffectedPaths(name, toolInput, cwd, pathMutability) };
}

module.exports = {
  analyzeClaudeTool,
  classifyClaudeTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  isUnboundedDelegation: (toolName) => String(toolName || '') === 'Workflow',
  normalizePath
};
