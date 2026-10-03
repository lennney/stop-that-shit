# Architecture

The shared Skill starts with the task's responsibilities, chooses a direct
solution, and expands it only to close a concrete gap. It judges defenses by
their effect and finishes when the required result has sufficient evidence.
Necessary protection and complete delivery take priority over a smaller diff.

These semantic decisions belong in `skills/stop-that-shit/SKILL.md`. The Guard
checks explicit authority on supported action paths; it does not infer business
necessity from mechanism names. Updating the Skill does not change Guard policy.

Stop That Shit has a host-independent control core, six thin host adapters
in this candidate (including Oh My Pi), and a metadata-only runtime evidence sidecar.

```text
Codex Hook JSON       ----> Codex Adapter --------\
Claude Hook JSON      ----> Claude Adapter --------+--> ControlEvent v2
OpenCode hooks        ----> OpenCode Adapter -----+          |
Hermes native Plugin ----> Hermes CLI Adapter ----+          v
Pi Extension          ----> Pi Adapter -----------+  decision(contract, action)
OMP Extension         ----> OMP Adapter ----------/
                                                               |
                                  +----------------------------+------------------+
                                  v                                               v
                           host response                                  RuntimeEvent v1
```

- `src/decision.cjs` contains host-independent decisions.
- `src/contracts.cjs` owns contract values, defaults, legacy budget conversion,
  and prompt parsing. Saved-state loading reuses its contract normalization.
- `src/controller.cjs` stores the current contract and applies decisions.
- `src/adapters/codex-*.cjs` classify Codex events and render Codex responses.
- `src/adapters/claude-*.cjs` classify Claude Code events and render Claude Hook
  responses.
- `src/adapters/opencode-*.cjs` classify OpenCode messages and tool calls.
- `src/adapters/hermes-*.cjs` classify Hermes payloads and render Hermes
  responses; the installed bundle is `.hermes-plugin/runtime/stop-that-shit.cjs`.
- `src/adapters/pi-*.cjs` classify Pi Extension events and render Pi block or
  context results.
- `opencode/stop-that-shit.mjs` bridges the in-process OpenCode plugin hooks.
- `.hermes-plugin/__init__.py` is the only Hermes host entrypoint and bridges
  native Plugin callbacks to the bundled runtime.
- `pi/stop-that-shit.ts` is the Pi package entrypoint.
- `omp/stop-that-shit.ts` is the separate, unreleased Oh My Pi entrypoint.
  `src/adapters/omp-*.cjs` translate native events into the shared controller.
- `src/state-schema.cjs` validates and migrates saved state in memory. It owns
  the schema version, fresh state, and recovery defaults; it performs no I/O.
  Storage validation runs before normalization, so damaged current state is
  rejected instead of receiving permissive defaults.
- `src/state.cjs` reads and writes per-session contract state and serializes the
  delegation ledger so concurrent Hook processes cannot oversubscribe the active
  agent limit. Contract updates share the reservation lock and cannot overwrite
  a concurrent launch. Watch-only delegations also reserve slots because the
  host is allowed to run them. Each lock directory contains a unique owner
  marker. Acquisition verifies exclusive ownership before entering the critical
  section. Recovery checks each stale marker and removes it only after its
  process has exited, including markers left by interrupted contenders;
  age alone does not invalidate a live lock. Empty directories can be reclaimed,
  and delayed initializers must verify ownership again. Failed state writes
  remove their temporary file and leave the previous saved state intact.
  A stale legacy file lock without a valid owner is preserved and reported as
  `STS_LOCK_DAMAGED`. Both ordinary reads and locked updates enter in-memory
  read-only recovery, so an unsaved prompt cannot leave old write authority
  active. Recovery never persists a replacement contract or clears the ledger.
  See INSTALL.md for restarting with a new session or isolating the damaged
  lock after all processes that share its data directory have stopped.
- `src/delegation-state.cjs` owns pure reservation transitions. `action.before`
  reserves active units; only a confirmed completion result releases
  them. Unknown results retain capacity; only confirmed bound-child completion
  or whole-call joined/not-started facts release it. Session-end alone is not proof. The ledger also keeps accepted action IDs and session-local
  agent stop/start metadata so repeated lifecycle facts, delayed duplicate starts, and stop-before-
  start events cannot charge or bind a later reservation; this metadata is not
  active usage or runtime audit data.
- `src/runtime-audit.cjs` appends and reads metadata-only decision events.
- `src/runtime-annotations.cjs` appends independent human labels.

## Host event boundaries

Direct contract commands start the first non-empty line, outside quotes or code
blocks. Only that line's directive head sets fields; `--`, `: `, or a newline
starts task text. Unknown fields and conflicting values return an error without
partially updating the contract. Runtime queries and label commands follow the
same first-line boundary. This is syntax validation, not a general interpreter
of user intent. See [directive entry](INSTALL.md#directive-entry).

Codex maps `UserPromptSubmit` to `prompt.submit`, `PreToolUse` to
`action.before`, `PostToolUse` to `action.after`, and `SessionEnd` to `session.end`.
Its supported UUID spawn results bind a child; confirmed matching wait results
release it. The plugin does not register `SubagentStart` or `SubagentStop` for
Codex. Payloads from older configurations remain ignored.

Claude Code retains line boundaries when normalizing its native slash form.
It uses its `Agent` tool's `tool_use_id` and completed result, and injects context
on `SubagentStart`. Both hosts' `SubagentStop` events are stop attempts and do
not release reservations. Claude background work without a supported joined
result stays reserved. `UserPromptExpansion` remains an optional Claude prompt
surface. Prompt-capable hosts return a native prompt block for invalid legacy
or malformed directives. The controller retains the previous contract and the
error: Guard rejects later delegation until corrected, watch reports it, and
off allows the action. Work permitted by watch/off still reserves capacity.

Hermes native Plugin maps the following lifecycle events:

```text
pre_llm_call  -> prompt.submit  -> {"context":"..."} when context is returned
pre_tool_call -> action.before  -> {"action":"block","message":"..."} on denial
post_tool_call -> action.after (delegate_task results only)
subagent_start/subagent_stop -> subagent.start/subagent.stop
on_session_end -> session.end
```

The explicit Hermes tool table
covers `write_file`, `patch`, `delegate_task`, `read_file`, `search_files`,
`web_search`, `web_extract`, `vision_analyze`, `clarify`, and `todo`. `terminal`
reuses the existing shell classifier. `execute_code`, browser/computer-use,
memory, cron, Skill management, message sending, and all other unlisted
built-in/plugin/MCP tools remain `unknown`; an armed contract blocks unknown
mutability rather than guessing.

A Hermes `delegate_task` call reserves active agent slots by the number of child
agents it can start: one for a non-empty `goal`, or `tasks.length` for a batch.
The complete count is checked and reserved atomically before the tool runs; an
insufficient limit rejects the whole batch without consuming any units. A
confirmed synchronous completion releases active units; background or
unknown-status calls remain reserved until confirmed bound-child completion or a joined result.
`action=list`, `action=steer`, and `action=stop` are control operations and
consume zero budget units.

The OpenCode V1 adapter can load from a local file or GitHub package and uses only
documented hooks: `message.part.updated` and session events through `event`, plus
`tool.execute.before` and `tool.execute.after`. It recovers user messages with
the SDK `client.session.message` call, injects contract context with
`client.session.prompt({ noReply: true })`, and maps child sessions to the root
contract so a subagent cannot silently replace user authority.
Within its bounded message cache, V1 keeps first-delivery order across retries:
an earlier failed message cannot replace a newer processed root input. A retry
in another root session remains independent.
An embedded directive mention cannot arm the contract or trigger the plugin's
implicit promotion from review to an editable host mode. Separate text parts
are joined with newlines, so directive fields must stay in the first part's
first non-empty line.

The same package provides a V2 Effect adapter with native session context,
tool execution, and child lifecycle hooks. It reads delivered root user
messages and returns typed tool errors for denials. See the
[OpenCode mapping](HOST-ADAPTER-CONTRACT.md#opencode-mapping) for version and
tool-coverage boundaries.

Pi maps `input`, `before_agent_start`, `tool_call`, `tool_result`, and
`session_shutdown`. The first two arm and inject the shared contract;
`tool_call` is the deny-capable boundary; `tool_result` is the completion signal
for synchronous tools and carries observation-only context without blocking.
An explicitly background or otherwise unconfirmed subagent remains reserved
because the current Pi extension surface has no child-specific stop event;
`session_shutdown` alone does not clear these reservations. Mid-turn contract switches are
not applied to the active turn. The optional official `subagent` tool is budgeted
at its parent call, while cross-process contract inheritance remains outside the
supported boundary.

## Control and evidence boundaries

Control state and observed response remain deliberately separate:

```text
OFF        no checks and no normal-action events
OBSERVING  check and record; never return permission deny
ARMED      explicit task contract; may return permission deny

response: none | context_returned | permission_deny_returned | execution_denial_returned
host effect: unobserved
```

Installation defaults to `OBSERVING / unconfirmed`. An explicit task mode arms
the Guard; `watch` stays observing and `off` stops normal-action recording.

Hard decisions are limited to observable facts:

- writes in a confirmed non-mutating mode;
- writes outside an optional explicit `files=` list;
- covered dependency additions without authority;
- subagent launches beyond the active `agents=N` limit;
- high-confidence hashing without `hash=allow`.

Every observing or armed check is recorded even when the policy allows it, so
runtime totals retain a real checked-action denominator. Audit write failures
fail open and never change the control decision. The Skill handles broader
semantic judgment through the Stop Ladder. All adapters are guardrails, not
security sandboxes: specialized tool paths may bypass Hooks, and a deny
response does not prove the host prevented execution. Runtime `hostEffect`
remains `unobserved`.

## Hermes support matrix

| Surface | Status | Evidence boundary |
| --- | --- | --- |
| Hermes CLI + native Plugin | Supported and tested offline | Plugin package, adapter/controller, runtime, and concurrency fixtures. |
| Hermes Gateway | Reload after lifecycle changes | Run `hermes gateway restart` after enabling, disabling, updating, rolling back, or reinstalling the plugin. |
| cron, Kanban worker, ACP, Desktop, or non-dispatcher paths | Not supported or declared | No matching adapter contract or test. |

The Gateway restart is required after plugin lifecycle changes, not on every use.

## Lifecycle transitions

`delegation-state.cjs` hides transitions behind `inspectDelegation` and
`applyDelegationFact`. Requests specify bounded capacity and completion scope;
adapters report running, joined, not-started or unknown facts. Per-call
unresolved activity captures unbounded execution and unversioned resumes.
A known bounded call with an unknown result retains its existing capacity.
Only matching terminal evidence clears unresolved activity. Sequential chains
hold their capacity through individual step stops until the whole call joins.
Each delegation execution needs a new action ID within its source session.
Guard rejects a previously accepted ID, including after completion. Repeated
lifecycle notifications remain idempotent. After a repeated execution attempt,
`not_started` cannot release the original pending reservation; its whole-call
completion can. If watch/off permits both executions, their completion events
are ambiguous. That history remains unresolved until confirmed whole-session
completion or a new host session.
All contract and ledger writes use `updateSession`; reads have no write effect.
Each adapter declares its own lifecycle version. Core protocol imports cannot
substitute for that declaration; undeclared lifecycle events never change the ledger.
See HOST-ADAPTER-CONTRACT.md for actual host evidence and unsupported paths.

## Shared manifest facts and recovery

Adapters map native file and content fields into `src/manifest-dependencies.cjs`.
The helper recognizes dependency declarations in supported manifests. Patch
and replacement fragments resolve each line's declaration role in the old and
new sections before comparing them. Moving metadata into a dependency section
or replacing its header can introduce dependency intent. Unchanged declarations,
removals and newly appended empty tables remain permitted. Full writes supply
only new content, so this is intent detection, not a semantic dependency diff.
Fragments that omit their section may remain unrecognized.

A damaged control-state file is preserved. Current-schema contract and ledger
fields are validated before normalization; malformed counts cannot become free
capacity. The affected session enters read-only recovery and reports
`STATE_DAMAGED`; restore a known-good backup or start a new host
session. Runtime queries skip malformed records and count them as damaged.
Neither path clears unresolved delegation. Status includes effective constraints
and authority source. Denial details stay in the host response; audit records
retain metadata only.

OMP parent-link recovery uses the same controller decision, response formatting,
and audit path. Recovery state exists only in memory; neither the damaged link
nor a replacement session contract is written.
