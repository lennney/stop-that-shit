'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function fixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hermes-imports-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, contents) => {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  write('src/windows-job-guard.cs', '// fixture\n');
  write('src/adapters/hermes-hooks.cjs', source);
  write('src/helper.cjs', 'module.exports = { value: 41 };\n');
  write('scripts/build-hermes-plugin.cjs', fs.readFileSync(path.join(root, 'scripts/build-hermes-plugin.cjs')));
  // The generator runs from a disposable checkout with its build dependency.
  fs.cpSync(path.dirname(require.resolve('acorn/package.json')),
    path.join(directory, 'node_modules/acorn'), { recursive: true });
  const build = (...args) => spawnSync(process.execPath, ['scripts/build-hermes-plugin.cjs', ...args], {
    cwd: directory, encoding: 'utf8', timeout: 5000
  });
  const run = () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hermes-artifact-'));
    t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
    fs.copyFileSync(path.join(directory, '.hermes-plugin/runtime/stop-that-shit.cjs'),
      path.join(isolated, 'stop-that-shit.cjs'));
    // The artifact lives outside the fixture tree: neither its source nor its
    // build dependency can satisfy an accidentally unbundled import.
    const env = { ...process.env, HERMES_HOME: isolated };
    delete env.NODE_PATH;
    const result = spawnSync(process.execPath, ['stop-that-shit.cjs'], {
      cwd: isolated, input: '{}\n', encoding: 'utf8', timeout: 5000,
      env
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  return { directory, build, run };
}

for (const expression of [
  "require('../helper.cjs')",
  "require ( '../helper.cjs' )",
  "require(\n  '../helper.cjs'\n)",
  "require(/* before */ '../helper.cjs' /* after */)",
  'require("../helper.cjs")',
  'require(`../helper.cjs`)',
  "require('../hel\\u0070er.cjs')",
  "require(('../helper.cjs'))"
]) {
  test(`Hermes bundles a static import: ${JSON.stringify(expression)}`, t => {
    const f = fixture(t, `const helper = ${expression};\nexports.handleHermesHook = () => ({ value: helper.value + 1 });\n`);
    const built = f.build();
    assert.equal(built.status, 0, built.stderr);
    assert.deepEqual(f.run(), { value: 42 });
    assert.equal(f.build('--check').status, 0);
  });
}

test('Hermes ignores import-looking data but includes template-expression imports', t => {
  const source = [
    "// require('../missing-comment.cjs')",
    "/* require('../missing-block.cjs') */",
    "const text = \"require('../missing-string.cjs')\";",
    "const pattern = /require('..\\/missing-regex.cjs')/;",
    "const template = `require('../missing-template.cjs') ${require('../helper.cjs').value}`;",
    "const object = { require() { return 1; } };",
    "class Fields { require = 1; module = 2; }",
    "exports.handleHermesHook = () => ({ value: Number(template.slice(-2)) + object.require(), fields: [new Fields().require, new Fields().module] });"
  ].join('\n');
  const f = fixture(t, source);
  const built = f.build();
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(f.run(), { value: 42, fields: [1, 2] });
});

test('Hermes leaves native module imports available in a standalone artifact', t => {
  const f = fixture(t, "const path = require ( 'node:path' );\nexports.handleHermesHook = () => ({ value: path.basename('a/b') });\n");
  const built = f.build();
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(f.run(), { value: 'b' });
});

test('Hermes preserves CommonJS entrypoint checks inside bundled modules', t => {
  const f = fixture(t, "module[`exports`].handleHermesHook = () => ({ entrypoint: require.main === module, reverse: module === require['main'] });\n");
  const built = f.build();
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(f.run(), { entrypoint: false, reverse: false });
});

for (const source of [
  "const target = '../helper.cjs'; const helper = require(target);",
  "const helper = require('../' + 'helper.cjs');",
  "const target = 'helper'; const helper = require(`../${target}.cjs`);",
  "const load = require; const helper = load('../helper.cjs');",
  "function load(require) { return require('../helper.cjs'); }",
  "const file = require.resolve('../helper.cjs');",
  "const helper = module.require('../helper.cjs');",
  "const helper = module[`require`]('../helper.cjs');",
  "const { require: load } = module; const helper = load('../helper.cjs');",
  "const loader = module; const helper = loader.require('../helper.cjs');",
  "const helper = require.main.require('../helper.cjs');"
]) {
  test(`Hermes rejects unsupported import syntax before writing a bundle: ${source}`, t => {
    const f = fixture(t, source);
    const built = f.build();
    assert.equal(built.status, 1, built.stdout + built.stderr);
    assert.match(built.stderr, /Unsupported .*require/);
    assert.match(built.stderr, /src[\\/]adapters[\\/]hermes-hooks\.cjs/);
    assert.equal(fs.existsSync(path.join(f.directory, '.hermes-plugin/runtime/stop-that-shit.cjs')), false);
  });
}
