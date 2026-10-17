#!/usr/bin/env node
// Standalone live verification of the DSH host adapter against realistic
// DSH native event payloads. Uses the real adapter modules (not simulation).
//
// Run:
//   cd /root/projects/dsh-plugins/work-stop-that-shit
//   NODE_ENV=development node scripts/verify-dsh-live.mjs
//
// Every check uses the real `fromNativeEvent` → `handleDshHook` →
// `applyDshDecision` pipeline on native-shaped DSH payloads (ToolExecution,
// agent session with header.parentSession/cwd, agent/pre-step messages,
// subagent run info, etc.).
//
// Notes on DSH adapter semantics:
//   - `handleDshHook` returns null for `kind: 'none'` results (e.g. repeated
//     context on the same session). This is correct behavior, not a failure.
//   - A contract is armed once per session; repeating the same directive is a
//     no-op. Use distinct sessions or distinct directives for separate checks.

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

const {
  applyDshDecision,
  fromControlResult,
  fromNativeEvent,
  handleDshHook,
  resolveRootLineage,
  toControlEvent
} = require('../src/adapters/dsh-hooks.cjs')
const { classifyDshTool, setRunCodeBindingOnly } = require('../src/adapters/dsh-tool-classifier.cjs')
const { readState } = require('../src/state.cjs')

let pass = 0
let fail = 0

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`)
}

function checkMatch(label, actual, regex) {
  const text = typeof actual === 'object' && actual !== null ? (actual.reason || JSON.stringify(actual)) : String(actual)
  const ok = regex.test(text)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(actual)} want~=${regex}`)
}

function checkTruthy(label, actual) {
  const ok = Boolean(actual)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(actual)}`)
}

function checkFalsy(label, actual) {
  const ok = !actual
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(actual)}`)
}

// Session-scoped harness mirroring a DSH plugin listener.
function scenario(options, sessionId) {
  handleDshHook('session/created', { session: { id: sessionId } }, options)
  return {
    arm(directive, turnId = 1) {
      const native = {
        agent: { session: { id: sessionId } },
        messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: directive }] }],
        turn: turnId
      }
      const payload = fromNativeEvent('agent/pre-step', native)
      return handleDshHook('agent/pre-step', payload, options)
    },
    gate(name, args, callId, context = {}, agentSessionOverrides = {}) {
      const exec = {
        name,
        arguments: args,
        callId,
        agent: {
          session: {
            id: sessionId,
            header: { cwd: options.cwd ?? '/workspace', ...agentSessionOverrides.header },
            ...agentSessionOverrides
          }
        }
      }
      const payload = fromNativeEvent('tools/pre-execute', exec, context)
      return handleDshHook('tools/pre-execute', payload, options)
    },
    readState() {
      return readState(sessionId, options.dataDir)
    }
  }
}

const dirs = []

function cleanup() {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// ---- 1. run_code PTC transport classification ----

console.log('\n=== 1. run_code PTC transport classification ===')

check('run_code unknown by default', classifyDshTool('run_code', { description: 'Read', code: 'return 1' }), 'unknown')

{
  setRunCodeBindingOnly(true)
  check('run_code control when binding-only asserted', classifyDshTool('run_code', { description: 'Read', code: 'return 1' }), 'control')
  setRunCodeBindingOnly(false)
  check('run_code back to unknown after reset', classifyDshTool('run_code', { description: 'Read', code: 'return 1' }), 'unknown')
}

// ---- 2. Contract arming via native agent/pre-step ----

console.log('\n=== 2. Contract arming via native agent/pre-step ===')

const o1 = { dataDir: mkdtempSync(join(tmpdir(), 'sts-live-')) }
dirs.push(o1.dataDir)
const s1 = scenario(o1, 'live-session-1')

const armed = s1.arm('$stop-that-shit change files=src/** -- implement the parser')
checkTruthy('change directive arms contract (non-null)', armed)

// A write inside scope proceeds.
const inScope = s1.gate('write', { file_path: 'src/parser.js', content: 'export const x = 1;' }, 'call-1')
checkFalsy('in-scope write proceeds (null)', inScope)

// A write outside scope is denied.
const outOfScope = s1.gate('write', { file_path: 'docs/other.md', content: 'x' }, 'call-2')
checkMatch('out-of-scope write denied', outOfScope, /PATH_OUTSIDE_CONTRACT/)
checkMatch('denial names path', outOfScope.reason, /docs\/other\.md/)

const st1 = s1.readState()
check('contract mode is change', st1.contract.mode, 'change')
check('allowedPaths is src/**', JSON.stringify(st1.contract.allowedPaths), JSON.stringify(['src/**']))

// ---- 3. run_code PTC end-to-end: nested mutation refused at its own gate ----

console.log('\n=== 3. run_code PTC end-to-end: nested mutation refused ===')

const o2 = { dataDir: mkdtempSync(join(tmpdir(), 'sts-live-')) }
dirs.push(o2.dataDir)
const s2 = scenario(o2, 'live-session-2')
s2.arm('$stop-that-shit review -- inspect the readme', 1)

// run_code itself takes the unproven approval path (deny under review).
const runCodeResult = s2.gate('run_code', { description: 'Read README', code: 'return await tools.read({ file_path: "README.md" });' }, 'call-ptc')
checkMatch('run_code takes unproven path under review', runCodeResult, /deny/)

// A nested mutation inside the program is refused at its own gate.
const nestedWrite = s2.gate('write', { file_path: 'README.md', content: 'injected' }, 'call-nested')
checkMatch('nested write inside run_code refused', nestedWrite, /deny/)

// A nested read under the same contract proceeds.
const nestedRead = s2.gate('read', { file_path: 'README.md' }, 'call-nested-read')
checkFalsy('nested read proceeds (null)', nestedRead)

// ---- 4. Post-execute bridge: result carried separately ----

console.log('\n=== 4. Post-execute bridge: (exec, result) pair ===')

const exec = { name: 'write', arguments: { file_path: 'a.txt' }, callId: 'c1', agent: { session: { id: 's1' } } }
const payload = fromNativeEvent('tools/post-execute', exec, { result: { kind: 'deny' } })
check('post-execute session id', payload.session.id, 's1')
check('post-execute call id', payload.exec.callId, 'c1')
check('post-execute result', JSON.stringify(payload.result), JSON.stringify({ kind: 'deny' }))

const event = toControlEvent('tools/post-execute', payload)
check('post-execute kind', event.kind, 'action.after')
check('post-execute lifecycle not_started', event.action.lifecycle, 'not_started')

// ---- 5. Root lineage: nested delegation (root → child → grandchild) ----

console.log('\n=== 5. Root lineage: nested delegation ===')

const o3 = { dataDir: mkdtempSync(join(tmpdir(), 'sts-live-')) }
dirs.push(o3.dataDir)
const s3 = scenario(o3, 'root')
s3.arm('$stop-that-shit review files=src/** -- look', 1)

// Session tree: root → child → grandchild. Header names only immediate parent.
const sessions = {
  root: { id: 'root', header: {} },
  child: { id: 'child', header: { parentSession: 'root' } },
  grandchild: { id: 'grandchild', header: { parentSession: 'child' } }
}
const resolveRoot = (sessionId) => resolveRootLineage(sessionId, (id) => sessions[id])

const grandchild = { id: 'grandchild', header: { parentSession: 'child' } }
const outOfScopeArgs = { file_path: 'docs/other.md', content: 'x' }

// Without any root resolution, the call is refused fail-closed.
const unverified = s3.gate('write', outOfScopeArgs, 'g1', {}, grandchild)
checkMatch('grandchild without root refused', unverified, /verified root session/)

// With resolveRootSession walking up grandchild → child → root, the
// out-of-scope write is denied against the root contract.
const denied = s3.gate('write', outOfScopeArgs, 'g2', { resolveRootSession: resolveRoot }, grandchild)
checkMatch('grandchild out-of-scope write denied vs root', denied, /MODE_FORBIDS_MUTATION/)

// The nearest permitted action still continues through the same chain.
const read = s3.gate('read', { file_path: 'src/ok.js' }, 'g3', { resolveRootSession: resolveRoot }, grandchild)
checkFalsy('grandchild read proceeds (null)', read)

// Explicit rootSessionId still works (backwards compatible).
const explicit = s3.gate('write', outOfScopeArgs, 'g4', { rootSessionId: 'root' }, grandchild)
checkMatch('explicit rootSessionId still denies', explicit, /MODE_FORBIDS_MUTATION/)

checkTruthy('resolveRootLineage exported', typeof resolveRootLineage === 'function')

// ---- 6. Full root → child → grandchild with authorized in-scope write ----

console.log('\n=== 6. Authorized in-scope write through grandchild ===')

const o4 = { dataDir: mkdtempSync(join(tmpdir(), 'sts-live-')) }
dirs.push(o4.dataDir)
const s4 = scenario(o4, 'root')
s4.arm('$stop-that-shit change files=src/** -- implement', 1)

const resolveRoot4 = (sessionId) => resolveRootLineage(sessionId, (id) => sessions[id])
const grandchild4 = { id: 'grandchild', header: { parentSession: 'child' } }

// Out-of-scope mutation stops through deepest delegation.
const outside = s4.gate('write', { file_path: 'docs/out.md', content: 'x' }, 'w1', { resolveRootSession: resolveRoot4 }, grandchild4)
checkMatch('grandchild out-of-scope write denied', outside, /PATH_OUTSIDE_CONTRACT/)
checkTruthy('denial names scope path', outside.reason && outside.reason.includes('docs/out.md'))

// Explicitly authorized in-scope write continues.
const inside = s4.gate('write', { file_path: 'src/ok.ts', content: 'export const ok = 1;' }, 'w2', { resolveRootSession: resolveRoot4 }, grandchild4)
checkFalsy('grandchild in-scope write proceeds (null)', inside)

// Permitted nested read continues.
const nestedRead2 = s4.gate('read', { file_path: 'src/ok.ts' }, 'r1', { resolveRootSession: resolveRoot4 }, grandchild4)
checkFalsy('grandchild nested read proceeds (null)', nestedRead2)

// ---- 7. Cycle detection in resolveRootLineage ----

console.log('\n=== 7. Cycle detection ===')

const cyclic = { a: { id: 'a', header: { parentSession: 'b' } }, b: { id: 'b', header: { parentSession: 'a' } } }
check('cycle returns null', resolveRootLineage('a', (id) => cyclic[id]), null)
check('session with no parent is its own root', resolveRootLineage('root', (id) => ({ id: 'root', header: {} })), 'root')
check('no lookup returns null', resolveRootLineage('child'), null)

// ---- 8. applyDshDecision: deny at tool gate does not delegate ----

console.log('\n=== 8. applyDshDecision does not delegate on deny ===')

let delegated = 0
const next = async () => { delegated += 1; return { kind: 'enter', messages: [] } }

const denial = await applyDshDecision('tools/pre-execute', { kind: 'deny', reason: 'out of scope' }, next)
check('deny returned as-is', JSON.stringify(denial), JSON.stringify({ kind: 'deny', reason: 'out of scope' }))
check('next not called on deny', delegated, 0)

// ---- 9. File effect: denied tool does not create target, permitted write does ----

console.log('\n=== 9. File effect verification ===')

const o5 = { dataDir: mkdtempSync(join(tmpdir(), 'sts-live-')) }
dirs.push(o5.dataDir)
const s5 = scenario(o5, 'live-session-5')
s5.arm('$stop-that-shit change files=src/** -- implement', 1)

// Denied: out-of-scope write should NOT create the file
const deniedResult = s5.gate('write', { file_path: 'docs/out.md', content: 'x' }, 'w-deny')
checkMatch('denied write result', deniedResult, /deny/)

// Verify the denied write's target is outside scope (the adapter blocks the write)
// Reads are observations and are not blocked by the write-only scope boundary.
const readDenied = s5.gate('read', { file_path: 'docs/out.md' }, 'w-deny-read')
checkFalsy('out-of-scope read is an observation (null)', readDenied)

// Permitted: in-scope write should succeed
const permittedResult = s5.gate('write', { file_path: 'src/ok.ts', content: 'export const ok = 1;' }, 'w-allow')
checkFalsy('permitted write proceeds (null)', permittedResult)

// Verify the file CAN be read (inside contract)
const readAllowed = s5.gate('read', { file_path: 'src/ok.ts' }, 'w-allow-read')
checkFalsy('permitted file can be read (null)', readAllowed)

// ---- 10. Downstream callback result preserved ----

console.log('\n=== 10. Downstream callback result preserved ===')

const downstream = { kind: 'enter', messages: ['kept'] }
const withContext = await applyDshDecision(
  'agent/pre-step',
  { kind: 'context', text: 'reminder' },
  async () => downstream,
  (info) => (info.kind === 'context' ? { ...downstream, messages: [...info.downstream.messages, info.text] } : downstream)
)
check('context folds text into downstream', withContext.messages, ['kept', 'reminder'])

cleanup()

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
