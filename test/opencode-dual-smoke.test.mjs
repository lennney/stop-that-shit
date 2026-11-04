import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

function command(executable, args, options) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(executable, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 180000, ...spawnOptions });
    if (input !== undefined) child.stdin.end(input);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

for (const version of ['V1', 'V2']) {
  const executable = process.env[`STS_OPENCODE_${version}_BIN`];
  test(`packed OpenCode ${version}: review denial, continued read, restart without authorization and explicit change`, { skip: !executable, timeout: 300000 }, async (t) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `sts-${version.toLowerCase()}-`));
    if (!process.env.STS_OPENCODE_KEEP_SMOKE) t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    else t.diagnostic(`Evidence directory: ${work}`);
    const workspace = path.join(work, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'read.txt'), 'STS_READ_SUCCEEDED');
    fs.writeFileSync(path.join(workspace, 'restart-read.txt'), 'STS_RESTART_READ_SUCCEEDED');
    const dataDir = path.join(work, 'sts-data');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|AZURE_)/i.test(key)));
    for (const [key, folder] of Object.entries({ XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', HOME: 'home', USERPROFILE: 'home' })) {
      env[key] = path.join(work, folder);
      fs.mkdirSync(env[key], { recursive: true });
    }
    env.OPENCODE_TEST_HOME = env.HOME;
    env.OPENCODE_DISABLE_SHARE = '1';
    // Native hosts otherwise refresh a public catalog even with a local model.
    // Keep acceptance independent of that external service.
    env.OPENCODE_DISABLE_MODELS_FETCH = '1';
    env.OPENCODE_MODELS_PATH = path.join(work, 'models.json');
    fs.writeFileSync(env.OPENCODE_MODELS_PATH, '{}');
    if (version === 'V1') env.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
    env.STS_SMOKE_KEY = 'local-synthetic-key';
    env.NO_COLOR = '1';
    const hostVersion = await command(executable, ['--version'], { env, cwd: workspace });
    assert.equal(hostVersion.status, 0, hostVersion.stderr);
    t.diagnostic(hostVersion.stdout.trim());
    assert.match(hostVersion.stdout.trim(), version === 'V1' ? /^(?:opencode\s+)?v?1\.\d+\.\d+$/ : /^(?:opencode\s+)?v?2\.\d+\.\d+$/,
      `${version} must use its corresponding OpenCode major version`);
    const pack = await command(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: root });
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = path.join(work, JSON.parse(pack.stdout)[0].filename);
    const installRoot = path.join(work, 'installed');
    const install = await command(process.execPath, [npmCli, 'install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: work });
    assert.equal(install.status, 0, install.stderr);

    let phase = 'review', next = 0;
    const requests = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
        const body = JSON.parse(raw);
        requests.push({ phase, body });
        const hasTools = body.tools?.some((tool) => tool.function?.name === 'write');
        let call;
        if (hasTools && next < (phase === 'change' ? 1 : 2)) {
          const tool = phase !== 'change' && next === 1 ? 'read' : 'write';
          const file = tool === 'read'
            ? (phase === 'restart' ? 'restart-read.txt' : 'read.txt')
            : (phase === 'change' ? 'allowed.txt' : `${phase}-blocked.txt`);
          const args = { [version === 'V1' ? 'filePath' : 'path']: path.join(workspace, file) };
          if (tool === 'write') args.content = 'STS_CHANGE_SUCCEEDED';
          call = { index: 0, id: `smoke_${phase}_${++next}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } };
        }
        const message = call ? { role: 'assistant', tool_calls: [call] } : { role: 'assistant', content: 'STS_SMOKE_COMPLETE' };
        const finish_reason = call ? 'tool_calls' : 'stop';
        const base = { id: `chatcmpl-${requests.length}`, created: 0, model: 'smoke' };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const [delta, finish] of [[message, null], [{}, finish_reason]]) {
            res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
          }
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const packageRoot = path.join(installRoot, 'node_modules/stop-that-shit');
    const config = version === 'V1' ? {
      model: 'smoke/smoke', small_model: 'smoke/smoke', share: 'disabled', permission: { edit: 'allow' },
      plugin: [[pathToFileURL(path.join(packageRoot, 'opencode/stop-that-shit.mjs')).href, { dataDir }]],
      provider: { smoke: { npm: '@ai-sdk/openai-compatible', name: 'Local smoke', options: { baseURL, apiKey: env.STS_SMOKE_KEY }, models: { smoke: { name: 'Smoke' } } } },
    } : {
      model: 'smoke/smoke',
      plugins: [{ package: pathToFileURL(packageRoot).href, options: { dataDir } }],
      providers: { smoke: { name: 'Local smoke', env: ['STS_SMOKE_KEY'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL }, models: { smoke: { name: 'Smoke' } } } },
    };
    fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'opencode/opencode.json'), JSON.stringify(config, null, 2));
    const sessionIDs = (stdout) => stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { const id = JSON.parse(line).sessionID; return id ? [id] : []; } catch { return []; }
    });
    const run = async (prompt, sessionID) => {
      const args = ['run', '--model', 'smoke/smoke', '--format', 'json', '--print-logs'];
      // V1 resolves run's directory from PWD unless --dir is supplied; spawn's
      // cwd alone can leave the session attached to the invoking repository.
      if (version === 'V1') args.push('--dir', workspace);
      if (version === 'V2') args.push('--standalone', '--auto');
      if (sessionID) args.push('--session', sessionID);
      // OpenCode quotes positional arguments containing spaces; stdin preserves directives verbatim.
      const result = await command(executable, args, { cwd: workspace, env, input: prompt });
      fs.writeFileSync(path.join(work, `${phase}.stdout`), result.stdout);
      fs.writeFileSync(path.join(work, `${phase}.stderr`), result.stderr);
      fs.writeFileSync(path.join(work, 'model-requests.json'), JSON.stringify(requests, null, 2));
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /failed to load plugin/i, 'OpenCode must load the packed plugin before acceptance');
      if (sessionID) assert.deepEqual([...new Set(sessionIDs(result.stdout))], [sessionID],
        `${phase} must resume the original session`);
      return result;
    };
    // Match this phase's tool result, not a denial/read replayed in session history.
    const toolResults = (phaseName, index) => requests.filter((entry) => entry.phase === phaseName)
      .flatMap(({ body }) => body.messages || [])
      .filter((message) => message.role === 'tool' && message.tool_call_id === `smoke_${phaseName}_${index}`)
      .map((message) => JSON.stringify(message.content));
    const assertReview = (phaseName, result, marker) => {
      assert.equal(next, 2, `${phaseName} must attempt both a write and a subsequent read`);
      assert.ok(!fs.existsSync(path.join(workspace, `${phaseName}-blocked.txt`)), result.stdout);
      assert.ok(toolResults(phaseName, 1).some((body) => body.includes('MODE_FORBIDS_MUTATION')),
        `${phaseName}: model must receive this write's Guard denial`);
      assert.ok(toolResults(phaseName, 2).some((body) => body.includes(marker)),
        `${phaseName}: permitted read must complete after the denied write`);
    };
    const review = await run('$stop-that-shit review -- Try review-blocked.txt, then read read.txt.');
    assertReview('review', review, 'STS_READ_SUCCEEDED');
    assert.match(review.stdout, /STS_SMOKE_COMPLETE/);
    const sessionID = sessionIDs(review.stdout)[0];
    assert.ok(sessionID, 'CLI must expose the session ID for restart acceptance');
    const { statePath } = await import(pathToFileURL(path.join(packageRoot, 'src/state.cjs')).href);
    const sessionState = () => JSON.parse(fs.readFileSync(statePath(sessionID, dataDir), 'utf8'));
    const reviewContract = sessionState().contract;
    assert.equal(reviewContract.mode, 'review');
    assert.equal(reviewContract.source, 'directive');

    phase = 'restart'; next = 0;
    // No new review/change directive is submitted. A quoted mention is not
    // authorization and must not trigger the editable-host promotion path.
    const restarted = await run('Explain the quoted command "$stop-that-shit change" while checking the files.', sessionID);
    assertReview('restart', restarted, 'STS_RESTART_READ_SUCCEEDED');
    assert.match(restarted.stdout, /STS_SMOKE_COMPLETE/);
    assert.deepEqual(sessionState().contract, reviewContract, 'Restart must preserve the same session contract without new authorization');

    phase = 'change'; next = 0;
    const changed = await run('$stop-that-shit change -- Write allowed.txt.', sessionID);
    assert.equal(fs.readFileSync(path.join(workspace, 'allowed.txt'), 'utf8'), 'STS_CHANGE_SUCCEEDED');
    assert.match(changed.stdout, /STS_SMOKE_COMPLETE/);
    assert.equal(next, 1, 'Explicit change must attempt its authorized write');
    assert.equal(sessionState().contract.mode, 'change');
    assert.equal(sessionState().contract.source, 'directive');
  });
}
