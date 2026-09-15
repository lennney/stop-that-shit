'use strict';

const nodePath = require('node:path');

const WRITE_NAME = /(?:^|__|_)(?:add|append|apply|archive|close|commit|copy|create|delete|deploy|edit|install|merge|move|patch|post|publish|push|remove|rename|send|set|submit|update|upload|write)(?:$|__|_)/i;
const READ_NAME = /(?:^|__|_)(?:cat|check|diff|fetch|find|get|inspect|list|load|open|read|review|search|show|status|view)(?:$|__|_)/i;
const CONTROL_TOOLS = new Set(['update_plan', 'request_user_input', 'wait', 'wait_agent']);
const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp)$/i;
const HASH_COMMAND = /\b(?:Get-FileHash|md5sum|sha(?:1|224|256|384|512)sum|shasum|b2sum)\b|\bcertutil\b[^\r\n]*\s-hashfile\b|\bopenssl\s+dgst\b/i;
const HASH_API = /\b(?:createHash|createHmac)\s*\(|\bcrypto\.subtle\.digest\s*\(|\bhashlib\.(?:md5|sha1|sha224|sha256|sha384|sha512|blake2[bs])\s*\(|\bMessageDigest\.getInstance\s*\(|\bDigestUtils\.[A-Za-z0-9_]+\s*\(|\bsha(?:1|256|512)\.(?:New|Sum\w*)\s*\(|\b(?:bcrypt|argon2)\.hash\s*\(|\bpassword_hash\s*\(|\bPasswordHasher\s*\(/i;
const DEPENDENCY_COMMAND = /\b(?:npm|pnpm|yarn)\s+(?:add|install)\b|\bpip(?:3)?\s+install\b|\bcargo\s+add\b|\bdotnet\s+add\b[^\r\n]*\bpackage\b|\bgo\s+get\b|\bcomposer\s+require\b|\bbundle\s+add\b/i;

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '');
}

function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = inputText(toolInput);
  if (!text) return false;

  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return HASH_COMMAND.test(text);
  }

  if (name === 'apply_patch') {
    const added = text.split(/\r?\n/).filter((line) => /^\+(?!\+\+)/.test(line)).join('\n');
    return HASH_API.test(added);
  }

  if (name === 'Edit' || name === 'Write') {
    const filePath = String(toolInput && (toolInput.file_path || toolInput.path) || '');
    return CODE_PATH.test(filePath) && HASH_API.test(text);
  }

  return false;
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

function addedLinesByPatchedFile(text) {
  const sections = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const header = /^\*\*\* (?:Add|Update) File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      current = { path: normalizePath(header[1]), added: [] };
      sections.push(current);
      continue;
    }
    if (/^\*\*\*/.test(line)) {
      current = null;
      continue;
    }
    if (current && /^\+(?!\+\+)/.test(line)) current.added.push(line);
  }
  return sections;
}

function detectDependencyIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = inputText(toolInput);
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return DEPENDENCY_COMMAND.test(text);
  }
  if (name === 'apply_patch') {
    const manifest = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
    const dependencyDeclaration = /["']?(?:dependencies|devDependencies|optionalDependencies)["']?\s*[:=]|^[+]\s*[^#\s][^\r\n]*(?:==|>=|~=|\^\d)/mi;
    return addedLinesByPatchedFile(text).some((section) => (
      manifest.test(section.path) && dependencyDeclaration.test(section.added.join('\n'))
    ));
  }
  return false;
}

function classifyGitBranchArguments(argumentsText) {
  const args = argumentsText.trim();
  if (!args) return 'read';
  const mutation = /(?:^|\s)(?:-[a-zA-Z]*[dDmMcCf][a-zA-Z]*|--(?:delete|move|copy|force|edit-description|set-upstream-to|unset-upstream|track|no-track|create-reflog)(?:=[^\s]*)?)(?:\s|$)/;
  if (mutation.test(args)) return 'write';
  // These documented filters imply --list. Plain positional arguments create
  // a branch, so do not infer a read from the command name alone.
  const listing = /(?:^|\s)(?:-l|--(?:list|contains|no-contains|merged|no-merged|points-at))(?:[=\s]|$)/;
  if (listing.test(args)) return 'read';
  const readOption = /^(?:-[arv]+|--(?:show-current|all|remotes|verbose|no-color|no-column)|--color=(?:always|never|auto))$/;
  return args.split(/\s+/).every(arg => readOption.test(arg)) ? 'read' : 'unknown';
}

const READ_SHELL_COMMANDS = new Set([
  'get-content', 'get-childitem', 'get-item', 'test-path', 'resolve-path',
  'select-string', 'select-object', 'measure-object', 'compare-object', 'where-object',
  'rg', 'grep', 'findstr', 'cat', 'ls', 'dir', 'pwd', 'head', 'tail', 'wc', 'type'
]);
const WRITE_SHELL_COMMANDS = new Set([
  'remove-item', 'move-item', 'copy-item', 'set-content', 'add-content', 'out-file',
  'new-item', 'rm', 'del', 'erase', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'tee', 'apply_patch'
]);

// Analyze only static words, literal quotes and simple command chains. The
// hook does not expose a shell AST. Expansions, script blocks and ambiguous
// escapes stay unknown instead of being interpreted as Bash or PowerShell.
function staticShellCommands(text) {
  const commands = [];
  let args = [], word = '', inWord = false, quote = null, separator = null;
  const finishWord = () => {
    if (inWord) args.push(word);
    word = ''; inWord = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      if (quote === '"' && (char === '$' || char === '`'
          || char === '\\' && /["$`\\\r\n]/.test(next || ''))) return null;
      word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; inWord = true; continue; }
    if (/[ \t]/.test(char)) { finishWord(); continue; }
    if (char === '>') return { redirected: true };
    if (/[$`{}()<@%*?\[\]#]/.test(char)) return null;
    if (char === '\\' && (!next || /[\s'"$`;&|<>]/.test(next))) return null;
    if (char === '\r' || char === '\n' || char === ';' || char === '|' || char === '&') {
      finishWord();
      // PowerShell also accepts a standalone CR as a command separator.
      const operator = char === '\r' ? '\n'
        : (char === '&' || char === '|') && next === char ? char + text[++i] : char;
      if (operator === '&') return null;
      if (args.length) { commands.push(args); args = []; }
      else if (operator === '\n') continue;
      else return null;
      separator = operator;
      continue;
    }
    if (/\s/.test(char)) return null;
    word += char; inWord = true;
  }
  if (quote) return null;
  finishWord();
  if (args.length) commands.push(args);
  else if (['&&', '||', '|'].includes(separator)) return null;
  return commands.length ? { commands } : null;
}

function classifyStaticCommand([program, ...args]) {
  const name = String(program || '').toLowerCase();
  if (WRITE_SHELL_COMMANDS.has(name)) return 'write';
  if (name === 'git') {
    // Only these global options preserve the supported command interpretation.
    while (args.length) {
      if (args[0] === '--no-pager' || args[0] === '--literal-pathspecs') args.shift();
      else if (args[0] === '-C' && args.length > 1) args.splice(0, 2);
      else break;
    }
    const subcommand = args.shift();
    if (['add', 'commit', 'push', 'merge', 'rebase', 'checkout', 'switch', 'reset', 'restore', 'clean', 'tag'].includes(subcommand)) return 'write';
    if (args.some(arg => /^--output(?:=|$)/.test(arg))) return 'write';
    if (subcommand === 'branch') return classifyGitBranchArguments(args.join(' '));
    if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand)) return 'read';
    return 'unknown';
  }
  if (['npm', 'pnpm', 'yarn'].includes(name) && ['add', 'install', 'remove', 'uninstall', 'publish'].includes(args[0])) return 'write';
  if (['pip', 'pip3'].includes(name) && args[0] === 'install') return 'write';
  if (name === 'gh' && /^(?:pr (?:create|merge|close)|issue (?:create|close)|release create)$/.test(args.slice(0, 2).join(' '))) return 'write';
  if (name === 'rg' && args.some(arg => /^--pre(?:=|$)/.test(arg))) return 'unknown';
  if (READ_SHELL_COMMANDS.has(name)) return 'read';
  if (['node', 'python', 'python3', 'py'].includes(name) && args.length === 1 && args[0] === '--version') return 'read';
  return 'unknown';
}

function classifyShell(command) {
  const text = String(command || '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  const analysis = staticShellCommands(text);
  if (!analysis) return 'unknown';
  if (analysis.redirected) return 'write';
  const kinds = analysis.commands.map(classifyStaticCommand);
  if (kinds.includes('write')) return 'write';
  return kinds.every(kind => kind === 'read') ? 'read' : 'unknown';
}

function classifyCodexTool(toolName, toolInput) {
  const name = String(toolName || '');
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

module.exports = { classifyCodexTool, classifyShell, detectDependencyIntent, detectHashIntent, extractAffectedPaths };
