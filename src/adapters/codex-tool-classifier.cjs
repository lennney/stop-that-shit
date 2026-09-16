'use strict';

const nodePath = require('node:path');

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
    return analyzeShell(text).hashIntent;
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
    return analyzeShell(text).dependencyIntent;
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

function classifyGitBranchArguments(args) {
  let listing = false, positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional ||= i + 1 < args.length; break; }
    if (!arg.startsWith('-')) { positional = true; continue; }
    if (/^(?:-[a-zA-Z]*[dDmMcCf][a-zA-Z]*|--(?:delete|move|copy|force|edit-description|set-upstream-to|unset-upstream|track|no-track|create-reflog)(?:=.*)?)$/.test(arg)) return 'write';
    if (arg === '--list' || /^-[alrv]+$/.test(arg)) {
      listing ||= arg === '--list' || arg.includes('l');
      continue;
    }
    if (/^--(?:contains|no-contains|merged|no-merged)(?:=.*)?$/.test(arg)) {
      listing = true;
      if (!arg.includes('=') && args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (/^--(?:points-at|format|sort)(?:=.*)?$/.test(arg)) {
      listing ||= arg === '--points-at' || arg.startsWith('--points-at=');
      if (!arg.includes('=')) {
        if (i + 1 === args.length) return 'unknown';
        i++;
      }
      continue;
    }
    if (/^--(?:show-current|all|remotes|verbose|no-color|column|no-column|ignore-case|omit-empty|no-abbrev)$/.test(arg)
        || /^--(?:color=(?:always|never|auto)|abbrev(?:=\d+)?|column=.+)$/.test(arg)) continue;
    // Negation and abbreviations can cancel --list or select a mutation.
    return 'unknown';
  }
  return positional && !listing ? 'unknown' : 'read';
}

const READ_POWERSHELL_COMMANDS = new Set([
  'get-content', 'get-childitem', 'get-item', 'test-path', 'resolve-path',
  'select-string', 'select-object', 'measure-object', 'compare-object', 'where-object'
]);
const READ_SHELL_COMMANDS = new Set([
  ...READ_POWERSHELL_COMMANDS,
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
  let nativeQuotes = false;
  const finishWord = () => {
    if (inWord) args.push(word);
    word = ''; inWord = false;
  };
  const finishCommand = () => {
    commands.push({ args, nativeQuotes });
    args = []; nativeQuotes = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    // PowerShell recognizes these quotes; Bash treats them as ordinary text.
    // They are literal only inside a quote of the opposite kind.
    const smartQuote = /[\u2018-\u201b]/.test(char) ? "'"
      : /[\u201c-\u201e]/.test(char) ? '"' : null;
    if (smartQuote && (!quote || quote === smartQuote)) return null;
    if (quote) {
      // Legacy PowerShell native argv can split embedded double quotes back
      // into options. Cmdlets receive the literal argument directly.
      if (quote === "'" && char === '"' || quote === '"' && char === '"' && next === '"') nativeQuotes = true;
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
    // Bash removes even an escape before an ordinary letter (e.g. --out\put).
    // Without a shell identity, do not interpret an unquoted backslash.
    if (char === '\\') return null;
    if (char === '\r' || char === '\n' || char === ';' || char === '|' || char === '&') {
      finishWord();
      // PowerShell also accepts a standalone CR as a command separator.
      const operator = char === '\r' ? '\n'
        : (char === '&' || char === '|') && next === char ? char + text[++i] : char;
      if (operator === '&') return null;
      if (args.length) finishCommand();
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
  if (args.length) finishCommand();
  else if (['&&', '||', '|'].includes(separator)) return null;
  return commands.length ? { commands } : null;
}

// Consume ripgrep option values before interpreting -- or executable options.
// Otherwise a pattern named -- can hide a later --hostname-bin, or an option
// name used as a literal pattern can be mistaken for an executable option.
const RIPGREP_VALUE_OPTIONS = new Set([
  '--regexp', '--file', '--pre-glob', '--dfa-size-limit', '--encoding', '--engine',
  '--max-count', '--regex-size-limit', '--threads', '--glob', '--iglob',
  '--ignore-file', '--max-depth', '--max-filesize', '--type', '--type-not',
  '--type-add', '--type-clear', '--after-context', '--before-context', '--color',
  '--colors', '--context', '--context-separator', '--field-context-separator',
  '--field-match-separator', '--hyperlink-format', '--max-columns',
  '--path-separator', '--replace', '--sort', '--sortr', '--generate'
]);

function classifyRipgrepArguments(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (/^--(?:pre|hostname-bin)(?:=|$)/.test(arg)) return shellClassification('unknown', 'shell_execution_option');
    let consumesValue = RIPGREP_VALUE_OPTIONS.has(arg);
    if (/^-[^-]/.test(arg)) {
      // A value can be attached to a short option, including in a flag cluster.
      const valueFlag = /[efEmjgdtTABCMr]/.exec(arg.slice(1));
      consumesValue = Boolean(valueFlag && valueFlag.index === arg.length - 2);
    }
    if (consumesValue && ++i === args.length) return shellClassification('unknown', 'option_value_missing');
  }
  return shellClassification('read');
}

function shellClassification(mutability, analysisReason) {
  return { mutability, ...(analysisReason ? { analysisReason } : {}) };
}

function combineClassifications(classifications) {
  const kinds = classifications.map(result => result.mutability);
  const mutability = kinds.includes('write') ? 'write'
    : kinds.every(kind => kind === 'read') ? 'read' : 'unknown';
  const decisive = classifications.find(result => result.mutability === mutability);
  return shellClassification(mutability, decisive?.analysisReason);
}

function classifyStaticCommand({ args: [program, ...args], nativeQuotes }) {
  const name = String(program || '').toLowerCase();
  if (WRITE_SHELL_COMMANDS.has(name)) return shellClassification('write');
  const cmdlet = READ_POWERSHELL_COMMANDS.has(name);
  if (nativeQuotes && !cmdlet) return shellClassification('unknown', 'native_quotes_unproven');
  const classifications = [classifyCommandArguments(name, [...args])];
  // Legacy PowerShell drops empty native argv entries. A read must remain a
  // read in both interpretations; cmdlets receive their arguments directly.
  if (!cmdlet && args.includes('')) classifications.push(classifyCommandArguments(name, args.filter(arg => arg !== '')));
  const result = combineClassifications(classifications);
  if (classifications.some(entry => entry.mutability !== result.mutability)) result.analysisReason = 'native_empty_arguments';
  return result;
}

function analyzeShell(command) {
  const text = String(command || '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  const analysis = staticShellCommands(text);
  if (!analysis || analysis.redirected) return {
    ...shellClassification(analysis?.redirected ? 'write' : 'unknown', analysis?.redirected ? 'shell_redirection' : 'shell_syntax_unproven'),
    hashIntent: HASH_COMMAND.test(text), dependencyIntent: DEPENDENCY_COMMAND.test(text)
  };
  const commands = analysis.commands.map(command => ({
    ...classifyStaticCommand(command), text: command.args.join(' ')
  }));
  // Proven reads treat their arguments as data. Keep the existing intent checks
  // for writes and unproven programs, independently for each command in a chain.
  return {
    ...combineClassifications(commands),
    hashIntent: commands.some(command => command.mutability !== 'read' && HASH_COMMAND.test(command.text)),
    dependencyIntent: commands.some(command => command.mutability !== 'read' && DEPENDENCY_COMMAND.test(command.text))
  };
}

// Required values consume the following argument, even when it is --. Optional
// values must be attached with =. Unknown options cannot establish a read.
const GIT_QUERY_VALUE_OPTIONS = new Set([
  '--word-diff-regex', '--src-prefix', '--dst-prefix', '--line-prefix',
  '--output-indicator-new', '--output-indicator-old', '--output-indicator-context',
  '--diff-algorithm', '--anchored', '--ignore-matching-lines', '--diff-filter',
  '--stat-width', '--stat-name-width', '--stat-graph-width', '--stat-count',
  '--inter-hunk-context', '--rotate-to', '--skip-to', '--find-object'
]);
const GIT_QUERY_FLAGS = new Set([
  '--short', '--branch', '--show-stash', '--no-index', '--numstat', '--shortstat',
  '--name-only', '--name-status', '--check', '--summary', '--patch', '--no-patch',
  '--raw', '--binary', '--cached', '--staged', '--exit-code', '--quiet',
  '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-all-space',
  '--ignore-space-change', '--ignore-space-at-eol', '--ignore-cr-at-eol',
  '--ignore-blank-lines', '--patience', '--histogram', '--minimal',
  '--oneline', '--all', '--reverse', '--first-parent', '--no-merges', '--merges',
  '--graph', '--no-decorate', '--topo-order', '--date-order', '--no-renames',
  '--pickaxe-all', '--pickaxe-regex', '--no-prefix', '--default-prefix',
  '--show-toplevel', '--show-prefix', '--show-cdup', '--git-dir', '--git-common-dir',
  '--is-inside-work-tree', '--is-bare-repository', '--verify', '--symbolic-full-name'
]);
const GIT_QUERY_OPTIONAL_VALUES = new Set([
  '--stat', '--color', '--word-diff', '--color-words', '--relative', '--unified',
  '--abbrev', '--short', '--abbrev-ref', '--porcelain', '--untracked-files', '--ignored',
  '--find-renames', '--find-copies', '--break-rewrites', '--decorate', '--pretty'
]);
const GIT_QUERY_ATTACHED_ONLY = new Set([
  '--format', '--date', '--since', '--until', '--before', '--after', '--author',
  '--committer', '--grep', '--max-count', '--skip', '--diff-merges', '--encoding'
]);

function classifyGitQueryArguments(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    if (/^--output(?:=|$)/.test(arg)) return shellClassification('write', 'git_output_file');
    const name = arg.split('=', 1)[0];
    if (GIT_QUERY_VALUE_OPTIONS.has(name)) {
      if (arg === name && ++i === args.length) return shellClassification('unknown', 'option_value_missing');
      continue;
    }
    if (GIT_QUERY_FLAGS.has(arg) || GIT_QUERY_OPTIONAL_VALUES.has(name)
        || arg.includes('=') && GIT_QUERY_ATTACHED_ONLY.has(name)) continue;
    if (/^-[SGOIn]$/.test(arg)) {
      if (++i === args.length) return shellClassification('unknown', 'option_value_missing');
      continue;
    }
    if (/^-[SGOI].+/.test(arg) || /^-n\d+$/.test(arg) || /^-\d+$/.test(arg)
        || /^-[pwsbz]+$/.test(arg) || /^-[UMCB](?:\d+%?)?$/.test(arg)
        || /^-u(?:no|normal|all)?$/.test(arg)) continue;
    return shellClassification('unknown', 'git_arguments_unproven');
  }
  return shellClassification('read');
}

function classifyCommandArguments(name, args) {
  if (name === 'git') {
    // Only these global options preserve the supported command interpretation.
    while (args.length) {
      if (args[0] === '--no-pager' || args[0] === '--literal-pathspecs') args.shift();
      else if (args[0] === '-C' && args.length > 1) args.splice(0, 2);
      else break;
    }
    const subcommand = args.shift();
    if (['add', 'commit', 'push', 'merge', 'rebase', 'checkout', 'switch', 'reset', 'restore', 'clean', 'tag'].includes(subcommand)) return shellClassification('write');
    if (subcommand === 'branch') {
      const mutability = classifyGitBranchArguments(args);
      return shellClassification(mutability, mutability === 'unknown' ? 'git_arguments_unproven' : undefined);
    }
    if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand)) return classifyGitQueryArguments(args);
    return shellClassification('unknown', 'git_arguments_unproven');
  }
  if (['npm', 'pnpm', 'yarn'].includes(name) && ['add', 'install', 'remove', 'uninstall', 'publish'].includes(args[0])) return shellClassification('write');
  if (['pip', 'pip3'].includes(name) && args[0] === 'install') return shellClassification('write');
  if (name === 'gh' && /^(?:pr (?:create|merge|close)|issue (?:create|close)|release create)$/.test(args.slice(0, 2).join(' '))) return shellClassification('write');
  if (name === 'rg') return classifyRipgrepArguments(args);
  if (READ_SHELL_COMMANDS.has(name)) return shellClassification('read');
  if (['node', 'python', 'python3', 'py'].includes(name) && args.length === 1 && args[0] === '--version') return shellClassification('read');
  return shellClassification('unknown', 'shell_command_unproven');
}

function classifyShell(command) {
  return analyzeShell(command).mutability;
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
    const command = toolInput && toolInput.command;
    analysis = analyzeShell(command);
    // Preserve the legacy intent fallback for inputs without a command field.
    // Normal shell inputs share the same analysis for all three decisions.
    const text = inputText(toolInput);
    if (text !== String(command || '')) {
      const intents = analyzeShell(text);
      analysis.hashIntent = intents.hashIntent;
      analysis.dependencyIntent = intents.dependencyIntent;
    }
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
