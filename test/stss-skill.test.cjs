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

test('the README STSS example matches a validated offline response', () => {
  const english = fs.readFileSync(path.join(root, 'README_EN.md'), 'utf8');
  assert.ok(
    normalizeWhitespace(english).includes(normalizeWhitespace(offline.responses['hedge-stack-bad']))
  );
});
