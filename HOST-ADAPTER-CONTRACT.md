# Host Adapter Contract

Stop That Shit has four implemented host adapters: Codex, Claude Code,
OpenCode, and the Hermes Agent CLI native Plugin adapter. Each adapter translates
host input into the same `ControlEvent v1` and reuses the same contract parser,
controller, decisions, state, and runtime evidence.

An Adapter may reuse the decision module only if its host exposes:

1. a stable session identifier;
2. user prompts or explicit mode changes;
3. a before-action event that can actually deny an action;
4. tool name, input, and enough information to classify mutability.

Lifecycle context injection is optional. Codex deliberately keeps its original
two-event surface (`UserPromptSubmit` and `PreToolUse`); it does not require or
register a subagent-start Hook. Claude Code additionally uses `SessionStart`
and `SubagentStart` because those host events provide useful context without
changing the core policy. Direct Skill invocation is armed from
`UserPromptSubmit`, so it works even on hosts that do not expose the
`UserPromptExpansion` event; the adapter keeps its `UserPromptExpansion` handler
for hosts that register it.

The normalized event is versioned as `ControlEvent v1`:

```json
{
  "protocolVersion": 1,
  "kind": "action.before",
  "sessionId": "opaque",
  "action": {
    "name": "Edit",
    "mutability": "write",
    "affectedPaths": ["src/config.cjs"],
    "dependencyIntent": false,
    "hashIntent": false
  }
}
```

## Codex mapping

`src/adapters/codex-hooks.cjs` maps the existing Codex Hook JSON to
`ControlEvent v1`. The preserved Codex manifest points at
`hooks/codex-hooks.json`, so Claude support does not broaden the original Codex
Hook trust surface.

## Claude Code mapping

`src/adapters/claude-hooks.cjs` maps:

```text
SessionStart         -> session.start
UserPromptSubmit     -> prompt.submit (also the /stop-that-shit:stop-that-shit slash form)
PreToolUse            -> action.before
SubagentStart         -> subagent.start
UserPromptExpansion  -> prompt.submit (Stop That Shit Skill only; optional on hosts that expose it)
```

The Claude adapter returns a `PreToolUse` `permissionDecision: "deny"` when the
shared controller denies an action. `SubagentStart` is context-only; `agents=N`
is enforced before a Claude `Agent` tool runs, then the started subagent receives
the active contract as additional context.

The classifier covers Claude-native `Write`, `Edit`, `NotebookEdit`,
`EnterWorktree`, `Bash`, `PowerShell`, `Monitor`, `Agent`, current read tools,
and control/task tools. `Monitor` command sources reuse shell dependency/hash
classification; WebSocket monitors are read-only. `Workflow` is treated as
unbounded delegation and is denied by an armed Guard because its internal
subagent fan-out cannot be proven to satisfy `agents=N`. MCP/plugin tool names
fall back to the existing conservative name classifier. Explicit file locks
normalize POSIX and Windows absolute paths relative to Hook `cwd` when possible.

## OpenCode mapping

The OpenCode plugin uses the documented plugin surface only: the `event` hook
(`message.part.updated` plus `session.created`/`session.updated`/
`session.deleted`), `tool.execute.before`, and `tool.execute.after`. It does not
use the undocumented `chat.message` hook.

User text is recovered from a `message.part.updated` trigger through the
documented SDK call `client.session.message`, mapped to `prompt.submit`, and
`tool.execute.before` is mapped to `action.before`. A denied action throws
before the tool runs and records `execution_denial_returned`; Codex continues to
record `permission_deny_returned`. Watch-only context is appended to a
successful tool result through `tool.execute.after`.

Contract context is injected with the documented SDK call
`client.session.prompt({ noReply: true })` carrying a synthetic text part.
Synthetic and ignored parts never arm or change the contract, so injected
messages cannot feed back into contract parsing. Per-session processing is
serialized, and `tool.execute.before` waits for in-flight message processing
before it evaluates the contract.

An explicit host mode switch is treated as authorization. When a root-session
user message that is not a `$stop-that-shit` directive arrives under an
edit-capable agent (resolved through `client.app.agents()`; unknown agents fail
open) while the contract is `review`, the plugin advances the contract to
`change` with `source: host`, preserving file, dependency, and hash settings.
Explicit directives always win, read-only agents never advance, subagent
messages never advance the root contract, and the host permission layer
continues to apply independently.

OpenCode creates a new session identifier for each `task` subagent. The plugin
maps child sessions to the root session contract, does not parse child prompts
as new user authority, and treats a `task_id` continuation as control rather
than a new delegation. If ancestry cannot be resolved, it fails open without
treating the uncertain child prompt as user authority.

## Hermes Agent CLI

The Hermes adapter is implemented in `src/adapters/hermes-hooks.cjs` and
classifies tools in `src/adapters/hermes-tool-classifier.cjs`. The native Plugin
maps this deliberately small event surface:

```text
Hermes pre_llm_call  -> prompt.submit
Hermes pre_tool_call -> action.before
```

`pre_llm_call` maps `session_id` to `sessionId`,
`extra.user_message` to `prompt`, and `extra.turn_id` (or the available
top-level turn id) to `turnId`. A context result is rendered as
`{"context":"..."}`.

`pre_tool_call` maps the top-level `tool_name`, `tool_input`, `session_id`, and
`cwd` to `action.before`. A denied action is rendered as
`{"action":"block","message":"..."}`. Unknown events, empty payloads, and
non-applicable allow results produce no stdout and exit successfully.

The adapter does not register `subagent_start` or `subagent_stop`: those events
are observers and cannot provide the before-action budget denial required for
`agents=N`. Budget enforcement therefore occurs on the `delegate_task`
`pre_tool_call`.

### Explicit Hermes tool coverage

The first version uses an explicit, conservative table. An unlisted tool is not
silently promoted to a safe class merely because its name or input contains a
path.

| Class | Explicit coverage | Behavior |
| --- | --- | --- |
| `write` | `write_file`, `patch` | Extracts real targets for file locks; missing targets remain unproven. |
| `delegate` | `delegate_task` with one `goal` or a `tasks` batch | Reserves the number of child agents that will be started: one for `goal`, or `tasks.length` for a batch. The complete count is checked and reserved atomically before the tool runs. |
| `read` | `read_file`, `search_files`, `web_search`, `web_extract`, `vision_analyze` | Known read-only allowlist. |
| `control` | `clarify`, `todo`, and `delegate_task` with `action=list`, `action=steer`, or `action=stop` | Control operations; do not reserve `agents=N` units and are not repository writes. |
| shell-derived | `terminal` | Reuses the existing shell classifier: explicit reads are `read`, explicit writes are `write`, and unproven commands are `unknown`. |
| `unknown` | `execute_code`, browser/computer-use, memory, cron, Skill management, message sending, and every unlisted built-in, plugin, or MCP tool | Fail open before an explicit contract; under `review`/`answer`/`monitor`, block as `MUTABILITY_UNPROVEN`. |

`write_file` and `patch` provide affected paths from their actual input. V4A
patches include every Create/Update/Delete/Move target. Paths are normalized
relative to Hook `cwd` with POSIX and Windows absolute-path handling. The
adapter reuses the existing dependency/hash detectors and does not duplicate
core mode, hash, dependency, file-lock, or agent-budget decisions.

A Hermes `delegate_task` call containing `tasks=[...]` may start multiple child
units, but the current budget is charged **per `delegate_task` tool call**, not
per batch child. This limits the number of observed delegation calls; it does
not claim to limit the total number of real child tasks started inside one
batch. Charging each child would require a separately reviewed multi-unit
reservation in the core controller, not a loop in this adapter.

## Support matrix and evidence boundary

| Hermes surface | Status | Evidence and boundary |
| --- | --- | --- |
| Hermes CLI + native Plugin | Supported and tested offline | Real Hermes envelopes, adapter/controller cases, entrypoint wire tests, and parallel `agents=N` reservation tests. |
| Hermes Gateway | Reload after lifecycle changes | Run `hermes gateway restart` after enabling, disabling, updating, rolling back, or reinstalling the plugin; it is not required on every use. |
| cron, Kanban worker, ACP, Desktop, or paths bypassing the standard tool dispatcher | Not supported or declared | No adapter contract or matching test exists for these surfaces. |

Host-specific event names, tool classification, paths, and response JSON belong
inside the Adapter. Model identity is evaluation metadata, not a new Adapter.
The Adapter may report that it returned context or a host-specific denial, but it
must not claim that the host prevented execution through every other path.
`RuntimeEvent v1` therefore records `hostEffect` as `unobserved`.

All four adapters are guardrails, not sandboxes. Specialized tool paths can
bypass normal Hooks, and a returned `permission_deny_returned` or Hermes block
response is evidence of the adapter response—not proof that the host ultimately
did not execute the action.
