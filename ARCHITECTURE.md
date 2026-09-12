# Architecture

The shared Skill starts with the task's responsibilities, chooses a direct
solution, and expands it only to close a concrete gap. It judges defenses by
their effect and finishes when the required result has sufficient evidence.
Necessary protection and complete delivery take priority over a smaller diff.

These semantic decisions belong in `skills/stop-that-shit/SKILL.md`. The Guard
checks explicit authority on supported action paths; it does not infer business
necessity from mechanism names. Updating the Skill does not change Guard policy.

Stop That Shit has a host-independent control core, five thin host adapters,
and a metadata-only runtime evidence sidecar.

```text
Codex Hook JSON       ----> Codex Adapter --------\
Claude Hook JSON      ----> Claude Adapter --------+--> ControlEvent v2
OpenCode hooks        ----> OpenCode Adapter -----+          |
Hermes native Plugin ----> Hermes CLI Adapter ----+          v
Pi Extension          ----> Pi Adapter -----------/  decision(contract, action)
                                                               |
                                  +----------------------------+------------------+
                                  v                                               v
                           host response                                  RuntimeEvent v1
```

- `src/decision.cjs` contains host-independent decisions.
- `src/contracts.cjs` parses the small prompt contract.
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
- `src/state.cjs` stores schema-4 per-session contract state and serializes the
  delegation ledger so concurrent Hook processes cannot oversubscribe the active
  agent limit. Contract updates share the reservation lock and cannot overwrite
  a concurrent launch. Watch-only delegations also reserve slots because the
  host is allowed to run them.
- `src/delegation-state.cjs` owns pure reservation transitions. `action.before`
  reserves active units; only a confirmed completion result releases
  them. Unknown results retain capacity; only confirmed bound-child completion
  or whole-call joined/not-started facts release it. Session-end alone is not proof. The ledger also keeps accepted action IDs and session-local
  agent stop/start metadata so retries, delayed duplicate starts, and stop-before-
  start events cannot charge or bind a later reservation; this metadata is not
  active usage or runtime audit data.
- `src/runtime-audit.cjs` appends and reads metadata-only decision events.
- `src/runtime-annotations.cjs` appends independent human labels.

## Host event boundaries

Codex maps `UserPromptSubmit` to `prompt.submit`, `PreToolUse` to
`action.before`, `PostToolUse` to `action.after`, and `SessionEnd` to `session.end`.
Its spawn result binds a child; confirmed wait results release it. Claude Code
uses its `Agent` tool's `tool_use_id` and completed result, and injects context
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
post_tool_call -> action.after
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

The OpenCode plugin can load from a local file or GitHub package and uses only
documented hooks: `message.part.updated` and session events through `event`, plus
`tool.execute.before` and `tool.execute.after`. It recovers user messages with
the SDK `client.session.message` call, injects contract context with
`client.session.prompt({ noReply: true })`, and maps child sessions to the root
contract so a subagent cannot silently replace user authority.

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
All contract and ledger writes use `updateSession`; reads have no write effect.
Each adapter declares its own lifecycle version. Core protocol imports cannot
substitute for that declaration; undeclared lifecycle events never change the ledger.
See HOST-ADAPTER-CONTRACT.md for actual host evidence and unsupported paths.
