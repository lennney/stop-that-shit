'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

// The fake LLM runs inside this test process, so the opencode child must run
// asynchronously: spawnSync would freeze the event loop and deadlock the
// in-process HTTP server.
function runOpencode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('opencode', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ error, status: null, stdout, stderr }));
    child.on('close', (status, signal) => resolve({ error: null, status, signal, stdout, stderr }));
  });
}

const versionProbe = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 30000 });
const hasOpencode = !versionProbe.error && versionProbe.status === 0;

test('installed OpenCode plugin denies a write under a review contract', { skip: !hasOpencode, timeout: 300000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-opencode-smoke-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const workspace = path.join(work, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  const blockedPath = path.join(workspace, 'blocked.txt');
  const configDir = path.join(work, 'config');
  const dataDir = path.join(work, 'data');
  const cacheDir = path.join(work, 'cache');
  fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true });

  // Deterministic OpenAI-compatible stand-in. It asks for exactly one `write`
  // tool call when the driving prompt asks to create the blocked file, then
  // stops. No paid model is contacted.
  const llm = await startFakeLlm(t, { blockedPath });

  // Pack the repository so the test exercises the same package shape that
  // `opencode plugin github:lennney/stop-that-shit -g` installs.
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const packed = JSON.parse(pack.stdout);
  const tarball = path.join(work, Object.values(packed)[0].filename);

  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'smoke/smoke',
    small_model: 'smoke/smoke',
    provider: {
      smoke: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Smoke Provider',
        options: {
          baseURL: `http://127.0.0.1:${llm.port}/v1`,
          apiKey: process.env.STS_TEST_PROVIDER_KEY || ''
        },
        models: { smoke: { name: 'Smoke Model' } }
      }
    },
    permission: { edit: 'allow' }
  };
  fs.writeFileSync(path.join(configDir, 'opencode', 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`);

  const env = { ...process.env };
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  Object.assign(env, {
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_STATE_HOME: dataDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    NO_COLOR: '1'
  });

  const install = await runOpencode(['plugin', `file:${tarball}`, '-g'], { env });
  assert.equal(install.status, 0, `plugin install failed:\n${install.stdout}\n${install.stderr}`);

  const run = await runOpencode([
    'run',
    '--dir', workspace,
    '--print-logs',
    '$stop-that-shit review -- Create blocked.txt with content denied.'
  ], { env });
  const combined = `${run.stdout}\n${run.stderr}`;

  assert.ok(llm.requests.length >= 1, `the fake model received no request:\n${combined}`);
  assert.ok(
    !fs.existsSync(blockedPath),
    `review contract must deny the write, but ${blockedPath} exists:\n${combined}`
  );

  const sessionsDir = path.join(dataDir, 'opencode', 'stop-that-shit', 'sessions');
  const stateFiles = fs.existsSync(sessionsDir)
    ? fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'))
    : [];
  assert.ok(stateFiles.length >= 1, `plugin must persist session state:\n${combined}`);
  const persisted = JSON.parse(fs.readFileSync(path.join(sessionsDir, stateFiles[0]), 'utf8'));
  assert.equal(persisted.contract.mode, 'review', `session state must persist the review contract:\n${combined}`);
});

function startFakeLlm(t, { blockedPath }) {
  const requests = [];
  let toolCallsServed = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {}
        requests.push(body);
        const streaming = body && body.stream === true;
        const text = JSON.stringify(body && body.messages || '');
        if (text.includes('Create blocked.txt') && toolCallsServed < 1) {
          toolCallsServed += 1;
          sendToolCall(res, streaming, blockedPath);
          return;
        }
        sendStop(res, streaming);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ port, requests });
    });
  });
}

function sendToolCall(res, streaming, blockedPath) {
  const toolCall = {
    index: 0,
    id: 'call_smoke_1',
    type: 'function',
    function: { name: 'write', arguments: JSON.stringify({ filePath: blockedPath, content: 'denied' }) }
  };
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'smoke',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null }]
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'smoke',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'smoke',
    choices: [{ index: 0, message: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }]
  }));
}

function sendStop(res, streaming) {
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-2', object: 'chat.completion.chunk', created: 0, model: 'smoke',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Blocked.' }, finish_reason: null }]
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-2', object: 'chat.completion.chunk', created: 0, model: 'smoke',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-2', object: 'chat.completion', created: 0, model: 'smoke',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Blocked.' }, finish_reason: 'stop' }]
  }));
}
