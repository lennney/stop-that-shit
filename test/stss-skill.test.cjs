'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadCaseBundles } = require('../scripts/case-bundle-lib.cjs');
const { evaluateAcceptance } = require('../scripts/paired-eval-lib.cjs');

const root = path.join(__dirname, '..');
const casesRoot = path.join(root, 'evals', 'stss', 'cases');
const caseDirectories = fs.readdirSync(casesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(casesRoot, entry.name));
const bundles = loadCaseBundles(root, caseDirectories);
const offline = JSON.parse(fs.readFileSync(path.join(root, 'evals', 'stss', 'offline-responses.json'), 'utf8'));

function responseAcceptance(caseVariant) {
  return caseVariant.acceptance.filter((check) => check.type === 'responseMatches');
}

function caseById(id) {
  return bundles.flatMap((bundle) => bundle.cases).find((entry) => entry.id === id);
}

function accepts(id, responseText) {
  const selected = caseById(id);
  assert.ok(selected, `missing offline case: ${id}`);
  return evaluateAcceptance({
    workspace: selected.fixtureDirectory,
    acceptance: responseAcceptance(selected),
    responseText
  }).pass;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

test('STSS ships six validated Good/Bad CaseBundle families', () => {
  assert.deepEqual(bundles.map((bundle) => bundle.id), [
    'causal-boundary',
    'diligence-narration',
    'hedge-stack',
    'hollow-claim',
    'negative-scope',
    'proposal-disclaimer'
  ]);
  assert.equal(bundles.flatMap((bundle) => bundle.cases).length, 12);
  assert.equal(offline.schemaVersion, 1);
  assert.deepEqual(
    Object.keys(offline.responses).sort(),
    bundles.flatMap((bundle) => bundle.cases.map((entry) => entry.id)).sort()
  );
});

test('all checked-in STSS responses pass offline acceptance', () => {
  for (const [id, responseText] of Object.entries(offline.responses)) {
    assert.equal(accepts(id, responseText), true, id);
  }
});

test('STSS rejects an unrequested disclaimer', () => {
  const response = `${offline.responses['proposal-disclaimer-bad']} This result does not prove the approach works in every setting.`;
  assert.equal(accepts('proposal-disclaimer-bad', response), false);
});

test('STSS keeps an explicitly requested deployment limitation', () => {
  const response = 'In the 120-ticket pilot, 24-hour completion rose from 68% to 76%.';
  assert.equal(accepts('proposal-disclaimer-good', response), false);
});

test('STSS does not turn an observational result into causation', () => {
  const response = 'Automatic triage caused 24-hour completion to rise from 68% to 76%.';
  assert.equal(accepts('causal-boundary-bad', response), false);
});

test('STSS does not invent a number to repair a hollow claim', () => {
  const response = 'The mechanism reduced handling time by 37%, providing measured evidence.';
  assert.equal(accepts('hollow-claim-bad', response), false);
});

test('STSS metadata exposes the short invocation and examples', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'stss', 'SKILL.md'), 'utf8');
  const metadata = fs.readFileSync(path.join(root, 'skills', 'stss', 'agents', 'openai.yaml'), 'utf8');
  const examples = fs.readFileSync(path.join(root, 'skills', 'stss', 'references', 'examples.md'), 'utf8');

  assert.match(skill, /^name: stss$/m);
  assert.match(skill, /Sentence Consumer Test/);
  assert.match(skill, /Claim Ledger/);
  assert.match(skill, /Claim Diff|claim diff/i);
  assert.match(skill, /Do not classify text as AI-written/);
  assert.match(skill, /general style cleanup/);
  assert.match(metadata, /default_prompt: "Use \$stss /);
  assert.equal((examples.match(/^## \d+\./gm) || []).length, 6);
  assert.equal((examples.match(/^### Bad Case$/gm) || []).length, 6);
  assert.equal((examples.match(/^### Nearest Good Case$/gm) || []).length, 6);
  for (const [id, responseText] of Object.entries(offline.responses)) {
    assert.ok(
      normalizeWhitespace(examples).includes(normalizeWhitespace(responseText)),
      `examples must include the validated response for ${id}`
    );
  }
});

test('the READMEs preserve the Stop That Shit story and add 0.2.0 without replacing it', () => {
  const chinese = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const english = fs.readFileSync(path.join(root, 'README_EN.md'), 'utf8');
  const normalizedEnglish = normalizeWhitespace(english);

  assert.ok(chinese.indexOf('你只让 Agent 导出一个结果文件') < chinese.indexOf('## 0.2.0：从多做一步，到多说一句'));
  assert.ok(chinese.indexOf('## 0.2.0：从多做一步，到多说一句') < chinese.indexOf('## 快速安装'));
  assert.ok(chinese.indexOf('## 快速安装') < chinese.indexOf('## Bad Case / Good Case'));
  assert.ok(chinese.indexOf('## Bad Case / Good Case') < chinese.indexOf('## SHIT 是哪四种'));
  assert.ok(chinese.indexOf('## SHIT 是哪四种') < chinese.indexOf('## 为什么先拦 hash'));
  assert.match(chinese, /0\.1\.x 先处理 SHIT 的动作面/);
  assert.match(chinese, /一个没人读取的 checksum，和一句不改变任何决定的免责声明，都没有消费者/);
  assert.match(chinese, /Stop Ladder 继续判断一个动作该不该做/);
  assert.doesNotMatch(chinese, /不判断文字是不是 AI 写的/);
  assert.doesNotMatch(chinese, /不承诺.*去 AI 味/);
  assert.doesNotMatch(chinese, /免责声明关键词黑名单/);
  assert.match(chinese, /你只让 Agent 导出一个结果文件/);
  assert.match(chinese, /SHIT 是哪四种/);
  assert.match(chinese, /AI Agent Guard 现在能拦什么/);
  assert.match(chinese, /一起让 Agent 少造一点史/);
  assert.match(chinese, /别再浪费我的 Token/);
  assert.doesNotMatch(chinese, /真实限制不是废话/);
  assert.doesNotMatch(chinese, /0\.1\.1/);

  assert.ok(english.indexOf('You asked an agent for one output file') < english.indexOf('## 0.2.0: From one extra action to one extra sentence'));
  assert.ok(english.indexOf('## 0.2.0: From one extra action to one extra sentence') < english.indexOf('## Quick install'));
  assert.ok(english.indexOf('## Quick install') < english.indexOf('## Bad Case / Good Case'));
  assert.ok(english.indexOf('## Bad Case / Good Case') < english.indexOf('## What SHIT means'));
  assert.ok(english.indexOf('## What SHIT means') < english.indexOf('## Why hashing is blocked by default'));
  assert.match(english, /Version 0\.1\.x handles the action side of SHIT/);
  assert.match(english, /An unread checksum and a disclaimer that changes no decision have the same problem: neither has a consumer/);
  assert.match(english, /The Stop Ladder still asks whether an action should exist/);
  assert.doesNotMatch(english, /does not classify text as AI-written or promise to make prose sound human/);
  assert.doesNotMatch(english, /does not detect AI text or promise general humanization/);
  assert.doesNotMatch(english, /disclaimer keyword blacklist/);
  assert.match(english, /You asked an agent for one output file/);
  assert.match(english, /What SHIT means/);
  assert.match(english, /What the AI agent Guard stops/);
  assert.match(english, /Help coding agents stop at the boundary/);
  assert.match(english, /Stop spending my tokens/);
  assert.doesNotMatch(english, /Real limits are not waste/);
  assert.doesNotMatch(english, /0\.1\.1/);
  assert.ok(normalizedEnglish.includes(normalizeWhitespace(offline.responses['proposal-disclaimer-bad'])));
  assert.ok(normalizedEnglish.includes(normalizeWhitespace(offline.responses['hedge-stack-bad'])));
  assert.ok(normalizedEnglish.includes(normalizeWhitespace(offline.responses['proposal-disclaimer-good'])));
});
