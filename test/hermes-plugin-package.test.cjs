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
const pythonCommand = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

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
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'stop-that-shit');
  assert.equal(manifest.version, packageJson.version);
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

test('native plugin registers all planned Hermes lifecycle callbacks', () => {
  const script = path.join(os.tmpdir(), `sts-plugin-register-${process.pid}.py`);
  fs.writeFileSync(script, `
import importlib.util, os
spec = importlib.util.spec_from_file_location('sts_plugin', os.environ['STS_PLUGIN_ENTRY'])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); mod.register(ctx)
assert set(ctx.hooks) == {'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'subagent_start', 'subagent_stop', 'on_session_end'}
print('registered')
`);
  const result = spawnSync(pythonCommand, [script], { encoding: 'utf8', env: pythonPluginEnv() });
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
  const result = spawnSync(pythonCommand, [script], { encoding: 'utf8', env: pythonPluginEnv(), timeout: 10000 });
  fs.rmSync(script, { force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'fail-open-ok');
});

test('native post-tool hook starts the runtime only for delegation results', () => {
  const script = `
import importlib.util, json, os
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('sts_plugin', os.environ['STS_PLUGIN_ENTRY'])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
calls = []
def run(*args, **kwargs):
    calls.append(json.loads(kwargs['input']))
    return SimpleNamespace(returncode=0, stdout='')
mod.subprocess.run = run
for tool in ['read_file', 'write_file', 'terminal', None]:
    assert mod._post_tool(tool_name=tool, result='ok', session_id='native-session') is None
assert calls == [], calls
result = {'status': 'completed', 'agent_id': 'child'}
assert mod._post_tool(tool_name='delegate_task', tool_call_id='call-1', args={'task': 'inspect'},
                      result=result, session_id='native-session', async_launched=True) is None
assert len(calls) == 1
assert calls[0]['hook_event_name'] == 'post_tool_call'
assert calls[0]['tool_call_id'] == 'call-1'
assert calls[0]['tool_input'] == {'task': 'inspect'}
assert calls[0]['extra']['result'] == result
assert calls[0]['extra']['async_launched'] is True
print('post-tool-ok')
`;
  const result = spawnSync(pythonCommand, ['-B', '-c', script], {
    encoding: 'utf8', env: pythonPluginEnv(), timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'post-tool-ok');
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
assert ctx.hooks['post_tool_call'](tool_name='read_file', args={'path': 'README.md'}, result='ok', session_id='native-session', tool_call_id='read-call', task_id='tool-task') is None
assert ctx.hooks['subagent_start'](parent_session_id='native-session', child_session_id='child-session', child_subagent_id='child-agent', task_id='child-task') is None
assert ctx.hooks['subagent_stop'](parent_session_id='native-session', child_session_id='child-session', child_status='completed', task_id='child-task') is None
assert ctx.hooks['on_session_end'](session_id='native-session', completed=True, interrupted=False) is None
print('behavior-ok')
`);
  const result = spawnSync(pythonCommand, [script], {
    encoding: 'utf8',
    env: pythonPluginEnv({ STS_TEST_HERMES_HOME: home }),
    timeout: 10000
  });
  fs.rmSync(script, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'behavior-ok');
});

test('packaged Hermes hooks preserve damaged legacy locks and enforce read-only recovery', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hermes-lock-recovery-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const copiedPlugin = path.join(temporary, 'plugin');
  fs.mkdirSync(path.join(copiedPlugin, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(pluginRoot, '__init__.py'), path.join(copiedPlugin, '__init__.py'));
  fs.copyFileSync(runtimePath, path.join(copiedPlugin, 'runtime', 'stop-that-shit.cjs'));
  const script = path.join(temporary, 'lock-recovery.py');
  fs.writeFileSync(script, `
import hashlib, importlib.util, json, os, time
from pathlib import Path
spec = importlib.util.spec_from_file_location('sts_plugin', os.environ['STS_PLUGIN_ENTRY'])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); mod.register(ctx)
for initial in ('change', 'off change'):
    session = 'damaged-lock-' + initial.replace(' ', '-')
    def prompt(text):
        return ctx.hooks['pre_llm_call'](session_id=session, user_message=text)
    def tool(name):
        return ctx.hooks['pre_tool_call'](session_id=session, tool_name=name,
            args={'path': 'scratch.txt', 'content': 'synthetic'})
    assert 'context' in prompt('$stop-that-shit ' + initial + ' -- implement')
    assert tool('write_file') is None
    assert ctx.hooks['pre_tool_call'](session_id=session, tool_name='delegate_task',
        tool_call_id='saved-delegation', args={'tasks': [{'task': 'inspect synthetic'}]}) is None
    prompt('$stop-that-shit ' + initial + ' -- continue')
    key = hashlib.sha256(session.encode()).hexdigest()[:24]
    state = Path(os.environ['HERMES_HOME']) / 'stop-that-shit' / 'sessions' / (key + '.json')
    saved = state.read_bytes()
    assert json.loads(saved)['contract']['mode'] == 'change'
    assert json.loads(saved)['delegation']['reservations']
    lock = state.with_suffix('.json.lock')
    lock.write_bytes(b'')
    old = time.time() - 60
    os.utime(lock, (old, old))
    lock_mtime = lock.stat().st_mtime_ns
    recovery = prompt('$stop-that-shit review -- inspect only')
    assert 'STS_LOCK_DAMAGED' in recovery['context'], recovery
    assert lock.name in recovery['context'], recovery
    blocked = tool('write_file')
    assert blocked is not None and blocked['action'] == 'block', blocked
    assert 'STS_LOCK_DAMAGED' in blocked['message'], blocked
    assert tool('read_file') is None
    assert state.read_bytes() == saved
    assert lock.read_bytes() == b''
    assert lock.stat().st_mtime_ns == lock_mtime
    # Every runtime process has exited. Preserve the lock as recovery evidence.
    isolated = lock.with_suffix('.lock.saved')
    lock.rename(isolated)
    assert state.read_bytes() == saved
    restored = prompt('$stop-that-shit guard review -- inspect only')
    assert 'mode=review' in restored['context'], restored
    assert 'MODE_FORBIDS_MUTATION' in tool('write_file')['message']
    assert tool('read_file') is None
    changed = prompt('$stop-that-shit guard change -- implement')
    assert 'mode=change' in changed['context'], changed
    assert tool('write_file') is None
    assert json.loads(state.read_bytes())['delegation'] == json.loads(saved)['delegation']
    assert not lock.exists()
    assert isolated.read_bytes() == b''
print('lock-recovery-ok')
`);
  const result = spawnSync(pythonCommand, [script], {
    encoding: 'utf8',
    env: pythonPluginEnv({
      STS_PLUGIN_ENTRY: path.join(copiedPlugin, '__init__.py'),
      HERMES_HOME: path.join(temporary, 'home')
    }),
    timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'lock-recovery-ok');
});
