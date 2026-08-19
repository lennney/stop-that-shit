'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pluginRoot = path.join(root, '.hermes-plugin');
const runtimePath = path.join(pluginRoot, 'runtime', 'stop-that-shit.cjs');

function pythonPluginEnv(extra = {}) {
  return {
    ...process.env,
    STS_PLUGIN_ENTRY: path.join(pluginRoot, '__init__.py'),
    ...extra
  };
}

function readManifest() {
  const manifestPath = path.join(pluginRoot, 'plugin.yaml');
  assert.ok(fs.existsSync(manifestPath), 'Hermes plugin manifest must exist');
  const text = fs.readFileSync(manifestPath, 'utf8');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*["']?([^"']*)["']?\s*$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

test('Hermes plugin skeleton has a discoverable manifest and one host entrypoint', () => {
  const manifest = readManifest();
  assert.equal(manifest.name, 'stop-that-shit');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description);
  assert.ok(fs.statSync(path.join(pluginRoot, '__init__.py')).isFile());
  assert.ok(fs.statSync(path.join(pluginRoot, 'README.md')).isFile());
  assert.equal(fs.existsSync(path.join(pluginRoot, 'hooks')), false);
});

test('Hermes plugin documents runtime boundaries without claiming every host surface', () => {
  const entrypoint = fs.readFileSync(path.join(pluginRoot, '__init__.py'), 'utf8');
  const readme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
  assert.match(entrypoint, /def register\(ctx\)/);
  assert.match(readme, /runtime/i);
  assert.match(readme, /fail-open/i);
  assert.match(readme, /Other Hermes surfaces are not claimed/i);
});

test('Hermes installation docs explain CLI and Gateway activation lifecycle', () => {
  for (const file of [
    'README.md',
    'README_EN.md',
    'INSTALL.md',
    'INSTALL_FOR_AGENTS.md',
    '.hermes-plugin/README.md'
  ]) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(contents, /hermes gateway restart/, `${file} must document the Gateway restart command`);
    assert.match(contents, /new Hermes CLI|新的 Hermes CLI/i, `${file} must document starting a new CLI process or session`);
    assert.match(contents, /not (?:required|needed) every time|不需要每次/i, `${file} must explain that restart is not required every time`);
  }
});

test('Hermes runtime is self-contained and handles an existing prompt envelope', () => {
  assert.ok(fs.statSync(runtimePath).isFile(), 'generated Hermes runtime must exist');
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hermes-runtime-'));
  const copied = path.join(tempHome, 'stop-that-shit.cjs');
  fs.copyFileSync(runtimePath, copied);
  const input = JSON.stringify({ hook_event_name: 'pre_llm_call', session_id: 'bundle-test-session', extra: { user_message: 'review this read-only task' } });
  const result = spawnSync(process.execPath, [copied], { input: `${input}\n`, encoding: 'utf8', env: { ...process.env, HERMES_HOME: tempHome } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /context/);
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('hermes:check detects a modified generated runtime', () => {
  const result = spawnSync(process.execPath, ['scripts/build-hermes-plugin.cjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unchanged|up to date|deterministic/i);
});

test('hermes:check is invariant to CRLF checkout conversion', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hermes-crlf-checkout-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, '.hermes-plugin', 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(tempRoot, 'package.json'));
  fs.copyFileSync(
    path.join(root, 'scripts', 'build-hermes-plugin.cjs'),
    path.join(tempRoot, 'scripts', 'build-hermes-plugin.cjs')
  );
  fs.copyFileSync(
    runtimePath,
    path.join(tempRoot, '.hermes-plugin', 'runtime', 'stop-that-shit.cjs')
  );

  const convertTreeToCrlf = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) convertTreeToCrlf(child);
      else fs.writeFileSync(child, fs.readFileSync(child, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
  };
  convertTreeToCrlf(path.join(tempRoot, 'src'));
  convertTreeToCrlf(path.join(tempRoot, '.hermes-plugin'));
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    fs.readFileSync(path.join(tempRoot, 'package.json'), 'utf8').replace(/\r?\n/g, '\r\n')
  );

  const result = spawnSync(process.execPath, ['scripts/build-hermes-plugin.cjs', '--check'], {
    cwd: tempRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unchanged|up to date|deterministic/i);
});

test('native plugin registers pre_llm_call and pre_tool_call callbacks', () => {
  const script = path.join(os.tmpdir(), `sts-plugin-register-${process.pid}.py`);
  fs.writeFileSync(script, `
import importlib.util, os
spec = importlib.util.spec_from_file_location('sts_plugin', os.environ['STS_PLUGIN_ENTRY'])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); mod.register(ctx)
assert set(ctx.hooks) == {'pre_llm_call', 'pre_tool_call'}
print('registered')
`);
  const result = spawnSync('python3', [script], { encoding: 'utf8', env: pythonPluginEnv() });
  fs.rmSync(script, { force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'registered');
});

test('native hook failures and timeouts fail open', () => {
  const script = path.join(os.tmpdir(), `sts-plugin-fail-open-${process.pid}.py`);
  fs.writeFileSync(script, `
import importlib.util, os
spec = importlib.util.spec_from_file_location('sts_plugin', os.environ['STS_PLUGIN_ENTRY'])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
mod._RUNTIME = mod._PLUGIN_ROOT / 'runtime' / 'missing.cjs'
assert mod._prompt(session_id='s', user_message='review') is None
assert mod._tool(tool_name='write_file', args={'path': 'x'}, session_id='s', task_id='tool-task') is None
print('fail-open-ok')
`);
  const result = spawnSync('python3', [script], { encoding: 'utf8', env: pythonPluginEnv(), timeout: 10000 });
  fs.rmSync(script, { force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fail-open-ok');
});

test('native pre_llm_call returns context and pre_tool_call returns block or no-op', () => {
  const script = path.join(os.tmpdir(), `sts-plugin-hooks-${process.pid}.py`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-plugin-home-'));
  fs.writeFileSync(script, `
import importlib.util, os
spec = importlib.util.spec_from_file_location('sts_plugin', os.environ['STS_PLUGIN_ENTRY'])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); mod.register(ctx)
os.environ['HERMES_HOME'] = os.environ['STS_TEST_HERMES_HOME']
context = ctx.hooks['pre_llm_call'](session_id='native-session', task_id='prompt-task', user_message='$stop-that-shit review -- inspect only', model='test', platform='cli')
assert isinstance(context, dict) and 'context' in context
blocked = ctx.hooks['pre_tool_call'](tool_name='write_file', args={'path': 'blocked.txt', 'content': 'x'}, session_id='native-session', task_id='tool-task')
assert blocked['action'] == 'block'
allowed = ctx.hooks['pre_tool_call'](tool_name='read_file', args={'path': 'README.md'}, session_id='native-session', task_id='tool-task')
assert allowed is None
print('behavior-ok')
`);
  const result = spawnSync('python3', [script], {
    encoding: 'utf8',
    env: pythonPluginEnv({ STS_TEST_HERMES_HOME: home }),
    timeout: 10000
  });
  fs.rmSync(script, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'behavior-ok');
});
