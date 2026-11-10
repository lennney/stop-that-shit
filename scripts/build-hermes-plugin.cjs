'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, '.hermes-plugin', 'runtime', 'stop-that-shit.cjs');
const jobGuardPath = path.join(root, 'src', 'windows-job-guard.cs');
const outputJobGuardPath = path.join(root, '.hermes-plugin', 'runtime', 'windows-job-guard.cs');
const entryPath = path.join(root, 'src', 'adapters', 'hermes-hooks.cjs');
const packagePath = path.join(root, 'package.json');

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

function resolveModule(request, fromFile) {
  if (request === '../package.json') return packagePath;
  if (!request.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [base, `${base}.cjs`, `${base}.js`, `${base}.json`, path.join(base, 'index.cjs')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve bundled module ${request} from ${fromFile}`);
}

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

function memberName(node) {
  return node?.type === 'MemberExpression' ? node.computed ? staticString(node.property) : node.property.name : null;
}

function isEntrypointComparison(node) {
  if (node?.type !== 'BinaryExpression' || !['===', '!==', '==', '!='].includes(node.operator)) return false;
  return [[node.left, node.right], [node.right, node.left]].some(([main, module]) =>
    main.type === 'MemberExpression' && main.object.type === 'Identifier' && main.object.name === 'require'
      && memberName(main) === 'main' && module.type === 'Identifier' && module.name === 'module');
}

function isPropertyName(node, parent) {
  return parent?.type === 'MemberExpression' && !parent.computed && parent.property === node
    || parent?.type === 'Property' && !parent.computed && !parent.shorthand && parent.key === node
    || ['MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && !parent.computed && parent.key === node;
}

function collect(file, modules) {
  const id = path.relative(root, file).split(path.sep).join('/');
  if (modules.has(id)) return id;
  const source = normalizeNewlines(fs.readFileSync(file, 'utf8'));
  const module = { id, file, source, imports: [] };
  modules.set(id, module);
  if (file.endsWith('.json')) return id;
  const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  function unsupported(node) {
    const line = source.slice(0, node.start).split('\n').length;
    throw new Error(`Unsupported CommonJS require or module usage in ${id}:${line}; use a direct static require, module.exports, or a require.main comparison.`);
  }
  function walk(node, parent, grandparent) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const argument = node.arguments[0];
      const request = staticString(argument);
      if (node.optional || node.arguments.length !== 1 || typeof request !== 'string') unsupported(node);
      const dependency = resolveModule(request, file);
      if (dependency) module.imports.push({ start: node.start, end: node.end, id: collect(dependency, modules) });
    }
    if (node.type === 'Identifier' && node.name === 'module') {
      const exportsAccess = parent?.type === 'MemberExpression' && parent.object === node && memberName(parent) === 'exports';
      // The module shim supports exports and entrypoint comparisons, not
      // alternate loaders or aliases that escape static import discovery.
      if (!exportsAccess && !isEntrypointComparison(parent) && !isPropertyName(node, parent)) unsupported(node);
    }
    if (node.type === 'Identifier' && node.name === 'require') {
      const directCall = parent?.type === 'CallExpression' && parent.callee === node;
      const entrypointCheck = parent?.type === 'MemberExpression' && parent.object === node
        && isEntrypointComparison(grandparent);
      // Aliases and shadowed bindings cannot use the bundle's module loader.
      if (!directCall && !entrypointCheck && !isPropertyName(node, parent)) unsupported(node);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) walk(child, node, parent);
      else if (value && typeof value === 'object') walk(value, node, parent);
    }
  }
  walk(syntax);
  return id;
}

function renderModule(module) {
  if (module.file.endsWith('.json')) return `module.exports = ${module.source.trim()};`;
  let source = module.source;
  // Replace actual call ranges from right to left, never text in comments,
  // strings, regexes or template text. Native module imports stay untouched.
  for (const entry of module.imports.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, entry.start) + `__require(${JSON.stringify(entry.id)})` + source.slice(entry.end);
  }
  return source;
}

function build() {
  const modules = new Map();
  collect(entryPath, modules);
  const packageJson = normalizeNewlines(fs.readFileSync(packagePath, 'utf8')).trim();
  const rendered = [...modules.values()].map((module) =>
    `${JSON.stringify(module.id)}: function(module, exports, __require) {\n${renderModule(module)}\n}`
  ).join(',\n');
  return `// GENERATED FILE — DO NOT EDIT. Build with: npm run hermes:build\n// Generated from the src/ module graph by scripts/build-hermes-plugin.cjs.\n'use strict';\n\nconst __modules = {\n${rendered}\n};\n__modules[${JSON.stringify('package.json')}] = function(module) { module.exports = ${packageJson}; };\nconst __cache = new Map();\nfunction __require(id) {\n  if (__cache.has(id)) return __cache.get(id).exports;\n  const module = { exports: {} };\n  __cache.set(id, module);\n  if (!__modules[id]) throw new Error('Bundled module not found: ' + id);\n  __modules[id](module, module.exports, __require);\n  return module.exports;\n}\n\nfunction __readStdin(maxWaitMs = 1500) {\n  return new Promise((resolve) => {\n    let settled = false; let body = '';\n    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(body); };\n    const timer = setTimeout(finish, maxWaitMs);\n    process.stdin.setEncoding('utf8');\n    process.stdin.on('data', (chunk) => { body += chunk; });\n    process.stdin.on('end', finish);\n    process.stdin.on('error', finish);\n    process.stdin.resume();\n  });\n}\nfunction __dataDir() {\n  const hermesHome = process.env.HERMES_HOME || require('node:path').join(process.env.HOME || '', '.hermes');\n  return require('node:path').join(hermesHome, 'stop-that-shit');\n}\n(async () => {\n  try {\n    const raw = await __readStdin();\n    if (!raw.trim()) return;\n    const output = __require(${JSON.stringify(path.relative(root, entryPath).split(path.sep).join('/'))}).handleHermesHook(JSON.parse(raw), { dataDir: __dataDir() });\n    if (output) process.stdout.write(JSON.stringify(output) + '\\n');\n  } catch (error) {\n    const errorName = error && error.name ? error.name : 'HookError';\n    process.stderr.write('Stop That Shit Hermes hook failed open: ' + errorName + '\\n');\n  }\n})();\n`;
}

const output = build();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? normalizeNewlines(fs.readFileSync(outputPath, 'utf8')) : '';
  const currentJobGuard = fs.existsSync(outputJobGuardPath) ? normalizeNewlines(fs.readFileSync(outputJobGuardPath, 'utf8')) : '';
  const expectedJobGuard = normalizeNewlines(fs.readFileSync(jobGuardPath, 'utf8'));
  if (current !== output || currentJobGuard !== expectedJobGuard) {
    console.error('Hermes runtime bundle is stale; run npm run hermes:build');
    process.exit(1);
  }
  console.log('Hermes runtime bundle unchanged and deterministic.');
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  fs.writeFileSync(outputJobGuardPath, normalizeNewlines(fs.readFileSync(jobGuardPath, 'utf8')));
  console.log(`Built ${path.relative(root, outputPath)}`);
}
