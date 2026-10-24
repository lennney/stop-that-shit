'use strict';

const HASH_COMMAND = /\b(?:Get-FileHash|md5sum|sha(?:1|224|256|384|512)sum|shasum|b2sum)\b|\bcertutil\b[^\r\n]*\s-hashfile\b|\bopenssl\s+dgst\b/i;
const DEPENDENCY_COMMAND = /\b(?:npm|pnpm|yarn)\s+(?:add|install)\b|\bpip(?:3)?\s+install\b|\bcargo\s+add\b|\bdotnet\s+add\b[^\r\n]*\bpackage\b|\bgo\s+get\b|\bcomposer\s+require\b|\bbundle\s+add\b/i;

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
    if (char === '>') return { redirected: true, redirectTarget: redirectTarget(text, i + 1) };
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

// A redirect writes the file its target names. Only a statically spelled
// target is proven: fd duplication and expansion exceed the parser's facts.
function redirectTarget(text, start) {
  let i = start;
  if (text[i] === '>' || text[i] === '|') i++;
  else if (text[i] === '&') return null;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  const target = [];
  let quote = null;
  for (; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      // A double-quoted target is literal only while it holds no expansion.
      if (quote === '"' && (char === '$' || char === '`')) return null;
      target.push(char);
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (' \t\r\n;&|<>'.includes(char)) break;
    if ('`$%*?[]{}()#~'.includes(char) || char === '\\') return null;
    target.push(char);
  }
  if (quote) return null;
  return target.length ? target.join('') : null;
}

// Option tables for the write commands whose target is the named operand.
const POSIX_WRITE_FLAGS = new Set([
  '-a', '-c', '-d', '-f', '-h', '-i', '-m', '-n', '-p', '-r', '-R', '-v',
  '-A', '--append', '--parents', '--force', '--recursive', '--interactive',
  '--verbose', '--dir', '--one-file-system', '--preserve-root',
  '--no-preserve-root', '--no-create', '--no-dereference', '--no-clobber',
  '--ignore-fail-on-non-empty', '--ignore-interrupts', '--strip-trailing-slashes',
  '--zero', '-Z'
]);
const POSIX_WRITE_VALUE_OPTIONS = new Set(['-t', '-S', '-m', '--mode', '--suffix', '--target-directory', '--reference']);
const POWERSHELL_WRITE_FLAGS = new Set([
  '-recurse', '-force', '-verbose', '-whatif', '-nonewline', '-passthru',
  '-append', '-confirm', '-asbytestream', '-usebom', '-noclobber', '-container'
]);
const POWERSHELL_WRITE_VALUE_OPTIONS = new Set([
  '-path', '-literalpath', '-filepath', '-destination', '-pspath', '-value',
  '-encoding', '-itemtype', '-stream', '-delimiter', '-width', '-credential',
  '-filter', '-include', '-exclude', '-culture'
]);
const POWERSHELL_PATH_OPTIONS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-pspath']);
const GIT_ADD_FLAGS = new Set([
  '-A', '--all', '-u', '--update', '-p', '--patch', '-n', '--dry-run', '-f',
  '--force', '-v', '--verbose', '--intent-to-add', '-N', '--no-all',
  '--ignore-removal', '--no-ignore-removal', '-e', '--edit', '--renormalize',
  '--sparse', '-i', '--interactive', '--ignore-errors', '--refresh', '--chmod'
]);

// An option the table does not name ends the proof: the parser cannot tell an
// option value from a path, so the write target stays unproven.
function posixWritePaths(args, destinationOnly) {
  const paths = [];
  let target = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { paths.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { paths.push(arg); continue; }
    if (POSIX_WRITE_FLAGS.has(arg) || /^-[a-zA-Z]+$/.test(arg)) continue;
    if (POSIX_WRITE_VALUE_OPTIONS.has(arg)) {
      if (++i === args.length) return null;
      if (arg === '-t' || arg === '--target-directory') target = args[i];
      continue;
    }
    return null;
  }
  if (target) return [target];
  if (destinationOnly) return paths.length ? [paths[paths.length - 1]] : [];
  return paths;
}

function powershellWritePaths(args) {
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.toLowerCase();
    // -Name resolves against -Path, so it does not name the written path.
    if (name === '-name') return null;
    if (POWERSHELL_WRITE_VALUE_OPTIONS.has(name)) {
      if (++i === args.length) return null;
      if (POWERSHELL_PATH_OPTIONS.has(name)) paths.push(args[i]);
      continue;
    }
    if (arg.startsWith('-')) {
      if (POWERSHELL_WRITE_FLAGS.has(name)) continue;
      return null;
    }
    paths.push(arg);
  }
  return paths;
}

function gitAddPaths(args) {
  const rest = [...args];
  while (rest.length) {
    if (rest[0] === '--no-pager' || rest[0] === '--literal-pathspecs') rest.shift();
    else if (rest[0] === '-C' && rest.length > 1) rest.splice(0, 2);
    else break;
  }
  if (rest.shift() !== 'add') return null;
  const paths = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') { paths.push(...rest.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { paths.push(arg); continue; }
    if (GIT_ADD_FLAGS.has(arg) || arg.startsWith('--chmod=')) continue;
    return null;
  }
  return paths;
}

// The paths a proven write command names, or null when its arguments do not
// prove a target. Reads are absent on purpose: their operands are data.
function writePathsFromArguments(name, args) {
  if (name === 'git') return gitAddPaths(args);
  if (name === 'cp' || name === 'copy' || name === 'copy-item') return posixWritePaths(args, true);
  if (name === 'rm' || name === 'del' || name === 'erase' || name === 'rmdir'
      || name === 'mkdir' || name === 'touch' || name === 'mv' || name === 'move'
      || name === 'move-item' || name === 'rename' || name === 'tee') return posixWritePaths(args, false);
  if (name === 'set-content' || name === 'add-content' || name === 'out-file'
      || name === 'new-item' || name === 'remove-item') return powershellWritePaths(args);
  return null;
}

// A file boundary is only as good as the proof behind it: one command whose
// writes stay unnamed leaves the whole chain unproven rather than narrowing the
// boundary to the paths the parser happened to see.
function provenWritePaths(rawCommands, classifications) {
  const paths = [];
  for (let index = 0; index < classifications.length; index++) {
    const classification = classifications[index];
    if (classification.mutability === 'read') continue;
    const [program, ...args] = rawCommands[index].args;
    const named = classification.mutability === 'write'
      ? writePathsFromArguments(String(program || '').toLowerCase(), args)
      : null;
    if (named === null) return [];
    paths.push(...named);
  }
  return paths;
}

function analyzeShell(command) {
  const text = String(command || '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  const analysis = staticShellCommands(text);
  if (!analysis || analysis.redirected) {
    const redirected = Boolean(analysis && analysis.redirected);
    const target = redirected ? analysis.redirectTarget : null;
    return {
      ...shellClassification(redirected ? 'write' : 'unknown', redirected ? 'shell_redirection' : 'shell_syntax_unproven'),
      hashIntent: HASH_COMMAND.test(text), dependencyIntent: DEPENDENCY_COMMAND.test(text),
      affectedPaths: target ? [target] : []
    };
  }
  const commands = analysis.commands.map(command => ({
    ...classifyStaticCommand(command), text: command.args.join(' ')
  }));
  // Proven reads treat their arguments as data. Keep the existing intent checks
  // for writes and unproven programs, independently for each command in a chain.
  return {
    ...combineClassifications(commands),
    hashIntent: commands.some(command => command.mutability !== 'read' && HASH_COMMAND.test(command.text)),
    dependencyIntent: commands.some(command => command.mutability !== 'read' && DEPENDENCY_COMMAND.test(command.text)),
    affectedPaths: provenWritePaths(analysis.commands, commands)
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

// Some installed hook payloads lack command but carry intent text in a legacy
// field. Keep their mutability unproven while retaining hash/dependency facts.
function analyzeShellInput(toolInput) {
  const command = toolInput && toolInput.command;
  const text = typeof toolInput === 'string' ? toolInput
    : toolInput && typeof toolInput === 'object'
      ? String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '') : '';
  const analysis = analyzeShell(command);
  if (text !== String(command || '')) {
    const intents = analyzeShell(text);
    analysis.hashIntent = intents.hashIntent;
    analysis.dependencyIntent = intents.dependencyIntent;
  }
  return analysis;
}

// Adapters contribute their own tool-field proof and a shell command
// contributes the proof it parsed. Both are paths, so the boundary sees the
// union, normalized the way the calling host normalizes its own arguments.
function combineAffectedPaths(paths, analysis, normalize) {
  const merged = Array.isArray(paths) ? [...paths] : [];
  const shellPaths = Array.isArray(analysis && analysis.affectedPaths) ? analysis.affectedPaths : [];
  for (const value of shellPaths) {
    const path = normalize(value);
    if (path && !merged.includes(path)) merged.push(path);
  }
  return merged;
}

module.exports = { analyzeShell, analyzeShellInput, classifyShell, combineAffectedPaths };
