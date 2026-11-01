const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { analyzeShell } = require(path.resolve(__dirname, '../../../../src/shell-analysis.cjs'));

test('Issue #117: Set-Content com texto literal diagnostico de pnpm/sha256 nao dispara intencao de dependencia ou hash', () => {
  // O que este teste executa:
  // Valida que comandos de escrita de arquivo com cmdlets como Set-Content
  // tratando strings de diagnostico (como 'pnpm install failed' ou 'sha256sum failed')
  // nao disparam dependencyIntent nem hashIntent indevidamente.
  const r1 = analyzeShell("Set-Content report.md 'pnpm install failed'");
  assert.equal(r1.mutability, 'write');
  assert.equal(r1.dependencyIntent, false, 'Set-Content com texto pnpm install nao deve disparar dependencyIntent');
  assert.equal(r1.hashIntent, false, 'Set-Content com texto pnpm install nao deve disparar hashIntent');

  const r2 = analyzeShell("Set-Content report.md 'sha256sum failed'");
  assert.equal(r2.mutability, 'write');
  assert.equal(r2.dependencyIntent, false);
  assert.equal(r2.hashIntent, false, 'Set-Content com texto sha256sum nao deve disparar hashIntent');
});

test('Issue #117: Comandos reais de dependencia como pnpm install --offline continuam disparando dependencyIntent', () => {
  // O que este teste executa:
  // Garante que a execucao real de gerenciadores de pacote (pnpm install --offline)
  // continue sendo devidamente interceptada pela politica de dependencias.
  const r = analyzeShell('pnpm install --offline');
  assert.equal(r.dependencyIntent, true, 'pnpm install real deve disparar dependencyIntent');
});

test('Issue #117: Comandos reais de hash continuam disparando hashIntent', () => {
  // O que este teste executa:
  // Garante que utilitarios reais de checksum (sha256sum, Get-FileHash) continuem
  // sendo interceptados pela politica de hash.
  const r = analyzeShell('sha256sum fixture.txt');
  assert.equal(r.hashIntent, true, 'sha256sum real deve disparar hashIntent');
});
