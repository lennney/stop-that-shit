'use strict';

const nodePath = require('node:path');
const {
  classifyShell,
  detectDependencyIntent: detectCodexDependencyIntent,
  detectHashIntent: detectCodexHashIntent
} = require('./codex-tool-classifier.cjs');

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
  if (Array.isArray(input.tasks)) return input.tasks.length;
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

const HERMES_MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
const JSON_DEPENDENCY_FIELD = /["']?(?:dependencies|devDependencies|optionalDependencies|require)["']?\s*[:=]/i;
const REQUIREMENT_DECLARATION = /^\s*[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]\r\n]+\])?\s*(?:(?:===|==|~=|!=|<=|>=|<|>|\^)\s*\S+)?(?:\s*;.*)?$/;
const CARGO_ASSIGNMENT = /^\s*[A-Za-z0-9][A-Za-z0-9_-]*\s*=\s*(?:["']|\{)/;
const GO_REQUIRE_DECLARATION = /^\s*(?:require\s+\S+\s+v\d|[A-Za-z0-9_.\/-]+\s+v\d)/m;
const GEM_DECLARATION = /^\s*gem\s+["']/;

function isCargoDependencySection(section) {
  return /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)(?:\.|$)/.test(section);
}

function detectHermesManifestDependency(filePath, content) {
  const normalizedPath = String(filePath || '').trim().replace(/\\/g, '/');
  const text = String(content || '');
  if (!HERMES_MANIFEST.test(normalizedPath)) return false;

  if (/(?:^|\/)(?:package\.json|pyproject\.toml|composer\.json)$/i.test(normalizedPath)) {
    return JSON_DEPENDENCY_FIELD.test(text);
  }
  if (/(?:^|\/)requirements[^/]*\.txt$/i.test(normalizedPath)) {
    return text.split(/\r?\n/).some((line) => REQUIREMENT_DECLARATION.test(line));
  }
  if (/(?:^|\/)Cargo\.toml$/i.test(normalizedPath)) {
    let dependencySection = false;
    for (const line of text.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) dependencySection = isCargoDependencySection(header[1]);
      if (dependencySection && CARGO_ASSIGNMENT.test(line)) return true;
    }
    return false;
  }
  if (/(?:^|\/)go\.mod$/i.test(normalizedPath)) return GO_REQUIRE_DECLARATION.test(text);
  if (/(?:^|\/)Gemfile$/i.test(normalizedPath)) return GEM_DECLARATION.test(text);
  return false;
}

function hermesPatchSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const header = /^\*\*\*\s*(?:Add|Update)\s+File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      current = { path: header[1], content: [] };
      sections.push(current);
      continue;
    }
    if (/^\*\*\*/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (/^\+(?!\+\+)/.test(line) || /^ /.test(line)) current.content.push(line.slice(1));
  }
  return sections;
}

function detectDependencyIntent(toolName, toolInput) {
  const name = codexToolName(toolName, toolInput);
  const input = codexIntentInput(toolName, toolInput);
  if (name === 'Write') {
    return detectHermesManifestDependency(input.path, input.content);
  }
  if (name === 'apply_patch') {
    const sections = hermesPatchSections(input.patch);
    if (sections.some((section) => detectHermesManifestDependency(section.path, section.content.join('\n')))) return true;
    const normalizedPatch = String(input.patch || '').replace(/^\*\*\*(?=(?:Add|Update|Delete)\s+File:)/gm, '*** ');
    return detectCodexDependencyIntent(name, { ...input, patch: normalizedPatch });
  }
  return detectCodexDependencyIntent(name, input);
}

function detectHashIntent(toolName, toolInput) {
  return detectCodexHashIntent(codexToolName(toolName, toolInput), codexIntentInput(toolName, toolInput));
}

module.exports = {
  classifyHermesTool,
  countHermesDelegation,
  extractAffectedPaths,
  detectDependencyIntent,
  detectHashIntent,
  isHermesDelegationControl
};
