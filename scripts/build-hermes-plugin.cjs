'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, '.hermes-plugin', 'runtime', 'stop-that-shit.cjs');
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

function collect(file, modules) {
  const id = path.relative(root, file).split(path.sep).join('/');
  if (modules.has(id)) return id;
  const source = normalizeNewlines(fs.readFileSync(file, 'utf8'));
  const module = { id, file, source, dependencies: new Map() };
  modules.set(id, module);
  if (file.endsWith('.json')) return id;
  const requirePattern = /require\((['"])([^'"]+)\1\)/g;
  for (const match of source.matchAll(requirePattern)) {
    const dependency = resolveModule(match[2], file);
    if (dependency) module.dependencies.set(match[2], collect(dependency, modules));
  }
  return id;
}

function renderModule(module) {
  if (module.file.endsWith('.json')) return `module.exports = ${module.source.trim()};`;
  let source = module.source;
  for (const [request, id] of module.dependencies) {
    const escaped = request.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source = source.replace(new RegExp(`require\\((['"])${escaped}\\1\\)`, 'g'), `__require(${JSON.stringify(id)})`);
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
  if (current !== output) {
    console.error('Hermes runtime bundle is stale; run npm run hermes:build');
    process.exit(1);
  }
  console.log('Hermes runtime bundle unchanged and deterministic.');
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  console.log(`Built ${path.relative(root, outputPath)}`);
}
