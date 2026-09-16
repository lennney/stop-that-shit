'use strict';

const path = require('node:path');
const {
  analyzeShell,
  classifyCodexTool,
  classifyShell,
  detectDependencyIntent: detectCodexDependencyIntent,
  detectHashIntent: detectCodexHashIntent
} = require('./codex-tool-classifier.cjs');

const WRITE_TOOLS = new Set(['apply_patch', 'edit', 'write']);
const READ_TOOLS = new Set(['glob', 'grep', 'lsp', 'read', 'webfetch', 'websearch']);
const CONTROL_TOOLS = new Set(['plan_enter', 'plan_exit', 'question', 'skill', 'todowrite']);
const MANIFEST_PATH = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
const DEPENDENCY_DECLARATION = /["']?(?:dependencies|devDependencies|optionalDependencies)["']?\s*[:=]|(?:^|\n)\s*[^#\s][^\r\n]*(?:==|>=|~=|\^\d)/i;

function normalizePath(value, cwd) {
  const original = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!original) return '';

  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(original);
  const windowsCwd = /^[A-Za-z]:[\\/]|^\\\\/.test(String(cwd || ''));
  let normalized = original;
  if (cwd && windowsPath && windowsCwd) {
    normalized = path.win32.relative(String(cwd), original);
  } else if (cwd && path.posix.isAbsolute(original) && path.posix.isAbsolute(String(cwd))) {
    normalized = path.posix.relative(String(cwd), original);
  }
  return normalized.replace(/\\/g, '/').replace(/^\.\//, '');
}

function patchText(args) {
  return String(args && args.patchText || '');
}

function classifyOpenCodeTool(toolName, args) {
  const name = String(toolName || '').toLowerCase();
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'bash') return classifyShell(args && args.command);
  if (name === 'task') return args && args.task_id ? 'control' : 'delegate';
  if (READ_TOOLS.has(name)) return 'read';
  if (CONTROL_TOOLS.has(name)) return 'control';
  return classifyCodexTool(toolName, args);
}

function extractAffectedPaths(toolName, args, cwd, mutability) {
  const name = String(toolName || '').toLowerCase();
  if (name === 'edit' || name === 'write') {
    const file = normalizePath(args && args.filePath, cwd);
    return file ? [file] : [];
  }

  if (name === 'apply_patch') {
    const files = [];
    for (const line of patchText(args).split(/\r?\n/)) {
      const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line)
        || /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
      if (match) files.push(normalizePath(match[1], cwd));
    }
    return [...new Set(files.filter(Boolean))];
  }

  if ((mutability ?? classifyOpenCodeTool(toolName, args)) === 'write') {
    const file = normalizePath(args && (args.filePath || args.file_path || args.path), cwd);
    return file ? [file] : [];
  }
  return [];
}

function detectDependencyIntent(toolName, args) {
  const name = String(toolName || '').toLowerCase();
  if (name === 'bash') {
    return detectCodexDependencyIntent('Bash', { command: args && args.command });
  }
  if (name === 'apply_patch') {
    return detectCodexDependencyIntent('apply_patch', { patch: patchText(args) });
  }
  if (name === 'edit' || name === 'write') {
    const file = normalizePath(args && args.filePath);
    const added = String(args && (name === 'edit' ? args.newString : args.content) || '');
    return MANIFEST_PATH.test(file) && DEPENDENCY_DECLARATION.test(added);
  }
  return false;
}

function detectHashIntent(toolName, args) {
  const name = String(toolName || '').toLowerCase();
  if (name === 'bash') {
    return detectCodexHashIntent('Bash', { command: args && args.command });
  }
  if (name === 'apply_patch') {
    return detectCodexHashIntent('apply_patch', { patch: patchText(args) });
  }
  if (name === 'edit') {
    return detectCodexHashIntent('Edit', {
      file_path: args && args.filePath,
      new_string: args && args.newString
    });
  }
  if (name === 'write') {
    return detectCodexHashIntent('Write', {
      file_path: args && args.filePath,
      content: args && args.content
    });
  }
  return false;
}

function analyzeOpenCodeTool(toolName, args, cwd) {
  const analysis = String(toolName || '').toLowerCase() === 'bash'
    ? analyzeShell(args && args.command)
    : {
      mutability: classifyOpenCodeTool(toolName, args),
      hashIntent: detectHashIntent(toolName, args),
      dependencyIntent: detectDependencyIntent(toolName, args)
    };
  return { ...analysis, affectedPaths: extractAffectedPaths(toolName, args, cwd, analysis.mutability) };
}

module.exports = {
  analyzeOpenCodeTool,
  classifyOpenCodeTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  normalizePath
};
