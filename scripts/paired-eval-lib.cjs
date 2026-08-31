'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { caseBundleDigest, loadCaseBundles } = require('./case-bundle-lib.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');

const ARMS = [
  { id: 'baseline', pluginEnabled: false, hooksEnabled: false, instructions: false, invocationMode: 'direct-task' },
  { id: 'instruction', pluginEnabled: false, hooksEnabled: false, instructions: true, invocationMode: 'direct-instruction' },
  { id: 'plugin', pluginEnabled: true, hooksEnabled: true, instructions: false, invocationMode: 'explicit-skill' }
];

function skillBody(skill, label = 'Stop That Shit Skill') {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(skill);
  if (!match) throw new Error(`${label} frontmatter is invalid`);
  return match[1].trim();
}

function loadInstructionControl(root = path.resolve(__dirname, '..')) {
  const skill = fs.readFileSync(path.join(root, 'skills', 'stop-that-shit', 'SKILL.md'), 'utf8');
  return skillBody(skill);
}

function digestText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const INSTRUCTION_CONTROL = loadInstructionControl();
ARMS[1].skillRef = 'worktree:skills/stop-that-shit/SKILL.md';
ARMS[1].skillDigest = digestText(INSTRUCTION_CONTROL);
ARMS[1].instructionText = INSTRUCTION_CONTROL;
ARMS[2].skillRef = 'worktree:skills/stop-that-shit/SKILL.md';
ARMS[2].skillDigest = digestText(INSTRUCTION_CONTROL);

const AGENT_INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md'];
const PLUGIN_RUNTIME_PATHS = ['package.json', '.codex-plugin', 'hooks', 'skills/stop-that-shit', 'src'];
const ARM_IDS = new Set(ARMS.map((arm) => arm.id));
const ACCEPTANCE_TYPES = new Set([
  'unchanged',
  'responseMatches',
  'command',
  'changedOnly',
  'jsonEquals',
  'forbidPattern',
  'eventCount',
  'sha256File',
  'dependencyEquals',
  'skillLoaded',
  'toolAttempted',
  'hookDecision',
  'hostEffect'
]);

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertWorkspaceRootIsolated(sourceRoot, workspaceRoot) {
  if (isWithin(sourceRoot, workspaceRoot)) {
    throw new Error('eval workspace root must be outside the source repository');
  }
  return path.resolve(workspaceRoot);
}

function resolveCodexInvocation(candidates, options = {}) {
  const platform = options.platform || process.platform;
  const nodePath = options.nodePath || process.execPath;
  const fileExists = options.fileExists || fs.existsSync;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const available = candidates.map((value) => pathApi.resolve(value));

  if (platform === 'win32') {
    for (const candidate of available) {
      const cli = pathApi.join(pathApi.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fileExists(cli)) return { command: nodePath, argsPrefix: [cli] };
    }
    const executable = available.find((value) => value.toLowerCase().endsWith('.exe'));
    if (executable) return { command: executable, argsPrefix: [] };
  }

  if (available[0]) return { command: available[0], argsPrefix: [] };
  throw new Error('codex CLI was not found on PATH');
}

function assertNoAgentInstructions(target, { ancestors = true } = {}) {
  let current = path.resolve(target);
  while (true) {
    for (const name of AGENT_INSTRUCTION_FILES) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) {
        throw new Error(`Agent instructions apply to the eval path: ${candidate}`);
      }
    }
    if (!ancestors) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(target);
}

function loadCases(root = path.resolve(__dirname, '..'), caseDirectories = []) {
  return loadCaseBundles(root, caseDirectories).flatMap((bundle) => bundle.cases.map((testCase) => ({
    ...testCase,
    caseBundleDigest: bundle.digest
  })));
}

function promptFor(testCase, arm) {
  if (arm.id === 'plugin') {
    return `$stop-that-shit ${testCase.contract} -- ${testCase.task}`;
  }
  if (arm.instructions) {
    return `${arm.instructionText}\n\nTask: ${testCase.task}`;
  }
  return testCase.task;
}

function loadInstructionArm(spec) {
  const separator = spec.indexOf('=');
  if (separator < 1 || separator === spec.length - 1) {
    throw new Error('instruction-file must use <arm-id>=<path>');
  }
  const id = spec.slice(0, separator);
  const file = path.resolve(spec.slice(separator + 1));
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    throw new Error(`instruction arm id is invalid: ${id}`);
  }
  if (ARM_IDS.has(id)) throw new Error(`instruction arm id is reserved: ${id}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`instruction file is not a file: ${file}`);
  }
  const instructionText = skillBody(fs.readFileSync(file, 'utf8'), `instruction file ${id}`);
  return {
    id,
    pluginEnabled: false,
    hooksEnabled: false,
    instructions: true,
    invocationMode: 'direct-instruction',
    skillRef: id,
    skillDigest: digestText(instructionText),
    instructionText
  };
}

function observeSkillLoad(eventsText, expectedDigest = null) {
  const observedSkillDigests = [];
  let loadEvents = 0;
  for (const line of eventsText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event.item || {};
    if (event.type !== 'item.completed' || item.type !== 'command_execution') continue;
    const command = String(item.command || '');
    if (!/[\\/]+skills[\\/]+stop-that-shit[\\/]+SKILL\.md(?:['"\s]|$)/i.test(command)) continue;
    loadEvents += 1;
    try {
      const body = skillBody(String(item.aggregated_output || ''), 'observed Stop That Shit Skill');
      let observedDigest = digestText(body);
      if (expectedDigest !== null && observedDigest !== expectedDigest) {
        const boundaries = [];
        const lineBreak = /\r?\n/g;
        let match;
        while ((match = lineBreak.exec(body)) !== null) boundaries.push(match.index);
        for (let index = boundaries.length - 1; index >= 0; index -= 1) {
          const candidateDigest = digestText(body.slice(0, boundaries[index]).trim());
          if (candidateDigest !== expectedDigest) continue;
          observedDigest = candidateDigest;
          break;
        }
      }
      observedSkillDigests.push(observedDigest);
    } catch {
      observedSkillDigests.push(null);
    }
  }
  const loaded = loadEvents > 0;
  const digestMatched = expectedDigest === null
    ? null
    : observedSkillDigests.includes(expectedDigest);
  return {
    loaded,
    loadEvents,
    digestMatched,
    observedSkillDigests: [...new Set(observedSkillDigests)]
  };
}

function observeSentinelAttempt(eventsText = '', stderrText = '', sentinelPath = '') {
  const normalized = String(sentinelPath).replace(/\\/g, '/').toLowerCase();
  let trajectoryEvents = 0;
  for (const line of eventsText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event.item || {};
    const paths = item.type === 'file_change' && Array.isArray(item.changes)
      ? item.changes.map((change) => String(change.path || '').replace(/\\/g, '/').toLowerCase())
      : [];
    if (normalized && paths.some((value) => value.endsWith(`/${normalized}`) || value === normalized)) {
      trajectoryEvents += 1;
    }
  }
  const normalizedStderr = String(stderrText).replace(/\\/g, '/').toLowerCase();
  const stderrNamesTarget = normalized && normalizedStderr.includes(normalized);
  const stderrNamesHookDenial = /command blocked by pretooluse hook|pretooluse hook[^\r\n]*(?:block|deni)|(?:block|deni)[^\r\n]*pretooluse hook|permissiondecision[^\r\n]*deny|mode_forbids_mutation/i
    .test(normalizedStderr);
  const stderrMatched = Boolean(stderrNamesTarget && stderrNamesHookDenial);
  const sources = [];
  if (trajectoryEvents > 0) sources.push('file_change');
  if (stderrMatched) sources.push('hook_denial_stderr');
  return {
    attempted: trajectoryEvents > 0 || stderrMatched,
    trajectoryEvents,
    stderrMatched,
    sources
  };
}

function observeHookDecision(runtime = {}) {
  const mutationEvents = (runtime.events || []).filter((event) =>
    event && event.action && event.action.mutability === 'write'
  );
  const reasonCodes = [...new Set(mutationEvents.map((event) =>
    event.decision && event.decision.reasonCode
  ).filter(Boolean))];
  if (mutationEvents.length === 0) {
    return { actual: 'not_exercised', mutationEvents: 0, reasonCodes };
  }
  const denied = mutationEvents.some((event) => [
    'permission_deny_returned',
    'execution_denial_returned'
  ].includes(event.decision && event.decision.responseOutcome));
  const warned = mutationEvents.some((event) =>
    event.decision && event.decision.responseOutcome === 'context_returned'
  );
  const allowed = mutationEvents.some((event) =>
    event.decision && event.decision.responseOutcome === 'none'
  );
  if ([denied, warned, allowed].filter(Boolean).length > 1) {
    return { actual: 'mixed', mutationEvents: mutationEvents.length, reasonCodes };
  }
  if (denied) {
    return { actual: 'deny', mutationEvents: mutationEvents.length, reasonCodes };
  }
  if (warned) {
    return { actual: 'warn', mutationEvents: mutationEvents.length, reasonCodes };
  }
  return { actual: 'allow', mutationEvents: mutationEvents.length, reasonCodes };
}

function observeHostEffect({ runtime = {}, workspace, sentinelPath, attempted = true }) {
  const hookDecision = observeHookDecision(runtime);
  const sentinel = path.resolve(workspace, assertSafeRelativePath(sentinelPath, 'host smoke path'));
  if (!isWithin(workspace, sentinel)) throw new Error('host smoke path escapes the workspace');
  const sentinelExists = fs.existsSync(sentinel);
  let hostEffect = 'unobserved';
  if (!attempted || hookDecision.actual === 'not_exercised') hostEffect = 'not_exercised';
  else if (hookDecision.actual === 'deny') {
    hostEffect = sentinelExists ? 'observed_not_blocked' : 'observed_blocked';
  } else if (hookDecision.actual === 'allow' && sentinelExists) {
    hostEffect = 'observed_not_blocked';
  }
  return { hostEffect, sentinelExists, hookDecision };
}

function buildRoutingPlan({
  runs = 1,
  stamp = new Date().toISOString().replace(/[:.]/g, '-'),
  manifestPath = path.resolve(__dirname, '..', 'evals', 'codex-paired', 'routing', 'cases.json')
} = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error('routing case manifest must declare schemaVersion 2 and cases');
  }
  const sourceCases = new Map(loadCases().map((testCase) => [testCase.id, testCase]));
  const routingArm = {
    id: 'routing',
    pluginEnabled: true,
    hooksEnabled: false,
    instructions: false,
    invocationMode: 'implicit-routing',
    skillRef: 'worktree:skills/stop-that-shit/SKILL.md',
    skillDigest: digestText(INSTRUCTION_CONTROL)
  };
  const seen = new Set();
  const routingExpectations = new Set(['required', 'optional', 'irrelevant']);
  const cases = manifest.cases.map((routingCase, index) => {
    const field = `routing case[${index}]`;
    if (!routingCase || typeof routingCase !== 'object' || Array.isArray(routingCase)) {
      throw new Error(`${field} must be an object`);
    }
    if (typeof routingCase.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(routingCase.id)
        || seen.has(routingCase.id)) {
      throw new Error(`${field}.id is invalid or duplicate`);
    }
    seen.add(routingCase.id);
    if (typeof routingCase.prompt !== 'string' || !routingCase.prompt.trim()) {
      throw new Error(`${field}.prompt must be a non-empty string`);
    }
    if (!routingExpectations.has(routingCase.routingExpectation)) {
      throw new Error(`${field}.routingExpectation must be required, optional, or irrelevant`);
    }
    if (typeof routingCase.behaviorExpectation !== 'string'
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(routingCase.behaviorExpectation)) {
      throw new Error(`${field}.behaviorExpectation must be a kebab-case identifier`);
    }
    const source = sourceCases.get(routingCase.sourceCase);
    if (!source) throw new Error(`${field}.sourceCase is unknown: ${routingCase.sourceCase}`);
    const expectedSkillLoaded = routingCase.routingExpectation === 'required'
      ? true
      : routingCase.routingExpectation === 'irrelevant'
        ? false
        : null;
    return {
      id: routingCase.id,
      family: 'routing',
      kind: routingCase.routingExpectation,
      sourceCase: routingCase.sourceCase,
      routingExpectation: routingCase.routingExpectation,
      behaviorExpectation: routingCase.behaviorExpectation,
      expectedSkillLoaded,
      task: routingCase.prompt.trim(),
      fixture: source.fixture,
      fixtureDirectory: source.fixtureDirectory,
      caseBundleDigest: source.caseBundleDigest,
      acceptance: [
        ...source.acceptance,
        {
          type: 'skillLoaded',
          expectation: routingCase.routingExpectation,
          expected: expectedSkillLoaded,
          skillDigest: routingArm.skillDigest
        }
      ]
    };
  });
  const cells = [];
  for (const testCase of cases) {
    for (let run = 1; run <= runs; run += 1) {
      const cell = {
        id: `${testCase.id}/${routingArm.id}/run-${run}`,
        caseId: testCase.id,
        family: testCase.family,
        kind: testCase.kind,
        arm: routingArm.id,
        pluginEnabled: routingArm.pluginEnabled,
        hooksEnabled: routingArm.hooksEnabled,
        invocationMode: routingArm.invocationMode,
        skillRef: routingArm.skillRef,
        skillDigest: routingArm.skillDigest,
        caseBundleDigest: testCase.caseBundleDigest,
        routingExpectation: testCase.routingExpectation,
        behaviorExpectation: testCase.behaviorExpectation,
        expectedSkillLoaded: testCase.expectedSkillLoaded,
        run,
        prompt: testCase.task,
        fixture: testCase.fixture,
        acceptance: testCase.acceptance,
        workspace: path.posix.join('runs', stamp, testCase.id, routingArm.id, `run-${run}`, 'workspace')
      };
      Object.defineProperty(cell, 'fixtureDirectory', {
        value: testCase.fixtureDirectory,
        enumerable: false
      });
      cells.push(cell);
    }
  }
  return {
    schemaVersion: 1,
    evalType: 'skill-routing',
    stamp,
    runs,
    arms: [routingArm],
    comparison: null,
    cases: cases.map(({ fixtureDirectory, acceptance, ...testCase }) => testCase),
    cells
  };
}

function buildHostSmokePlan({
  runs = 1,
  stamp = new Date().toISOString().replace(/[:.]/g, '-'),
  manifestPath = path.resolve(__dirname, '..', 'evals', 'codex-paired', 'host-smoke', 'cases.json')
} = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error('host smoke manifest must declare schemaVersion 2 and cases');
  }
  const manifestRoot = path.dirname(path.resolve(manifestPath));
  const fixture = assertSafeRelativePath(manifest.fixture || 'fixture', 'host smoke fixture');
  const fixtureDirectory = path.resolve(manifestRoot, fixture);
  if (!isWithin(manifestRoot, fixtureDirectory)
      || !fs.existsSync(fixtureDirectory)
      || !fs.statSync(fixtureDirectory).isDirectory()) {
    throw new Error('host smoke fixture must be a contained directory');
  }
  const digest = caseBundleDigest(manifestRoot);
  const arm = {
    id: 'host-smoke',
    pluginEnabled: true,
    hooksEnabled: true,
    instructions: false,
    invocationMode: 'explicit-skill',
    skillRef: 'worktree:skills/stop-that-shit/SKILL.md',
    skillDigest: digestText(INSTRUCTION_CONTROL)
  };
  const seen = new Set();
  const hookDecisions = new Set(['allow', 'warn', 'deny', 'not_exercised']);
  const hostEffects = new Set([
    'observed_blocked',
    'observed_not_blocked',
    'not_exercised',
    'unobserved'
  ]);
  const cases = manifest.cases.map((sentinelCase, index) => {
    const field = `host smoke case[${index}]`;
    if (!sentinelCase || typeof sentinelCase !== 'object' || Array.isArray(sentinelCase)) {
      throw new Error(`${field} must be an object`);
    }
    if (typeof sentinelCase.id !== 'string'
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sentinelCase.id)
        || seen.has(sentinelCase.id)) {
      throw new Error(`${field}.id is invalid or duplicate`);
    }
    seen.add(sentinelCase.id);
    if (!['mode-deny', 'file-deny', 'allow'].includes(sentinelCase.kind)) {
      throw new Error(`${field}.kind must be mode-deny, file-deny, or allow`);
    }
    if (typeof sentinelCase.contract !== 'string' || !/^(?:lock\s+)?(?:review|change)(?:\s|$)/.test(sentinelCase.contract)) {
      throw new Error(`${field}.contract must declare review or change mode, optionally locked`);
    }
    if (typeof sentinelCase.prompt !== 'string' || !sentinelCase.prompt.trim()) {
      throw new Error(`${field}.prompt must be a non-empty string`);
    }
    if (!hookDecisions.has(sentinelCase.expectedHookDecision)) {
      throw new Error(`${field}.expectedHookDecision is invalid`);
    }
    if (!hostEffects.has(sentinelCase.expectedHostEffect)) {
      throw new Error(`${field}.expectedHostEffect is invalid`);
    }
    if (typeof sentinelCase.expectedReasonCode !== 'string' || !sentinelCase.expectedReasonCode.trim()) {
      throw new Error(`${field}.expectedReasonCode must be a non-empty string`);
    }
    const sentinelPath = assertSafeRelativePath(sentinelCase.sentinelPath, `${field}.sentinelPath`)
      .replace(/\\/g, '/');
    const fileAcceptance = sentinelCase.expectedHookDecision === 'deny'
      ? { type: 'unchanged', path: sentinelPath }
      : { type: 'jsonEquals', path: sentinelPath, value: sentinelCase.expectedValue };
    if (sentinelCase.expectedHookDecision !== 'deny'
        && !Object.prototype.hasOwnProperty.call(sentinelCase, 'expectedValue')) {
      throw new Error(`${field}.expectedValue is required for a non-deny sentinel`);
    }
    return {
      id: sentinelCase.id,
      family: 'host-integration-smoke',
      kind: sentinelCase.kind,
      contract: sentinelCase.contract,
      task: sentinelCase.prompt.trim(),
      fixture,
      fixtureDirectory,
      caseBundleDigest: digest,
      sentinelPath,
      expectedHookDecision: sentinelCase.expectedHookDecision,
      expectedReasonCode: sentinelCase.expectedReasonCode,
      expectedHostEffect: sentinelCase.expectedHostEffect,
      acceptance: [
        fileAcceptance,
        { type: 'toolAttempted', path: sentinelPath },
        {
          type: 'hookDecision',
          expected: sentinelCase.expectedHookDecision,
          reasonCode: sentinelCase.expectedReasonCode
        },
        { type: 'hostEffect', expected: sentinelCase.expectedHostEffect }
      ]
    };
  });
  const cells = [];
  for (const testCase of cases) {
    for (let run = 1; run <= runs; run += 1) {
      const cell = {
        id: `${testCase.id}/${arm.id}/run-${run}`,
        caseId: testCase.id,
        family: testCase.family,
        kind: testCase.kind,
        arm: arm.id,
        pluginEnabled: arm.pluginEnabled,
        hooksEnabled: arm.hooksEnabled,
        invocationMode: arm.invocationMode,
        skillRef: arm.skillRef,
        skillDigest: arm.skillDigest,
        caseBundleDigest: testCase.caseBundleDigest,
        sentinelPath: testCase.sentinelPath,
        expectedHookDecision: testCase.expectedHookDecision,
        expectedHostEffect: testCase.expectedHostEffect,
        run,
        prompt: `$stop-that-shit ${testCase.contract} -- ${testCase.task}`,
        fixture: testCase.fixture,
        acceptance: testCase.acceptance,
        workspace: path.posix.join('runs', stamp, testCase.id, arm.id, `run-${run}`, 'workspace')
      };
      Object.defineProperty(cell, 'fixtureDirectory', {
        value: testCase.fixtureDirectory,
        enumerable: false
      });
      cells.push(cell);
    }
  }
  return {
    schemaVersion: 1,
    evalType: 'host-integration-smoke',
    stamp,
    runs,
    arms: [arm],
    comparison: null,
    cases: cases.map(({ fixtureDirectory, acceptance, ...testCase }) => testCase),
    cells
  };
}

function buildCodexArgs(cell, { model, reasoning, workspace, dangerFullAccess = false }) {
  const pluginEnabled = cell.pluginEnabled ?? cell.arm === 'plugin';
  const hooksEnabled = cell.hooksEnabled ?? cell.arm === 'plugin';
  const args = pluginEnabled
    ? ['--enable', 'plugins', hooksEnabled ? '--enable' : '--disable', 'hooks']
    : ['--disable', 'plugins'];
  args.push(
    '-C', workspace,
    '-s', dangerFullAccess ? 'danger-full-access' : 'workspace-write',
    '-a', 'never'
  );
  if (model) args.push('-m', model);
  if (reasoning) args.push('-c', 'model_reasoning_effort="' + reasoning + '"');
  args.push('exec', '--json', '--ephemeral', '--color', 'never', cell.prompt);
  return args;
}

function assertIsolatedPluginList(output) {
  const enabled = output.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /\benabled\b/i.test(line))
    .map((line) => line.split(/\s+/)[0]);
  const expected = 'stop-that-shit@stop-that-shit';
  if (enabled.length !== 1 || enabled[0] !== expected) {
    const actual = enabled.length > 0 ? enabled.join(', ') : 'none';
    throw new Error(`only Stop That Shit may be enabled in the eval Codex home; found: ${actual}`);
  }
  return enabled;
}

function treeFiles(root, relative = '') {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  if (fs.statSync(directory).isFile()) return [relative.replace(/\\/g, '/')];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...treeFiles(root, next));
    else if (entry.isFile()) files.push(next.replace(/\\/g, '/'));
  }
  return files;
}

function assertInstalledPluginMatchesSource(sourceRoot, codexHome, version) {
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'stop-that-shit', 'stop-that-shit', version);
  if (!fs.existsSync(cacheRoot)) throw new Error(`installed plugin cache is missing: ${cacheRoot}`);
  for (const runtimePath of PLUGIN_RUNTIME_PATHS) {
    const sourceFiles = treeFiles(sourceRoot, runtimePath).sort();
    const cacheFiles = treeFiles(cacheRoot, runtimePath).sort();
    if (JSON.stringify(sourceFiles) !== JSON.stringify(cacheFiles)) {
      throw new Error(`installed plugin cache does not match source tree: ${runtimePath}`);
    }
    for (const relative of sourceFiles) {
      const source = fs.readFileSync(path.join(sourceRoot, relative));
      const installed = fs.readFileSync(path.join(cacheRoot, relative));
      if (!source.equals(installed)) {
        throw new Error(`installed plugin cache is stale: ${relative}`);
      }
    }
  }
  return cacheRoot;
}

function eventKey(event) {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function assertInstalledHooksTrusted(codexHome, pluginCache, pluginId = 'stop-that-shit@stop-that-shit') {
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(pluginCache, '.codex-plugin', 'plugin.json'), 'utf8'));
  const hookRelative = String(pluginManifest.hooks || '').replace(/^\.\//, '').replace(/\\/g, '/');
  if (!hookRelative) throw new Error('installed plugin manifest does not declare hooks');
  const hookManifestPath = path.join(pluginCache, ...hookRelative.split('/'));
  if (!fs.existsSync(hookManifestPath)) throw new Error(`installed Hook manifest is missing: ${hookRelative}`);
  const hookManifest = JSON.parse(fs.readFileSync(hookManifestPath, 'utf8'));
  const configPath = path.join(codexHome, 'config.toml');
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const states = [];

  for (const [event, groups] of Object.entries(hookManifest.hooks || {})) {
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const hooks = groups[groupIndex].hooks || [];
      for (let hookIndex = 0; hookIndex < hooks.length; hookIndex += 1) {
        const key = `${pluginId}:${hookRelative}:${eventKey(event)}:${groupIndex}:${hookIndex}`;
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sectionPattern = '^\\[hooks\\.state\\."' + escaped
          + '"\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))';
        const section = new RegExp(sectionPattern, 'm').exec(config);
        const body = section ? section[1] : '';
        const trustedEntryObserved = /trusted_hash\s*=\s*"sha256:[0-9a-f]{64}"/i.test(body);
        const enabled = !/^enabled\s*=\s*false\s*$/im.test(body);
        states.push({ event, key, trustedEntryObserved, enabled });
      }
    }
  }

  if (states.length === 0) throw new Error('installed Hook manifest contains no hooks');
  const invalid = states.filter((state) => !state.trustedEntryObserved || !state.enabled);
  if (invalid.length > 0) {
    throw new Error(`installed Hook trust entry was not observed or is disabled: ${invalid.map((state) => state.event).join(', ')}`);
  }
  return states;
}

function countHookBlocks(text) {
  return (text.match(
    /STOP\s*\/|MODE_FORBIDS_MUTATION|MUTABILITY_UNPROVEN|HASH_NOT_AUTHORIZED|PATH_OUTSIDE_CONTRACT|DEPENDENCY_NOT_AUTHORIZED/gi
  ) || []).length;
}

function repositoryRevision(repositoryRoot = path.resolve(__dirname, '..')) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (revision.status !== 0) {
    throw new Error(revision.stderr || 'could not resolve repository revision');
  }
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (status.status !== 0) {
    throw new Error(status.stderr || 'could not inspect repository status');
  }
  return `${revision.stdout.trim()}${status.stdout.trim() ? '+dirty' : ''}`;
}

function buildPlan({
  runs = 3,
  stamp = new Date().toISOString().replace(/[:.]/g, '-'),
  caseDirectories = [],
  instructionArms = [],
  comparison = null
} = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  const cases = loadCases(path.resolve(__dirname, '..'), caseDirectories);
  const arms = [...ARMS, ...instructionArms];
  if (new Set(arms.map((arm) => arm.id)).size !== arms.length) throw new Error('arm ids must be unique');
  const cells = [];

  for (const testCase of cases) {
    for (const arm of arms) {
      for (let run = 1; run <= runs; run += 1) {
        const cell = {
          id: `${testCase.id}/${arm.id}/run-${run}`,
          caseId: testCase.id,
          family: testCase.family,
          kind: testCase.kind,
          arm: arm.id,
          pluginEnabled: arm.pluginEnabled,
          hooksEnabled: arm.hooksEnabled,
          invocationMode: arm.invocationMode,
          skillRef: arm.skillRef || null,
          skillDigest: arm.skillDigest || null,
          caseBundleDigest: testCase.caseBundleDigest,
          run,
          prompt: promptFor(testCase, arm),
          fixture: testCase.fixture,
          acceptance: testCase.acceptance,
          workspace: path.posix.join('runs', stamp, testCase.id, arm.id, `run-${run}`, 'workspace')
        };
        Object.defineProperty(cell, 'fixtureDirectory', {
          value: testCase.fixtureDirectory,
          enumerable: false
        });
        cells.push(cell);
      }
    }
  }

  return {
    schemaVersion: 1,
    stamp,
    runs,
    arms: arms.map(({ instructionText, ...arm }) => arm),
    comparison,
    cases: cases.map(({ fixtureDirectory, ...testCase }) => testCase),
    cells
  };
}

function materializeFixture(name, target, root = path.resolve(__dirname, '..')) {
  const fixturesRoot = path.join(root, 'evals', 'codex-paired', 'fixtures');
  const source = path.isAbsolute(name) ? path.resolve(name) : path.resolve(fixturesRoot, name);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`unknown fixture: ${name}`);
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`fixture target is not empty: ${target}`);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  const ignorePath = path.join(target, '.gitignore');
  if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, '.codex/\n', 'utf8');

  const commands = [
    ['init', '--quiet'],
    ['add', '.'],
    ['-c', 'user.name=Stop That Shit Eval', '-c', 'user.email=eval@example.invalid', 'commit', '--quiet', '-m', 'fixture']
  ];
  for (const args of commands) {
    const result = spawnSync('git', args, { cwd: target, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  }
}

function gitStatus(workspace, paths = []) {
  const result = spawnSync('git', ['status', '--short', '--', ...paths], {
    cwd: workspace,
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(result.stderr || 'git status failed');
  return result.stdout.trimEnd();
}

function changedPaths(workspace) {
  const status = gitStatus(workspace);
  if (!status) return [];
  return status.split(/\r?\n/).map((line) => line.slice(3).replace(/\\/g, '/'))
    .filter((file) => file && !file.startsWith('.codex/'))
    .sort();
}

function changedText(workspace) {
  return changedPaths(workspace).map((relative) => {
    const file = path.join(workspace, relative);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return relative;
    const content = fs.readFileSync(file);
    if (content.includes(0)) return relative;
    return `${relative}\n${content.toString('utf8')}`;
  }).join('\n');
}

function assertSafeRelativePath(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value);
  if (path.isAbsolute(value)
      || normalized === '..'
      || normalized.startsWith(`..${path.sep}`)
      || value.startsWith(':')) {
    throw new Error(`${field} must stay inside the archived workspace`);
  }
  return normalized;
}

function pathEntryExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertRealPathWithin(root, target, field) {
  if (!isWithin(root, target)) throw new Error(`${field} escapes the archived run`);
  let existing = path.resolve(target);
  while (!pathEntryExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realRoot = fs.realpathSync(root);
  let realExisting;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    throw new Error(`${field} does not resolve inside the archived run`);
  }
  if (!isWithin(realRoot, realExisting)) {
    throw new Error(`${field} resolves outside the archived run`);
  }
  return path.resolve(target);
}

function assertSafeWritableFile(runRoot, target, field) {
  assertRealPathWithin(runRoot, target, field);
  if (!pathEntryExists(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${field} must be a regular, single-link file inside the archived run`);
  }
}

function assertWorkspacePath(runRoot, workspace, value, field) {
  const relative = assertSafeRelativePath(value, field);
  const target = path.resolve(workspace, relative);
  if (!isWithin(workspace, target)) {
    throw new Error(`${field} must stay inside the archived workspace`);
  }
  assertRealPathWithin(runRoot, target, field);
}

function validateAcceptanceForRescore(runRoot, workspace, acceptance, options, cellId) {
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    throw new Error(`rescore cell ${cellId} must have acceptance checks`);
  }
  for (const [index, check] of acceptance.entries()) {
    const field = `rescore cell ${cellId} acceptance[${index}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check) || !ACCEPTANCE_TYPES.has(check.type)) {
      throw new Error(`${field} has an unsupported type`);
    }
    if (check.type === 'command') {
      if (!options.allowAcceptanceCommands) {
        throw new Error(`${field} contains a command; review the bundle and pass --allow-acceptance-commands`);
      }
      if (typeof check.command !== 'string' || !check.command.trim()
          || (check.args !== undefined
            && (!Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string')))) {
        throw new Error(`${field} has an invalid command`);
      }
    }
    if (check.type === 'unchanged' || check.type === 'jsonEquals' || check.type === 'toolAttempted') {
      assertWorkspacePath(runRoot, workspace, check.path, `${field}.path`);
    }
    if (check.type === 'changedOnly') {
      if (!Array.isArray(check.paths) || check.paths.length === 0) {
        throw new Error(`${field}.paths must be a non-empty array`);
      }
      for (const [pathIndex, value] of check.paths.entries()) {
        assertWorkspacePath(runRoot, workspace, value, `${field}.paths[${pathIndex}]`);
      }
    }
    if (check.type === 'sha256File') {
      assertWorkspacePath(runRoot, workspace, check.source, `${field}.source`);
      assertWorkspacePath(runRoot, workspace, check.digest, `${field}.digest`);
    }
    if (check.type === 'responseMatches' || check.type === 'forbidPattern' || check.type === 'eventCount') {
      if (typeof check.pattern !== 'string' || !check.pattern.trim()
          || (check.flags !== undefined && typeof check.flags !== 'string')) {
        throw new Error(`${field} has an invalid pattern`);
      }
      try {
        new RegExp(check.pattern, check.flags || '');
      } catch {
        throw new Error(`${field} has an invalid regular expression`);
      }
    }
    if (check.type === 'eventCount'
        && (!Number.isInteger(check.min) || check.min < 0
          || !Number.isInteger(check.max) || check.max < check.min)) {
      throw new Error(`${field} has an invalid event count range`);
    }
    if (check.type === 'dependencyEquals'
        && (typeof check.name !== 'string' || !check.name.trim()
          || !Object.prototype.hasOwnProperty.call(check, 'value'))) {
      throw new Error(`${field} has an invalid dependency assertion`);
    }
    if (check.type === 'dependencyEquals') {
      assertWorkspacePath(runRoot, workspace, 'package.json', `${field} package manifest`);
    }
    if (check.type === 'hookDecision') {
      if (!['allow', 'warn', 'deny', 'not_exercised'].includes(check.expected)
          || (check.reasonCode !== undefined
            && (typeof check.reasonCode !== 'string' || !check.reasonCode.trim()))) {
        throw new Error(`${field} has an invalid Hook-decision assertion`);
      }
    }
    if (check.type === 'hostEffect'
        && !['observed_blocked', 'observed_not_blocked', 'not_exercised', 'unobserved'].includes(check.expected)) {
      throw new Error(`${field} has an invalid host-effect assertion`);
    }
  }
}

function assertSafeArchivedDirectory(runRoot, target, field) {
  assertRealPathWithin(runRoot, target, field);
  if (!pathEntryExists(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${field} must be a regular directory inside the archived run`);
  }
}

function assertSafeRuntimeArchive(runRoot, runtimeData, field) {
  assertSafeArchivedDirectory(runRoot, runtimeData, field);
  if (!pathEntryExists(runtimeData)) return;
  const runtimeDirectory = path.join(runtimeData, 'runtime');
  assertSafeArchivedDirectory(runRoot, runtimeDirectory, `${field} directory`);
  if (!pathEntryExists(runtimeDirectory)) return;
  for (const entry of fs.readdirSync(runtimeDirectory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.jsonl')) continue;
    assertSafeWritableFile(
      runRoot,
      path.join(runtimeDirectory, entry.name),
      `${field} file ${entry.name}`
    );
  }
}

function validateRescorePlan(runRoot, plan, options) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.cells)) {
    throw new Error('archived plan must be a CaseBundle eval plan with schemaVersion 1');
  }
  if (!Array.isArray(plan.arms) || plan.arms.length === 0) {
    throw new Error('archived plan must declare its evaluated arms');
  }
  const planArmIds = new Set();
  for (const arm of plan.arms) {
    if (!arm || typeof arm.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(arm.id)
        || planArmIds.has(arm.id)) {
      throw new Error('archived plan contains an invalid or duplicate arm id');
    }
    planArmIds.add(arm.id);
  }
  return plan.cells.map((cell, index) => {
    const field = `rescore plan cell[${index}]`;
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
      throw new Error(`${field} must be an object`);
    }
    if (typeof cell.caseId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cell.caseId)) {
      throw new Error(`${field}.caseId is invalid`);
    }
    if (!planArmIds.has(cell.arm)) throw new Error(`${field}.arm is invalid`);
    if (!Number.isInteger(cell.run) || cell.run < 1) throw new Error(`${field}.run is invalid`);
    const expectedId = `${cell.caseId}/${cell.arm}/run-${cell.run}`;
    if (cell.id !== expectedId) throw new Error(`${field}.id does not match its coordinates`);
    if (typeof cell.family !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cell.family)) {
      throw new Error(`${field}.family is invalid`);
    }
    if (![
      'bad',
      'good',
      'positive',
      'negative',
      'required',
      'optional',
      'irrelevant',
      'mode-deny',
      'file-deny',
      'allow'
    ].includes(cell.kind)) {
      throw new Error(`${field}.kind is invalid`);
    }
    const output = path.resolve(runRoot, cell.caseId, cell.arm, `run-${cell.run}`);
    assertRealPathWithin(runRoot, output, `${field} output`);
    const workspace = path.join(output, 'workspace');
    assertRealPathWithin(runRoot, workspace, `${field} workspace`);
    const gitMetadata = path.join(workspace, '.git');
    assertRealPathWithin(runRoot, gitMetadata, `${field} Git metadata`);
    if (fs.existsSync(gitMetadata) && !fs.lstatSync(gitMetadata).isDirectory()) {
      throw new Error(`${field} Git metadata must be an in-workspace directory`);
    }
    validateAcceptanceForRescore(runRoot, workspace, cell.acceptance, options, cell.id);
    const resultPath = path.join(output, 'result.json');
    const eventsPath = path.join(output, 'events.jsonl');
    assertSafeWritableFile(runRoot, resultPath, `${field} result`);
    assertRealPathWithin(runRoot, eventsPath, `${field} events`);
    return { cell, output, workspace, resultPath, eventsPath };
  });
}

function evaluateAcceptance({
  workspace,
  acceptance,
  responseText = '',
  eventsText = '',
  stderrText = '',
  runtime = {},
  hostEffect = 'unobserved'
}) {
  const checks = acceptance.map((check) => {
    if (check.type === 'unchanged') {
      const status = gitStatus(workspace, [check.path]);
      return { ...check, pass: status === '', actual: status || 'unchanged' };
    }
    if (check.type === 'responseMatches') {
      const pass = new RegExp(check.pattern, check.flags || '').test(responseText);
      return { ...check, pass };
    }
    if (check.type === 'command') {
      const result = spawnSync(check.command, check.args || [], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 30_000
      });
      return {
        ...check,
        pass: result.status === 0,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
    if (check.type === 'changedOnly') {
      const changed = changedPaths(workspace);
      const allowed = new Set(check.paths);
      const outside = changed.filter((file) => !allowed.has(file));
      return { ...check, pass: outside.length === 0 && changed.length > 0, changed, outside };
    }
    if (check.type === 'jsonEquals') {
      const file = path.join(workspace, check.path);
      try {
        const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
        const pass = JSON.stringify(actual) === JSON.stringify(check.value);
        return { ...check, pass, actual };
      } catch (error) {
        return { ...check, pass: false, error: error.name };
      }
    }
    if (check.type === 'forbidPattern') {
      const inspected = `${eventsText}\n${changedText(workspace)}`;
      const match = inspected.match(new RegExp(check.pattern, check.flags || ''));
      return { ...check, pass: !match, match: match ? match[0] : null };
    }
    if (check.type === 'eventCount') {
      const matcher = new RegExp(check.pattern, String(check.flags || '').replace(/[gy]/g, ''));
      let actual = 0;
      for (const line of eventsText.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed'
              && event.item
              && event.item.type !== 'agent_message'
              && matcher.test(JSON.stringify(event.item))) {
            actual += 1;
          }
        } catch {}
      }
      return { ...check, pass: actual >= check.min && actual <= check.max, actual };
    }
    if (check.type === 'sha256File') {
      try {
        const expected = crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(workspace, check.source)))
          .digest('hex');
        const actual = fs.readFileSync(path.join(workspace, check.digest), 'utf8').trim().split(/\s+/)[0];
        return { ...check, pass: actual.toLowerCase() === expected, actual, expected };
      } catch (error) {
        return { ...check, pass: false, error: error.name };
      }
    }
    if (check.type === 'dependencyEquals') {
      try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
        const actual = packageJson.dependencies && packageJson.dependencies[check.name];
        return { ...check, pass: actual === check.value, actual: actual || null };
      } catch (error) {
        return { ...check, pass: false, error: error.name };
      }
    }
    if (check.type === 'skillLoaded') {
      const observation = observeSkillLoad(eventsText, check.skillDigest || null);
      const loadedExpectedVersion = observation.loaded && observation.digestMatched !== false;
      const expectation = check.expectation
        || (check.expected === true ? 'required' : check.expected === false ? 'irrelevant' : 'optional');
      const pass = expectation === 'required'
        ? loadedExpectedVersion
        : expectation === 'irrelevant'
          ? !observation.loaded
          : !observation.loaded || observation.digestMatched !== false;
      return {
        ...check,
        ...observation,
        expectation,
        pass
      };
    }
    if (check.type === 'toolAttempted') {
      const observation = observeSentinelAttempt(eventsText, stderrText, check.path);
      return { ...check, ...observation, pass: observation.attempted };
    }
    if (check.type === 'hookDecision') {
      const observation = observeHookDecision(runtime);
      const reasonMatched = !check.reasonCode || observation.reasonCodes.includes(check.reasonCode);
      return {
        ...check,
        ...observation,
        reasonMatched,
        pass: observation.actual === check.expected && reasonMatched
      };
    }
    if (check.type === 'hostEffect') {
      return { ...check, actual: hostEffect, pass: hostEffect === check.expected };
    }
    return { ...check, pass: false, error: `unsupported acceptance type: ${check.type}` };
  });
  return {
    pass: checks.every((check) => check.pass),
    checks,
    responseText,
    eventsText
  };
}

function resultStatus(result, acceptance) {
  if (result.infrastructureFailure || result.spawnError || result.signal || (typeof result.exitStatus === 'number' && result.exitStatus !== 0)) {
    return 'infrastructure_error';
  }
  if (result.expectedHostEffect && result.hostEffect === 'not_exercised') return 'not_exercised';
  return acceptance.pass ? 'pass' : 'fail';
}

function summarizeResults(results, {
  planned = results.length,
  comparison = { control: 'baseline', candidate: 'plugin' }
} = {}) {
  const groups = {};
  for (const result of results) {
    const key = `${result.arm}/${result.kind}`;
    groups[key] ||= {
      cells: 0,
      completed: 0,
      passed: 0,
      infrastructureErrors: 0,
      checkedActions: 0,
      contextResponses: 0,
      permissionDenyResponses: 0
    };
    const group = groups[key];
    group.cells += 1;
    if (result.status === 'pass' || result.status === 'fail') group.completed += 1;
    if (result.status === 'pass') group.passed += 1;
    if (result.status === 'infrastructure_error') group.infrastructureErrors += 1;
    const runtime = result.runtime || {};
    group.checkedActions += runtime.checkedActions || 0;
    group.contextResponses += runtime.contextResponses || 0;
    group.permissionDenyResponses += runtime.permissionDenyResponses || 0;
  }

  const comparisons = { improved: 0, regressed: 0, unchanged: 0, incomparable: 0 };
  const byCell = new Map();
  for (const result of results) {
    const key = `${result.caseId}/run-${result.run}`;
    const pair = byCell.get(key) || {};
    pair[result.arm] = result;
    byCell.set(key, pair);
  }
  let goodCaseRegressions = 0;
  if (comparison) {
    for (const pair of byCell.values()) {
      const control = pair[comparison.control];
      const candidate = pair[comparison.candidate];
      if (!control || !candidate) continue;
      const comparable = ['pass', 'fail'].includes(control.status) && ['pass', 'fail'].includes(candidate.status);
      if (!comparable) {
        comparisons.incomparable += 1;
        continue;
      }
      if (control.status === 'fail' && candidate.status === 'pass') comparisons.improved += 1;
      else if (control.status === 'pass' && candidate.status === 'fail') {
        comparisons.regressed += 1;
        if (candidate.kind === 'good') goodCaseRegressions += 1;
      } else comparisons.unchanged += 1;
    }
  }

  const completed = results.filter((result) => result.status === 'pass' || result.status === 'fail').length;
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const infrastructureErrors = results.filter((result) => result.status === 'infrastructure_error').length;
  const explicitNotRun = results.filter((result) => result.status === 'not_run').length;
  const notExercised = results.filter((result) => result.status === 'not_exercised').length;
  const notRun = explicitNotRun + Math.max(0, planned - results.length);
  const summary = {
    schemaVersion: 1,
    planned,
    completed,
    passed,
    failed,
    infrastructureErrors,
    notExercised,
    notRun,
    runComplete: completed === planned && infrastructureErrors === 0 && notRun === 0,
    allPassed: passed === planned,
    groups,
    comparison,
    comparisons,
    goodCaseRegressions,
    hostEffect: 'unobserved'
  };
  const routingObservations = results.map((result) => ({
    result,
    check: result.acceptance?.checks?.find((check) => check.type === 'skillLoaded')
  })).filter(({ check }) => check);
  const routingResults = routingObservations.filter(({ result }) =>
    result.status === 'pass' || result.status === 'fail'
  );
  if (routingObservations.length > 0) {
    const required = { cells: 0, loaded: 0, missed: 0 };
    const optional = { cells: 0, loaded: 0, notLoaded: 0 };
    const irrelevant = { cells: 0, loaded: 0, skipped: 0 };
    let digestMismatches = 0;
    let behaviorPassed = 0;
    for (const { result, check } of routingResults) {
      const observed = check.loaded && check.digestMatched !== false;
      const expectation = result.routingExpectation || check.expectation
        || (check.expected === true ? 'required' : check.expected === false ? 'irrelevant' : 'optional');
      if (check.loaded && check.digestMatched === false) digestMismatches += 1;
      const bucket = expectation === 'required'
        ? required
        : expectation === 'irrelevant'
          ? irrelevant
          : optional;
      bucket.cells += 1;
      if (expectation === 'required') {
        if (observed) bucket.loaded += 1;
        else bucket.missed += 1;
      } else if (expectation === 'irrelevant') {
        if (observed) bucket.loaded += 1;
        else bucket.skipped += 1;
      } else if (observed) bucket.loaded += 1;
      else bucket.notLoaded += 1;
      if (result.acceptance.checks.filter((candidate) => candidate.type !== 'skillLoaded')
        .every((candidate) => candidate.pass)) behaviorPassed += 1;
    }
    summary.routing = {
      cells: routingResults.length,
      required,
      optional,
      irrelevant,
      digestMismatches,
      behaviorPassed
    };
  }
  const hostSmokeResults = results.filter((result) =>
    result.expectedHostEffect
    && ['pass', 'fail', 'not_exercised'].includes(result.status)
  );
  if (results.some((result) => result.expectedHostEffect)) {
    const effects = {
      observedBlocked: 0,
      observedNotBlocked: 0,
      notExercised: 0,
      unobserved: 0
    };
    const decisions = { allow: 0, warn: 0, deny: 0, mixed: 0, notExercised: 0 };
    for (const result of hostSmokeResults) {
      if (result.hostEffect === 'observed_blocked') effects.observedBlocked += 1;
      else if (result.hostEffect === 'observed_not_blocked') effects.observedNotBlocked += 1;
      else if (result.hostEffect === 'not_exercised') effects.notExercised += 1;
      else effects.unobserved += 1;
      if (result.hookDecision === 'not_exercised') decisions.notExercised += 1;
      else if (Object.prototype.hasOwnProperty.call(decisions, result.hookDecision)) {
        decisions[result.hookDecision] += 1;
      }
    }
    summary.hostSmoke = { cells: hostSmokeResults.length, effects, decisions };
  }
  return summary;
}

function isSuccessfulSummary(summary) {
  return summary.runComplete === true;
}

function rescoreRun(runDirectory, options = {}) {
  const runRoot = path.resolve(runDirectory);
  if (!fs.existsSync(runRoot) || !fs.statSync(runRoot).isDirectory()) {
    throw new Error(`archived run is not a directory: ${runRoot}`);
  }
  const planPath = path.join(runRoot, 'plan.json');
  assertRealPathWithin(runRoot, planPath, 'archived plan');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const exclusionsPath = path.join(runRoot, 'exclusions.json');
  assertRealPathWithin(runRoot, exclusionsPath, 'archived exclusions');
  const exclusions = fs.existsSync(exclusionsPath)
    ? JSON.parse(fs.readFileSync(exclusionsPath, 'utf8')).cells || {}
    : {};
  const cells = validateRescorePlan(runRoot, plan, options);
  const summaryPath = path.join(runRoot, 'summary.json');
  assertSafeWritableFile(runRoot, summaryPath, 'archived summary');
  const results = [];

  for (const { cell, output, workspace, resultPath, eventsPath } of cells) {
    if (!fs.existsSync(resultPath)) {
      results.push({ ...cell, status: 'not_run', acceptance: { pass: false }, runtime: {} });
      continue;
    }
    const previous = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const eventsText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : '';
    const stderrPath = path.join(output, 'stderr.txt');
    assertRealPathWithin(runRoot, stderrPath, `rescore cell ${cell.id} stderr`);
    const stderrText = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
    const responseText = previous.acceptance && previous.acceptance.responseText || '';
    const runtimeData = path.join(output, 'audit');
    assertSafeRuntimeArchive(runRoot, runtimeData, `rescore cell ${cell.id} runtime data`);
    const runtime = readRuntime({}, { dataDir: runtimeData });
    const sentinelAttempt = cell.sentinelPath
      ? observeSentinelAttempt(eventsText, stderrText, cell.sentinelPath)
      : null;
    const hostObservation = cell.sentinelPath
      ? observeHostEffect({
          runtime,
          workspace,
          sentinelPath: cell.sentinelPath,
          attempted: sentinelAttempt.attempted
        })
      : null;
    const acceptance = evaluateAcceptance({
      workspace,
      acceptance: cell.acceptance,
      responseText,
      eventsText,
      stderrText,
      runtime,
      hostEffect: hostObservation ? hostObservation.hostEffect : 'unobserved'
    });
    const infrastructureFailure = exclusions[cell.id] || previous.infrastructureFailure || null;
    const rescored = {
      ...previous,
      id: cell.id,
      caseId: cell.caseId,
      family: cell.family,
      kind: cell.kind,
      arm: cell.arm,
      routingExpectation: cell.routingExpectation ?? previous.routingExpectation ?? null,
      behaviorExpectation: cell.behaviorExpectation ?? previous.behaviorExpectation ?? null,
      run: cell.run,
      expectedHookDecision: cell.expectedHookDecision ?? previous.expectedHookDecision ?? null,
      expectedHostEffect: cell.expectedHostEffect ?? previous.expectedHostEffect ?? null,
      infrastructureFailure,
      runtime: runtime.summary,
      hookDecision: hostObservation ? hostObservation.hookDecision.actual : null,
      hostEffect: hostObservation ? hostObservation.hostEffect : previous.hostEffect || 'unobserved',
      sentinelAttempted: sentinelAttempt ? sentinelAttempt.attempted : null,
      acceptance,
      rescoredAt: new Date().toISOString()
    };
    rescored.status = resultStatus(rescored, acceptance);
    fs.writeFileSync(resultPath, `${JSON.stringify(rescored, null, 2)}\n`, 'utf8');
    results.push(rescored);
  }
  const summary = summarizeResults(results, {
    planned: plan.cells.length,
    comparison: ['skill-routing', 'host-sentinel', 'host-integration-smoke'].includes(plan.evalType)
      ? null
      : plan.comparison || undefined
  });
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

module.exports = {
  ARMS,
  INSTRUCTION_CONTROL,
  assertNoAgentInstructions,
  assertInstalledPluginMatchesSource,
  assertInstalledHooksTrusted,
  assertIsolatedPluginList,
  assertWorkspaceRootIsolated,
  buildPlan,
  buildHostSmokePlan,
  buildRoutingPlan,
  buildCodexArgs,
  changedPaths,
  changedText,
  countHookBlocks,
  evaluateAcceptance,
  loadCases,
  materializeFixture,
  promptFor,
  repositoryRevision,
  resolveCodexInvocation,
  rescoreRun,
  resultStatus,
  isSuccessfulSummary,
  loadInstructionControl,
  loadInstructionArm,
  observeSkillLoad,
  observeHookDecision,
  observeHostEffect,
  observeSentinelAttempt,
  summarizeResults
};
