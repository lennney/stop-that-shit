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
  // Every documented `lsp` operation is a navigation query: goToDefinition,
  // findReferences, goToImplementation, hover. None of them writes.
  'lsp',
  'read',
  'read_image',
  'read_mcp_resource',
  'schedule_list',
  'schedule_view',
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
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'present',
  // Delivering a message to an agent writes nothing to the workspace. The
  // generic name heuristic matches `send` and would classify it as a write,
  // which under any file boundary denies a routine status update.
  'send_message',
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

const DSH_SCHEDULE_WRITE_TOOLS = new Set([
  'schedule_create',
  'schedule_edit',
  'schedule_delete',
  'schedule_update'
]);

// The harness exposes delegation under four names. `subagent` runs one scoped
// child; `subagent_fork` is the shipped alias of that same package, selected by
// a config-driven tool name, so it must reserve capacity identically.
// `spawn_teammate` creates a durable teammate and `workflow` fans out a
// pipeline. All four reserve task capacity.
// `ralph` runs a fresh-agent loop: each round opens a new child with no
// parent conversation, so it reserves task capacity like any other delegation.
const DSH_DELEGATE_TOOLS = new Set([
  'ralph',
  'spawn_teammate',
  'subagent',
  'subagent_fork',
  'workflow'
]);

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
// Nested `tools.*` calls are gated: each one is scheduled through the registry
// and traverses `tools/pre-execute` under its own tool name. That is NOT the
// only path to an effect, though. The Node evaluator runs the program as a bare
// async function with the full runtime in scope, so a body can
// `await import('node:fs/promises')` and write the workspace with no binding at
// all. The transport is therefore `unknown` by default and only becomes `control`
// when a deployment asserts a runtime it can prove cannot do that — see
// classifyDshTool and setRunCodeBindingOnly.
const RUN_CODE_NAME = 'run_code';
const SHELL_TOOLS = new Set(['bash', 'pwsh']);

// DSH registers lowercase snake_case names, but a tool's registered name can be
// configured (`tool-subagent` selects its own at load time). Matching is
// case-insensitive so a renamed tool cannot fall out of the explicit sets and
// become an unknown that reads as permitted work.
function normalizeToolName(toolName) {
  return String(toolName || '').toLowerCase();
}

// `plugin_manager` mixes observation with mutation behind one name: a list
// action only reads, while install and set actions execute build scripts and
// persist across sessions. Classifying the whole tool as control would let an
// install pass every contract.
const PLUGIN_MANAGER_READ_ACTIONS = new Set([
  'list_plugins',
  'list_bundles',
  'list_version_exemptions'
]);

const PLUGIN_MARKET_READ_ACTIONS = new Set([
  'list_indexes',
  'list_plugins',
  'list_versions'
]);

const PLUGIN_MANAGER_WRITE_ACTIONS = new Set([
  'install_bundle',
  'remove_bundle',
  'set_bundle',
  'set_plugin',
  'set_version_exemption'
]);

// The two known action sets are classified precisely so the tool is neither
// over- nor under-gated. An unrecognized action defaults to `write`, which is
// the stricter direction: outside a change contract a write is refused, while
// `unknown` would only ask for approval. Under a bare change contract with no
// `files=` boundary the core admits any write with no affected path, for every
// adapter alike, so the default does not change that.
function classifyPluginManager(toolInput) {
  const action = String((toolInput && toolInput.action) || '');
  if (PLUGIN_MANAGER_READ_ACTIONS.has(action)) return 'read';
  if (PLUGIN_MANAGER_WRITE_ACTIONS.has(action)) return 'write';
  return 'write';
}

function isShellTool(toolName) {
  return SHELL_TOOLS.has(normalizeToolName(toolName));
}

function isEditorTool(name) {
  return name === 'str_replace_editor';
}

function isRunCode(name) {
  return name === RUN_CODE_NAME;
}

// Deployment assertion that a PTC program cannot reach the filesystem except
// through a gated tool binding. Set it only with a confinement or binding-only
// runtime that enforces the active task contract; the adapter cannot verify
// it. Read from the process environment so a consuming plugin can assert it
// once at mount time without threading it through every call.
let RUN_CODE_BINDING_ONLY = false;

function setRunCodeBindingOnly(value) {
  RUN_CODE_BINDING_ONLY = value === true;
}

function runCodeBindingOnly() {
  return RUN_CODE_BINDING_ONLY;
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

function normalizeLiteralPath(value, cwd) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return '';

  const windows = cwd ? isWindowsAbsolute(cwd) : process.platform === 'win32';
  // The shared decision compares slash-separated paths. A literal backslash
  // on Unix cannot be represented without changing the workspace target.
  if (!windows && value.includes('\\')) return '';
  const pathApi = windows ? nodePath.win32 : nodePath.posix;
  const relative = cwd && pathApi.isAbsolute(value) ? pathApi.relative(cwd, value) : value;
  return windows ? relative.replace(/\\/g, '/') : relative;
}

function patchInput(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput?.input === 'string') return toolInput.input;
  return String(toolInput?.command || toolInput?.patch || toolInput?.content || toolInput?.new_string || '');
}

function dshPatchDetails(toolInput, cwd) {
  let updating = false;
  const paths = [];
  const lines = patchInput(toolInput).split(/\r?\n/).map(line => {
    // DSH trims leading header whitespace outside an update hunk. In an
    // update a leading space denotes file context and must be preserved.
    const header = updating
      ? line.replace(/\p{White_Space}+$/u, '')
      : line.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    const match = /^\*\*\* (Add File|Delete File|Update File|Move to): (.+)$/s.exec(header);
    if (!match || match[1] === 'Move to' && !updating) return line;

    updating = match[1] === 'Update File' || match[1] === 'Move to';
    paths.push(normalizeLiteralPath(match[2], cwd));
    return header;
  });
  return {
    text: lines.join('\n'),
    affectedPaths: paths.every(Boolean) ? [...new Set(paths)] : []
  };
}

// The file editor's `command` is a selector (`view`, `create`, `str_replace`,
// `insert`), not content. Hash and dependency analysis must read the text the
// command writes: `create` writes `file_text`, and `str_replace`/`insert` both
// write `new_str`. A read-only `view` writes nothing.
function editorContentText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const command = editorCommand(toolInput);
  if (DSH_EDITOR_READ_COMMANDS.has(command)) return '';
  if (command === 'create') return String(toolInput.file_text || '');
  return String(toolInput.new_str || '');
}

function editorCommand(toolInput) {
  return String((toolInput && toolInput.command) || '');
}

function classifyDshTool(toolName, toolInput) {
  const name = normalizeToolName(toolName);

  if (name === 'plugin_manager') return classifyPluginManager(toolInput);
  if (name === 'plugin_market') {
    return PLUGIN_MARKET_READ_ACTIONS.has(toolInput?.action) ? 'read' : 'unknown';
  }
  if (DSH_SCHEDULE_WRITE_TOOLS.has(name)) return 'write';

  if (isEditorTool(name)) {
    // `view` only observes the file. Every other editor command writes.
    return DSH_EDITOR_READ_COMMANDS.has(editorCommand(toolInput)) ? 'read' : 'write';
  }
  if (name === 'write' || name === 'edit') return 'write';
  if (isShellTool(name)) {
    return classifyShell(toolInput && toolInput.command);
  }
  if (isRunCode(name)) {
    // A PTC program is not a binding-only sandbox. The official Node evaluator
    // runs the body as a bare async function with full runtime globals, so a
    // program can `await import('node:fs/promises')` and write the workspace
    // without ever reaching a tool binding. Nested `tools.*` calls are still
    // gated, but that is not the only path to an effect.
    //
    // The `control` classification is therefore opt-in: a deployment may set
    // `runCodeBindingOnly` only when it can actually prove confinement or a
    // binding-only runtime that enforces the active task contract. Without
    // that proof the transport stays `unknown`, which preserves the
    // mutability-unproven approval path instead of asserting a guarantee the
    // host does not provide.
    return runCodeBindingOnly() ? 'control' : 'unknown';
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
  const name = normalizeToolName(toolName);
  if (name === 'apply_patch') {
    return dshPatchDetails(toolInput, cwd).affectedPaths;
  }
  // Scheduled tasks mutate host state and have no workspace file target.
  if (DSH_SCHEDULE_WRITE_TOOLS.has(name)) return [];

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

  const normalized = isEditorTool(name) || name === 'write' || name === 'edit'
    ? normalizeLiteralPath(value, cwd)
    : normalizePath(value, cwd);
  return normalized ? [normalized] : [];
}

function detectHashIntent(toolName, toolInput) {
  const name = normalizeToolName(toolName);
  if (isShellTool(name)) {
    return detectCodexHashIntent('Bash', toolInput);
  }
  if (isEditorTool(name)) {
    // Inspect the text the command writes, never the selector.
    return HASH_API.test(editorContentText(toolInput));
  }
  if (isRunCode(name)) return false;
  if (name === 'apply_patch') return detectCodexHashIntent(name, patchInput(toolInput));
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
  const name = normalizeToolName(toolName);
  if (isShellTool(name)) {
    return detectCodexDependencyIntent('Bash', toolInput);
  }
  if (isEditorTool(name)) {
    return editorManifestIntent(toolInput, cwd);
  }
  if (isRunCode(name)) return false;
  if (name === 'apply_patch') return detectCodexDependencyIntent(name, dshPatchDetails(toolInput, cwd).text);

  const shared = DSH_TO_SHARED_NAME.get(name);
  if (!shared) return false;

  const filePath = normalizePath(toolInput && (toolInput.file_path || toolInput.path), cwd);
  return shared === 'Write'
    ? manifestDependencyIntent(filePath, toolInput && toolInput.content)
    : manifestEditDependencyIntent(filePath, toolInput && toolInput.old_string, toolInput && toolInput.new_string);
}

function analyzeDshTool(toolName, toolInput, cwd) {
  const name = normalizeToolName(toolName);
  if (name === 'apply_patch') {
    const { text, affectedPaths } = dshPatchDetails(toolInput, cwd);
    return {
      mutability: 'write',
      hashIntent: detectCodexHashIntent(name, text),
      dependencyIntent: detectCodexDependencyIntent(name, text),
      affectedPaths
    };
  }

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
  setRunCodeBindingOnly,
  DSH_DELEGATE_TOOLS,
  DSH_READ_TOOLS,
  analyzeDshTool,
  classifyDshTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  isShellTool,
  // The harness `workflow` tool has no bounded fan-out argument, so a directive
  // that caps delegation cannot be proven for it.
  isUnboundedDelegation: (toolName) => normalizeToolName(toolName) === 'workflow',
  normalizePath
};
