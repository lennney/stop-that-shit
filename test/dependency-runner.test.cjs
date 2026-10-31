'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { handleHook } = require('../src/hook-policy.cjs');
const { bindingForRecord, createHandoff, cleanupCreatedHandoffs } = require('../src/dependency-handoff.cjs');

test.after(() => cleanupCreatedHandoffs());

function attachHandoff(t, sessionId, record) {
  record.handoff = createHandoff(bindingForRecord(sessionId, record));
  t.after(() => { try { fs.unlinkSync(record.handoff.path); } catch {} });
}

test('controlled runner pins approved directory, argv and consumes ticket once', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  const entry = path.join(bin, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  const target = path.join(root, 'target');
  const other = path.join(root, 'other');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(target);
  fs.mkdirSync(other);
  fs.writeFileSync(entry, "require('node:fs').writeFileSync('receipt.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))");
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const options = { dataDir };
  const base = { session_id: 'runner-fixture', turn_id: 'turn', cwd: other };
  const prompt = text => handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const pre = (id, name, input) => handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input }, options);
  const input = { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' };
  prompt('$stop-that-shit change deps=ask -- task');
  const denied = pre('original', 'Bash', input);
  const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
  assert.ok(match);
  const question = match[1].replace('<absolute canonical directory>', fs.realpathSync(target));
  assert.equal(pre('question', 'request_user_input_async', { questions: [{ title: question, options: [match[2], match[3]] }] }), null);
  const reply = [{ questionItemId: JSON.stringify(['request_user_input_async', 'question', 0]), question, answer: match[2] }];
  prompt(`<send_user_message_question_reply>\n${JSON.stringify(reply)}\n</send_user_message_question_reply>`);
  const issued = pre('retry', 'Bash', input);
  assert.equal(issued.hookSpecificOutput.permissionDecision, 'allow');
  const bootstrap = issued.hookSpecificOutput.updatedInput.command;
  const duplicate = pre('duplicate', 'Bash', input);
  assert.equal(duplicate.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(duplicate.hookSpecificOutput.updatedInput.command, bootstrap);
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-Command', bootstrap] : ['-c', bootstrap];
  const first = spawnSync(shell, shellArgs, { cwd: other, env: { ...process.env, PLUGIN_DATA: dataDir }, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(target, 'receipt.json'), 'utf8'));
  assert.equal(fs.realpathSync(receipt.cwd), fs.realpathSync(target));
  assert.deepEqual(receipt.args, ['install', '--offline', '--frozen-lockfile', '--ignore-scripts']);
  assert.equal(fs.existsSync(path.join(other, 'receipt.json')), false);
  const replay = spawnSync(shell, shellArgs, { cwd: other, env: { ...process.env, PLUGIN_DATA: dataDir }, encoding: 'utf8' });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /unavailable|expired/);
});

test('new runner consumes a version-1 root handoff encoded with the d0 payload shape', t => {
  const { fingerprint } = require('../src/dependency-manager.cjs');
  const { freshState, writeState, readState } = require('../src/state.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-legacy-root-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.realpathSync(root);
  const managerEntry = path.join(root, 'manager.cjs');
  const marker = path.join(root, 'manager-ran');
  fs.writeFileSync(managerEntry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
  const manager = { kind: 'node', entry: fingerprint(managerEntry), executable: fingerprint(process.execPath) };
  const sessionId = 'legacy-root-handoff';
  const ticket = 'c'.repeat(64);
  const eventId = 'evt_00000000-0000-0000-0000-000000000000';
  const actionDigest = 'a'.repeat(64);
  const binding = { version: 1, sessionId, eventId, ticket, actionDigest,
    argv: ['pnpm', 'install'], targetCwd: cwd, manager };
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const bytes = Buffer.from(JSON.stringify(canonical(binding)), 'utf8');
  const tempRoot = path.join(fs.realpathSync(os.tmpdir()), 'stop-that-shit-handoffs');
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const handoffPath = path.join(tempRoot, `.sts-dependency-${'b'.repeat(64)}.handoff`);
  fs.writeFileSync(handoffPath, bytes, { flag: 'wx', mode: 0o600 });
  t.after(() => { try { fs.unlinkSync(handoffPath); } catch {} });
  const fd = fs.openSync(handoffPath, 'r');
  const stat = fs.fstatSync(fd, { bigint: true });
  fs.closeSync(fd);
  const handoff = { version: 1, path: handoffPath, tempRoot,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    identity: { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() } };
  const state = freshState();
  state.contract = { ...state.contract, mode: 'change', level: 'guard', dependencyPolicy: 'ask' };
  state.actionApproval = { digest: actionDigest, eventId, questionPrefix: 'prefix', question: 'question',
    questionId: 'id', questionCallId: 'q', deniedActionId: 'a', expires: Date.now() + 30000,
    proposalExpires: Date.now() + 30000, status: 'issued', requestedCwd: cwd, targetCwd: cwd,
    ticket, argv: binding.argv, manager, approvedAction: { mutability: 'write', hashIntent: false,
      affectedPaths: [], cwd }, handoff };
  writeState(sessionId, state, root);

  const runner = path.join(__dirname, '../src/dependency-runner.cjs');
  const first = spawnSync(process.execPath, [runner, sessionId, root, ticket], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  assert.equal(readState(sessionId, root).actionApproval.status, 'issued');
  const replay = spawnSync(process.execPath, [runner, sessionId, root, ticket], { encoding: 'utf8' });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /already consumed|unavailable|expired/i);
});

test('approved retry does not resolve its Node bootstrap through PATH', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sts-node-path-'子' "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shimBin = path.join(root, 'shim bin');
  const managerBin = path.join(root, 'manager bin');
  const managerEntry = path.join(managerBin, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  const fakeNode = path.join(shimBin, process.platform === 'win32' ? 'node.exe' : 'node');
  const fakePowerShell = path.join(shimBin, 'powershell.exe');
  const preload = path.join(root, 'path-hit.cjs');
  const marker = path.join(root, 'path-hit');
  fs.mkdirSync(path.dirname(managerEntry), { recursive: true });
  fs.mkdirSync(shimBin, { recursive: true });
  fs.copyFileSync(process.execPath, fakeNode);
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, fakePowerShell);
  if (process.platform !== 'win32') fs.chmodSync(fakeNode, 0o755);
  fs.writeFileSync(managerEntry, 'process.exitCode = 0;');
  fs.writeFileSync(preload, `if ((process.execPath === ${JSON.stringify(fakeNode)} && process.argv[1] === ${JSON.stringify(Buffer.from(path.resolve(__dirname, '../src/dependency-runner.cjs')).toString('base64'))}) || (process.execPath === ${JSON.stringify(fakePowerShell)} && process.argv[1] === '-NoLogo')) require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.execPath);`);

  const previousPath = process.env.PATH;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.PATH = [shimBin, managerBin, previousPath].filter(Boolean).join(path.delimiter);
  process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  });

  const shells = process.platform === 'win32'
    ? [
      [path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-Command']],
      [path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'cmd.exe'), ['/d', '/s', '/c']]
    ]
    : [['/bin/sh', ['-c']]];
  const target = path.join(root, "approved dir '非ASCII'");
  fs.mkdirSync(target);
  const input = { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' };
  for (const [index, [shell, prefixArgs]] of shells.entries()) {
    const dataDir = path.join(root, `state-${index}`);
    const options = { dataDir };
    const base = { session_id: `node-path-${index}`, turn_id: 'turn', cwd: root };
    const prompt = text => handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: text }, options);
    const pre = (id, name, toolInput) => handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: toolInput }, options);
    prompt('$stop-that-shit change deps=ask -- task');
    const denied = pre('original', 'Bash', input);
    const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
    assert.ok(match);
    const question = match[1].replace('<absolute canonical directory>', fs.realpathSync(target));
    assert.equal(pre('question', 'request_user_input_async', { questions: [{ title: question, options: [match[2], match[3]] }] }), null);
    prompt(`<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'question', 0]), question, answer: match[2] }])}\n</send_user_message_question_reply>`);
    const issued = pre('retry', 'Bash', input);
    assert.equal(issued.hookSpecificOutput.permissionDecision, 'allow');

    const command = issued.hookSpecificOutput.updatedInput.command;
    const shellArgs = [...prefixArgs, command];
    const result = spawnSync(shell, shellArgs, { cwd: root, env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.equal(fs.existsSync(marker), false, `${shell} must not execute the first PATH node shim`);
  }
});

test('runner launcher preserves paths with spaces, apostrophes and non-ASCII characters', t => {
  const { buildRunnerCommand, resolveWindowsPowerShell } = require('../src/runner-command.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sts-launcher-'非ASCII' "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, `Node '启动'${process.platform === 'win32' ? '.exe' : ''}`);
  const runnerPath = path.join(root, "runner '入口' 子.cjs");
  const dataDir = path.join(root, "批准 '目录' 子");
  const exitDataDir = path.join(root, 'exit-data');
  fs.copyFileSync(process.execPath, executable);
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(exitDataDir);
  fs.writeFileSync(runnerPath, `module.exports.run = (session, directory, ticket) => { require('node:fs').writeFileSync(require('node:path').join(directory, 'receipt.json'), JSON.stringify({session,directory,ticket})); process.exitCode = session.endsWith('exit23') ? 23 : 0; };`);

  const command = buildRunnerCommand({ executable, runnerPath, sessionId: "session '子", dataDir, ticket: 'a'.repeat(64) });
  const shells = process.platform === 'win32'
    ? [['powershell.exe', ['-NoProfile', '-Command']], ['cmd.exe', ['/d', '/s', '/c']]]
    : [['/bin/sh', ['-c']]];
  for (const [shell, prefixArgs] of shells) {
    const commandForShell = shell === 'powershell.exe' ? `${command}; [Console]::Out.WriteLine($LASTEXITCODE)` : command;
    const result = spawnSync(shell, [...prefixArgs, commandForShell], { cwd: root, env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    const failingCommand = buildRunnerCommand({ executable, runnerPath, sessionId: "session 'exit23", dataDir: exitDataDir, ticket: 'b'.repeat(64) });
    const failingCommandForShell = shell === 'powershell.exe' ? `${failingCommand}; [Console]::Out.WriteLine($LASTEXITCODE)` : failingCommand;
    const failed = spawnSync(shell, [...prefixArgs, failingCommandForShell], { cwd: root, env: process.env, encoding: 'utf8' });
    if (shell === 'powershell.exe') assert.match(failed.stdout.trim(), /23$/, 'PowerShell must expose the runner exit code in LASTEXITCODE');
    else assert.equal(failed.status, 23, `${shell} must preserve the runner's exit status: ${failed.stderr}`);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(dataDir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.session, "session '子");
  assert.equal(receipt.directory, dataDir);
  assert.equal(receipt.ticket, 'a'.repeat(64));

  const systemRootWithSpaces = 'C:\\Program Files\\Windows Root';
  const fullPowerShell = `${systemRootWithSpaces}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const shortPowerShell = 'C:\\PROGRA~1\\WINDOW~1\\SYSTEM32\\WINDOW~1\\V1.0\\POWERS~1.EXE';
  const pathMap = new Map([[systemRootWithSpaces, systemRootWithSpaces], [fullPowerShell, fullPowerShell], [shortPowerShell, fullPowerShell]]);
  const fsApi = {
    realpathSync(value) {
      if (!pathMap.has(value)) throw new Error('not found');
      return pathMap.get(value);
    },
    statSync(value) { return { isFile: () => value === fullPowerShell }; }
  };
  assert.equal(resolveWindowsPowerShell({ systemRoot: systemRootWithSpaces, fsApi, shortPath: () => shortPowerShell }), shortPowerShell);
  assert.throws(() => resolveWindowsPowerShell({ systemRoot: systemRootWithSpaces, fsApi, shortPath: () => fullPowerShell }), /no usable short path/i);
  if (process.platform === 'win32') {
    const launcher = resolveWindowsPowerShell({ shortPath: () => { throw new Error('standard path must not request a short path'); } });
    assert.match(launcher, /^[A-Za-z]:\\/);
  }
});

test('Windows runner wrapper termination stops its owned grandchild tree', async t => {
  if (process.platform !== 'win32') return t.skip('Windows Job Object behavior');
  const { buildRunnerCommand } = require('../src/runner-command.cjs');
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-job-cancel-'));
  const ownedPids = [];
  let wrapper;
  let wrapperExit = null;
  let wrapperSpawnError = null;
  const wrapperStderr = [];
  const maxWrapperStderrBytes = 4096;
  let resolveWrapperClosed;
  const wrapperClosed = new Promise(resolve => { resolveWrapperClosed = resolve; });
  const closeWrapper = async () => {
    if (!wrapper) return;
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill();
    let timeout;
    const exit = await Promise.race([
      wrapperClosed.then(value => { clearTimeout(timeout); return value; }),
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), 5000); })
    ]);
    if (!exit) throw new Error('timed out waiting for owned Windows wrapper to close');
    return exit;
  };
  const isProcessAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
  };
  t.after(async () => {
    // Always close the exact wrapper spawned by this test. This also closes its
    // non-inheritable Job Object handle so the owned runner tree cannot leak.
    let closeError;
    try { await closeWrapper(); } catch (error) { closeError = error; }
    fs.writeFileSync(path.join(root, 'cleanup'), 'stop');
    const deadline = Date.now() + 5000;
    while (ownedPids.some(isProcessAlive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(root, { recursive: true, force: true });
    if (closeError) throw closeError;
  });
  const runnerPath = path.join(root, 'runner.cjs');
  const heartbeat = path.join(root, 'grandchild-heartbeat');
  const cleanup = path.join(root, 'cleanup');
  const grandchildSource = `
    const fs = require('node:fs');
    const heartbeat = process.argv[1];
    const cleanup = process.argv[2];
    let count = 0;
    const timer = setInterval(() => {
      if (fs.existsSync(cleanup)) { clearInterval(timer); process.exit(0); }
      fs.writeFileSync(heartbeat, String(++count));
    }, 50);
  `;
  fs.writeFileSync(runnerPath, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    module.exports.run = () => {
      fs.writeFileSync(${JSON.stringify(path.join(root, 'runner-pid'))}, String(process.pid));
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}, ${JSON.stringify(heartbeat)}, ${JSON.stringify(cleanup)}], { windowsHide: true, stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(path.join(root, 'grandchild-pid'))}, String(grandchild.pid));
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(cleanup)})) { clearInterval(timer); process.exit(0); }
      }, 50);
    };
  `);
  const command = buildRunnerCommand({ executable: process.execPath, runnerPath,
    sessionId: 'job-cancel-test', dataDir: root, ticket: 'e'.repeat(64) });
  const match = /^(\S+) -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.ok(match, 'expected the generated Windows PowerShell wrapper');
  wrapper = spawn(match[1], ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', match[2]], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  });
  wrapper.on('error', error => { wrapperSpawnError = error.message; });
  let wrapperStderrBytes = 0;
  wrapper.stderr.on('data', chunk => {
    wrapperStderr.push(chunk);
    wrapperStderrBytes += chunk.length;
    while (wrapperStderrBytes > maxWrapperStderrBytes) {
      const first = wrapperStderr[0];
      const excess = wrapperStderrBytes - maxWrapperStderrBytes;
      if (first.length <= excess) {
        wrapperStderr.shift();
        wrapperStderrBytes -= first.length;
      } else {
        wrapperStderr[0] = first.subarray(excess);
        wrapperStderrBytes -= excess;
      }
    }
  });
  wrapper.once('close', (code, signal) => {
    wrapperExit = { code, signal };
    resolveWrapperClosed(wrapperExit);
  });
  const waitForFile = async file => {
    for (let i = 0; i < 300; i++) {
      if (fs.existsSync(file)) return;
      if (wrapperSpawnError) throw new Error(`wrapper failed to spawn: ${wrapperSpawnError}`);
      if (wrapperExit) {
        const stderr = Buffer.concat(wrapperStderr).toString('utf8').trim().slice(-2000);
        throw new Error(`wrapper exited before ${path.basename(file)} (code=${wrapperExit.code}, signal=${wrapperExit.signal})${stderr ? `; stderr=${stderr}` : ''}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const stderr = Buffer.concat(wrapperStderr).toString('utf8').trim().slice(-2000);
    assert.fail(`timed out waiting for ${path.basename(file)} (wrapper still running; code=${wrapper.exitCode}, signal=${wrapper.signalCode})${stderr ? `; stderr=${stderr}` : ''}`);
  };
  await waitForFile(path.join(root, 'runner-pid'));
  const runnerPid = Number(fs.readFileSync(path.join(root, 'runner-pid'), 'utf8'));
  ownedPids.push(runnerPid);
  await waitForFile(path.join(root, 'grandchild-pid'));
  const grandchildPid = Number(fs.readFileSync(path.join(root, 'grandchild-pid'), 'utf8'));
  ownedPids.push(grandchildPid);
  await waitForFile(heartbeat);
  wrapper.kill();
  await closeWrapper();
  const deadline = Date.now() + 5000;
  while (ownedPids.some(isProcessAlive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(isProcessAlive(runnerPid), false, 'runner process remained alive after wrapper termination');
  assert.equal(isProcessAlive(grandchildPid), false, 'grandchild process remained alive after wrapper termination');
  const before = fs.readFileSync(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 500));
  const after = fs.readFileSync(heartbeat, 'utf8');
  assert.equal(after, before, 'grandchild continued writing after wrapper termination');
});

test('Windows runner fails closed when process-tree containment cannot attach', async t => {
  if (process.platform !== 'win32') return t.skip('Windows Job Object behavior');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-job-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const isolatedSource = path.join(root, 'src');
  fs.mkdirSync(isolatedSource);
  const commandBuilderPath = path.join(isolatedSource, 'runner-command.cjs');
  const commandBuilder = fs.readFileSync(path.join(__dirname, '../src/runner-command.cjs'), 'utf8');
  const failedAttachSource = 'using System; public static class StssRunnerJob { public static bool AttachCurrentProcess() { return false; } }';
  const failedAttachPath = path.join(isolatedSource, 'windows-job-guard.cs');
  fs.writeFileSync(failedAttachPath, failedAttachSource);
  fs.writeFileSync(commandBuilderPath, commandBuilder);
  const marker = path.join(root, 'runner-started');
  const runnerPath = path.join(root, 'runner.cjs');
  fs.writeFileSync(runnerPath, `module.exports.run = () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
  const { buildRunnerCommand } = require(commandBuilderPath);
  const command = buildRunnerCommand({ executable: process.execPath, runnerPath,
    sessionId: 'job-fail-test', dataDir: root, ticket: 'f'.repeat(64) });
  const match = /^(\S+) -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.ok(match, 'expected the generated Windows PowerShell wrapper');
  const result = spawnSync(match[1], ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', match[2]], {
    encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /process-tree containment is unavailable/i);
  assert.equal(fs.existsSync(marker), false, 'runner started despite failed job assignment');
});

test('Windows wrapper preserves runner exit status and closes its job on normal completion', async t => {
  if (process.platform !== 'win32') return t.skip('Windows Job Object behavior');
  const { buildRunnerCommand } = require('../src/runner-command.cjs');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-job-exit-'));
  let grandchildPid = 0;
  const cleanup = path.join(root, 'cleanup');
  const pidPath = path.join(root, 'grandchild-pid');
  const heartbeat = path.join(root, 'heartbeat');
  const ready = path.join(root, 'ready');
  const isProcessAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
  };
  t.after(async () => {
    fs.writeFileSync(cleanup, 'stop');
    const deadline = Date.now() + 5000;
    while (grandchildPid && isProcessAlive(grandchildPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const grandchildSource = `
    const fs = require('node:fs');
    const [ready, heartbeat, cleanup] = process.argv.slice(1);
    fs.writeFileSync(ready, 'ready');
    let count = 0;
    const timer = setInterval(() => {
      if (fs.existsSync(cleanup)) { clearInterval(timer); process.exit(0); }
      fs.writeFileSync(heartbeat, String(++count));
    }, 50);
  `;
  const managerPath = path.join(root, 'manager.cjs');
  fs.writeFileSync(managerPath, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}, ${JSON.stringify(ready)}, ${JSON.stringify(heartbeat)}, ${JSON.stringify(cleanup)}], { windowsHide: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    child.unref();
    const poll = setInterval(() => {
      if (require('node:fs').existsSync(${JSON.stringify(ready)})) { clearInterval(poll); process.exit(23); }
    }, 20);
  `);
  const runnerPath = path.join(root, 'runner.cjs');
  fs.writeFileSync(runnerPath, `
    const { spawn } = require('node:child_process');
    module.exports.run = () => {
      const manager = spawn(process.execPath, [${JSON.stringify(managerPath)}], { windowsHide: true, stdio: 'ignore' });
      manager.once('exit', code => { process.exitCode = Number.isInteger(code) ? code : 1; });
    };
  `);
  const command = buildRunnerCommand({ executable: process.execPath, runnerPath,
    sessionId: 'job-normal-exit-test', dataDir: root, ticket: 'a'.repeat(64) });
  const match = /^(\S+) -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.ok(match, 'expected the generated Windows PowerShell wrapper');
  const result = spawnSync(match[1], ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', match[2]], {
    encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  if (fs.existsSync(pidPath)) grandchildPid = Number(fs.readFileSync(pidPath, 'utf8'));
  assert.equal(result.status, 23, result.stderr);
  assert.ok(fs.existsSync(ready), 'grandchild did not start before the manager exited');
  const deadline = Date.now() + 5000;
  while (isProcessAlive(grandchildPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(isProcessAlive(grandchildPid), false, 'grandchild remained after normal wrapper completion');
});

test('runner rejects an executable changed after approval without starting it', t => {
  const { fingerprint } = require('../src/dependency-manager.cjs');
  const { freshState, writeState } = require('../src/state.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-manager-change-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.realpathSync(root);
  const entry = path.join(root, 'manager.cjs');
  const marker = path.join(root, 'marker');
  fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'run')`);
  const manager = { kind: 'node', entry: fingerprint(entry), executable: fingerprint(process.execPath) };
  const state = freshState();
  state.contract = { ...state.contract, mode: 'change', level: 'guard', dependencyPolicy: 'ask' };
  state.actionApproval = { digest: 'a'.repeat(64), eventId: 'evt_00000000-0000-0000-0000-000000000000',
    questionPrefix: 'prefix', question: 'question', questionId: 'id', questionCallId: 'q', deniedActionId: 'a',
    expires: Date.now() + 30000, proposalExpires: Date.now() + 30000, status: 'issued', requestedCwd: cwd, targetCwd: cwd, ticket: 'a'.repeat(64), argv: ['pnpm', 'install'], manager, approvedAction: { mutability: 'write', hashIntent: false, affectedPaths: [], cwd } };
  attachHandoff(t, 'changed', state.actionApproval);
  writeState('changed', state, root);
  fs.appendFileSync(entry, '\n// changed');
  const result = spawnSync(process.execPath, [path.join(__dirname, '../src/dependency-runner.cjs'), 'changed', root, 'a'.repeat(64)], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package manager changed/);
  assert.equal(fs.existsSync(marker), false);
});

test('runner claims its writable handoff once without trying to write the private store', t => {
  const { fingerprint } = require('../src/dependency-manager.cjs');
  const { freshState, writeState } = require('../src/state.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'manager.cjs');
  fs.writeFileSync(entry, 'process.exitCode = 23;');
  fs.writeFileSync(path.join(root, 'runtime'), 'not a directory');
  const state = freshState();
  state.contract = { ...state.contract, mode: 'change', level: 'guard', dependencyPolicy: 'ask' };
  state.actionApproval = { digest: 'a'.repeat(64), eventId: 'evt_00000000-0000-0000-0000-000000000000',
    questionPrefix: 'prefix', question: 'question', questionId: 'id', questionCallId: 'q', deniedActionId: 'a',
    expires: Date.now() + 30000, proposalExpires: Date.now() + 30000, status: 'issued', requestedCwd: fs.realpathSync(root), targetCwd: fs.realpathSync(root), ticket: 'b'.repeat(64),
    argv: ['pnpm', 'install'], manager: { kind: 'node', entry: fingerprint(entry), executable: fingerprint(process.execPath) },
    approvedAction: { mutability: 'write', hashIntent: false, affectedPaths: [], cwd: fs.realpathSync(root) } };
  attachHandoff(t, 'exit-test', state.actionApproval);
  writeState('exit-test', state, root);
  const args = [path.join(__dirname, '../src/dependency-runner.cjs'), 'exit-test', root, 'b'.repeat(64)];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 23);
  assert.equal(first.stderr, '');
  assert.equal(fs.existsSync(state.actionApproval.handoff.path), false);
  assert.equal(require('../src/state.cjs').readState('exit-test', root).actionApproval.status, 'issued');
  const replay = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /unavailable|expired/);
});

test('two runner processes can consume the same issued handoff but only one launches the manager', async t => {
  const { fingerprint } = require('../src/dependency-manager.cjs');
  const { freshState, readState, writeState } = require('../src/state.cjs');
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-handoff-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'manager.cjs');
  const marker = path.join(root, 'manager-runs');
  fs.writeFileSync(entry, `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x')`);
  const cwd = fs.realpathSync(root);
  const state = freshState();
  state.contract = { ...state.contract, mode: 'change', level: 'guard', dependencyPolicy: 'ask' };
  state.actionApproval = { digest: '9'.repeat(64), eventId: 'evt_00000000-0000-0000-0000-000000000000',
    questionPrefix: 'prefix', question: 'question', questionId: 'id', questionCallId: 'q', deniedActionId: 'a',
    expires: Date.now() + 30000, proposalExpires: Date.now() + 30000, status: 'issued', requestedCwd: cwd, targetCwd: cwd,
    ticket: '8'.repeat(64), argv: ['pnpm', 'install'],
    manager: { kind: 'node', entry: fingerprint(entry), executable: fingerprint(process.execPath) },
    approvedAction: { mutability: 'write', hashIntent: false, affectedPaths: [], cwd } };
  attachHandoff(t, 'handoff-race', state.actionApproval);
  writeState('handoff-race', state, root);
  const runner = path.join(__dirname, '../src/dependency-runner.cjs');
  const children = [0, 1].map(() => spawn(process.execPath, [runner, 'handoff-race', root, '8'.repeat(64)], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const results = await Promise.all(children.map(child => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  })));
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => result.code !== 0).length, 1, JSON.stringify(results));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
  assert.equal(readState('handoff-race', root).actionApproval.status, 'issued');
  assert.equal(fs.existsSync(state.actionApproval.handoff.path), false);
});

test('runner claim waits for a coordinated contract update and rechecks the latest policy', async t => {
  const { fingerprint } = require('../src/dependency-manager.cjs');
  const { freshState, readState, writeState } = require('../src/state.cjs');
  const { withCoordinationLock } = require('../src/dependency-handoff.cjs');
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-policy-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'manager.cjs');
  const marker = path.join(root, 'manager-runs');
  fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
  const cwd = fs.realpathSync(root);
  const state = freshState();
  state.contract = { ...state.contract, mode: 'change', level: 'guard', dependencyPolicy: 'ask' };
  state.actionApproval = { digest: '6'.repeat(64), eventId: 'evt_00000000-0000-0000-0000-000000000000',
    questionPrefix: 'prefix', question: 'question', questionId: 'id', questionCallId: 'q', deniedActionId: 'a',
    expires: Date.now() + 30000, proposalExpires: Date.now() + 30000, status: 'issued', requestedCwd: cwd, targetCwd: cwd,
    ticket: '7'.repeat(64), argv: ['pnpm', 'install'],
    manager: { kind: 'node', entry: fingerprint(entry), executable: fingerprint(process.execPath) },
    approvedAction: { mutability: 'write', hashIntent: false, affectedPaths: [], cwd } };
  attachHandoff(t, 'policy-race', state.actionApproval);
  writeState('policy-race', state, root);
  const runner = path.join(__dirname, '../src/dependency-runner.cjs');
  let child;
  withCoordinationLock('policy-race', root, () => {
    child = spawn(process.execPath, [runner, 'policy-race', root, '7'.repeat(64)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const current = readState('policy-race', root);
    current.contract = { ...current.contract, dependencyPolicy: 'deny' };
    writeState('policy-race', current, root);
  });
  const result = await new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unavailable|no longer satisfies current policy/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(readState('policy-race', root).actionApproval.status, 'issued');
});

test('a failed native executable launch consumes the ticket and reports an error', t => {
  const { fingerprint } = require('../src/dependency-manager.cjs');
  const { freshState, writeState } = require('../src/state.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runner-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'invalid.exe');
  fs.writeFileSync(entry, 'not an executable');
  const state = freshState();
  state.contract = { ...state.contract, mode: 'change', level: 'guard', dependencyPolicy: 'ask' };
  state.actionApproval = { digest: 'a'.repeat(64), eventId: 'evt_00000000-0000-0000-0000-000000000000',
    questionPrefix: 'prefix', question: 'question', questionId: 'id', questionCallId: 'q', deniedActionId: 'a',
    expires: Date.now() + 30000, proposalExpires: Date.now() + 30000, status: 'issued', requestedCwd: fs.realpathSync(root), targetCwd: fs.realpathSync(root), ticket: 'c'.repeat(64),
    argv: ['pnpm', 'install'], manager: { kind: 'native', entry: fingerprint(entry), launchPath: entry },
    approvedAction: { mutability: 'write', hashIntent: false, affectedPaths: [], cwd: fs.realpathSync(root) } };
  attachHandoff(t, 'error-test', state.actionApproval);
  writeState('error-test', state, root);
  const args = [path.join(__dirname, '../src/dependency-runner.cjs'), 'error-test', root, 'c'.repeat(64)];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /controlled dependency operation failed/);
  const replay = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /unavailable|expired/);
});

test('runner rechecks tightened file and hash gates before consuming a ticket', t => {
  const { fingerprint } = require('../src/dependency-manager.cjs');
  const { freshState, readState, writeState } = require('../src/state.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-tightened-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'manager.cjs');
  const marker = path.join(root, 'marker');
  fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'run')`);
  const manager = { kind: 'node', entry: fingerprint(entry), executable: fingerprint(process.execPath) };
  for (const [session, contractChange] of [['files', { allowedPaths: ['src/**'], hashPolicy: 'allow' }], ['hash', { allowedPaths: null, hashPolicy: 'deny' }]]) {
    const state = freshState();
    state.contract = { ...state.contract, mode: 'change', level: 'guard', dependencyPolicy: 'ask', ...contractChange };
    state.actionApproval = { digest: 'a'.repeat(64), eventId: 'evt_00000000-0000-0000-0000-000000000000',
      questionPrefix: 'prefix', question: 'question', questionId: 'id', questionCallId: 'q', deniedActionId: 'a',
      expires: Date.now() + 30000, proposalExpires: Date.now() + 30000, status: 'issued', requestedCwd: fs.realpathSync(root), targetCwd: fs.realpathSync(root), ticket: 'd'.repeat(64),
      argv: ['pnpm', 'install'], manager, approvedAction: { mutability: 'write', hashIntent: true, affectedPaths: [], cwd: fs.realpathSync(root) } };
    attachHandoff(t, session, state.actionApproval);
    writeState(session, state, root);
    const result = spawnSync(process.execPath, [path.join(__dirname, '../src/dependency-runner.cjs'), session, root, 'd'.repeat(64)], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, session);
    assert.equal(readState(session, root).actionApproval.status, 'issued', session);
    assert.equal(fs.existsSync(marker), false, session);
  }
});
