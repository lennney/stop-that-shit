'use strict';

const { manifestEditDependencyIntent, manifestDependencyIntent } = require('../manifest-dependencies.cjs');

const nodePath = require('node:path');
const {
  analyzeCodexTool,
  classifyCodexTool,
  classifyShell,
  detectDependencyIntent: detectCodexDependencyIntent,
  detectHashIntent: detectCodexHashIntent
} = require('./codex-tool-classifier.cjs');

// DeepSeek Harness registers tools under lowercase snake_case names. The
// complete set is asserted by the harness catalog test
// (packages/core/tools/tests/gen-tool-catalog.spec.ts); the lists below cover
// the tools this adapter classifies directly, and unrecognized names fall back
// to the host-neutral name heuristics.

const DSH_READ_TOOLS = new Set([
  'get_goal',
  'glob',
  'grep',
  'list_agents',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'list_subagent_models',
  'load_workspace_dependencies',
  'read',
  'read_image',
  'read_mcp_resource',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_search',
  'session_trace',
  'web_fetch',
  'web_search'
]);

const DSH_CONTROL_TOOLS = new Set([
  'ask_user_question',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'create_goal',
  'exit_plan_mode',
  'get_goal',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'plugin_manager',
  'present',
  'schedule_create',
  'schedule_delete',
  'schedule_list',
  'schedule_update',
  'skill',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_signal',
  'todo_write',
  'update_goal',
  'wait_agent'
]);

// The harness exposes delegation under four names. `subagent` runs one scoped
// child; `subagent_fork` is the shipped alias of that same package, selected by
// a config-driven tool name, so it must reserve capacity identically.
// `spawn_teammate` creates a durable teammate and `workflow` fans out a
// pipeline. All four reserve task capacity.
const DSH_DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'workflow']);

// Terminal calls mutate an interactive session rather than the workspace
// directly, so they classify by what the harness documents: open/read/list are
// observations, while send/signal/close can change remote state.
const DSH_TERMINAL_READ_TOOLS = new Set(['terminal_list', 'terminal_read']);

// The file editor selects one of four commands per call. Only `view` observes;
// the other three create or rewrite file content and are writes.
const DSH_EDITOR_READ_COMMANDS = new Set(['view']);

// The shared analyzers key off the Claude tool names `Write` and `Edit`. DSH
// registers lowercase names, so the name is normalized before delegating rather
// than duplicating the shared rules.
const DSH_TO_SHARED_NAME = new Map([
  ['write', 'Write'],
  ['edit', 'Edit']
]);

// `run_code` is the PTC transport, not an analyzed action. It carries
// `description` and `code` rather than a shell `command`, so the shared Bash
// analyzer cannot read it, and its program body is not a shell script.
//
// Each tool called inside the program is scheduled through the registry and
// traverses `tools/pre-execute` on its own, so the real read or write is
// classified and gated under its own name. A nested denial surfaces inside the
// program as a binding rejection. The transport is therefore `control`: it owns
// no workspace effect of its own, and treating it as `unknown` would deny
// read-only programs before their reads are ever examined.
const RUN_CODE_NAME = 'run_code';
const SHELL_TOOLS = new Set(['bash', 'pwsh']);

function isShellTool(name) {
  return SHELL_TOOLS.has(name);
}

function isEditorTool(name) {
  return name === 'str_replace_editor';
}

function isRunCode(name) {
  return name === RUN_CODE_NAME;
}

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
      || toolInput.file_text
      || toolInput.new_str
      || ''
  );
}

function editorCommand(toolInput) {
  return String((toolInput && toolInput.command) || '');
}

function classifyDshTool(toolName, toolInput) {
  const name = String(toolName || '');

  if (isEditorTool(name)) {
    // `view` only observes the file. Every other editor command writes.
    return DSH_EDITOR_READ_COMMANDS.has(editorCommand(toolInput)) ? 'read' : 'write';
  }
  if (name === 'write' || name === 'edit') return 'write';
  if (isShellTool(name)) {
    return classifyShell(toolInput && toolInput.command);
  }
  if (isRunCode(name)) {
    // The transport owns no workspace effect. Its nested calls are classified
    // and gated individually when the registry schedules them.
    return 'control';
  }
  if (DSH_DELEGATE_TOOLS.has(name)) return 'delegate';
  if (DSH_TERMINAL_READ_TOOLS.has(name)) return 'read';
  if (name === 'terminal_send' || name === 'terminal_signal' || name === 'terminal_close') return 'write';
  if (DSH_READ_TOOLS.has(name)) return 'read';
  if (DSH_CONTROL_TOOLS.has(name)) return 'control';

  // MCP and plugin tools use names such as mcp__server__create_item. The
  // name-based fallback is host-neutral for these separator-delimited names.
  return classifyCodexTool(name, toolInput);
}

function extractAffectedPaths(toolName, toolInput, cwd, mutability) {
  const name = String(toolName || '');
  let value = '';

  if (isEditorTool(name)) {
    // A read-only `view` does not participate in the write boundary.
    if (DSH_EDITOR_READ_COMMANDS.has(editorCommand(toolInput))) return [];
    value = toolInput && (toolInput.path || toolInput.file_path);
  } else if (name === 'write' || name === 'edit') {
    value = toolInput && (toolInput.file_path || toolInput.path);
  } else if (toolInput && typeof toolInput === 'object' && (mutability ?? classifyCodexTool(name, toolInput)) === 'write') {
    // For third-party/MCP mutating tools, only trust an explicit single path
    // field. Read-only tools do not participate in the write boundary. If a
    // mutating tool has no provable path, the controller's file lock fails
    // closed.
    value = toolInput.file_path || toolInput.path || '';
  }

  const normalized = normalizePath(value, cwd);
  return normalized ? [normalized] : [];
}

function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '');
  if (isShellTool(name)) {
    return detectCodexHashIntent('Bash', toolInput);
  }
  if (isEditorTool(name)) {
    // The editor's content fields are `file_text`, `new_str`, and `insert_text`.
    // Only the text a command writes can introduce hashing.
    if (DSH_EDITOR_READ_COMMANDS.has(editorCommand(toolInput))) return false;
    return HASH_API.test(inputText(toolInput));
  }
  if (isRunCode(name)) return false;
  // The shared detector matches the `Write`/`Edit` names exactly, so map the
  // harness lowercase names onto them instead of forking the rule.
  return detectCodexHashIntent(DSH_TO_SHARED_NAME.get(name) || name, toolInput);
}

function editorManifestIntent(toolInput, cwd) {
  const command = editorCommand(toolInput);
  if (DSH_EDITOR_READ_COMMANDS.has(command)) return false;
  const filePath = normalizePath(toolInput && toolInput.path, cwd);
  if (command === 'create') {
    return manifestDependencyIntent(filePath, toolInput && toolInput.file_text);
  }
  // `str_replace` and `insert` both rewrite an existing file through `new_str`,
  // so the shared edit rule applies to either.
  return manifestEditDependencyIntent(
    filePath,
    toolInput && toolInput.old_str,
    toolInput && toolInput.new_str
  );
}

function detectDependencyIntent(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  if (isShellTool(name)) {
    return detectCodexDependencyIntent('Bash', toolInput);
  }
  if (isEditorTool(name)) {
    return editorManifestIntent(toolInput, cwd);
  }
  if (isRunCode(name)) return false;

  const shared = DSH_TO_SHARED_NAME.get(name);
  if (!shared) return false;

  const filePath = normalizePath(toolInput && (toolInput.file_path || toolInput.path), cwd);
  return shared === 'Write'
    ? manifestDependencyIntent(filePath, toolInput && toolInput.content)
    : manifestEditDependencyIntent(filePath, toolInput && toolInput.old_string, toolInput && toolInput.new_string);
}

function analyzeDshTool(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  let analysis;
  if (isShellTool(name)) {
    analysis = analyzeCodexTool('Bash', toolInput, cwd);
  } else {
    analysis = {
      mutability: classifyDshTool(name, toolInput),
      hashIntent: detectHashIntent(name, toolInput),
      dependencyIntent: detectDependencyIntent(name, toolInput, cwd)
    };
  }
  const pathMutability = isShellTool(name) ? analysis.mutability : undefined;
  return { ...analysis, affectedPaths: extractAffectedPaths(name, toolInput, cwd, pathMutability) };
}

module.exports = {
  DSH_CONTROL_TOOLS,
  DSH_DELEGATE_TOOLS,
  DSH_READ_TOOLS,
  analyzeDshTool,
  classifyDshTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  // The harness `workflow` tool has no bounded fan-out argument, so a directive
  // that caps delegation cannot be proven for it.
  isUnboundedDelegation: (toolName) => String(toolName || '') === 'workflow',
  normalizePath
};
