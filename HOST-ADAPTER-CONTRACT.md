# Host Adapter Contract

Stop That Shit has five implemented host adapters: Codex, Claude Code,
OpenCode, the Hermes Agent CLI native Plugin adapter, and Pi. Each adapter translates
host input into the same `ControlEvent v2` and reuses the same contract parser,
controller, decisions, state, and runtime evidence.

An Adapter may reuse the decision module only if its host exposes:

1. a stable session identifier;
2. user prompts or explicit mode changes;
3. a before-action event that can actually deny an action;
4. tool name, input, and enough information to classify mutability.

Lifecycle facts are separate from request parameters. `action.before` reserves
capacity before the host response. `action.after.lifecycle` is one of `running`,
`joined`, `not_started`, or `unknown`. Only a confirmed whole-call `joined` or
`not_started` releases the remaining call reservation. A confirmed individual
stop releases only a bound child; call-scoped chains hold their capacity until
joined. A session-end notification alone does not prove that children stopped.

`inspectDelegation` returns a reserved upper bound and unresolved reasons.
`applyDelegationFact` owns reservation, identity, terminal and uncertainty
transitions. Contract and lifecycle writes share `updateSession` and its lock.
Adapters never correlate by arrival order. OpenCode preserves source-session
identity when calls from several children use a shared root contract.

Each adapter independently declares `lifecycleVersion: 2` as a fixed value.
The core requires both this declaration and `protocolVersion: 2` before it
accepts lifecycle facts. Importing the runtime's protocol number alone cannot
identify an adapter: old adapters can inherit the new number while retaining
old stop-attempt behavior. Missing or unsupported lifecycle declarations use
the compatibility decision path, rather than throwing an operational error.

Under a finite limit, Guard returns `LIFECYCLE_PROTOCOL_REQUIRED` for delegation,
control, and unknown actions from an undeclared adapter. Ordinary prompts,
reads, and writes remain compatible. Legacy activity permitted while observing
or off leaves unresolved history. Undeclared completion, binding, child-stop
and session-end events do not change the ledger, including `completed: true`.
Upgrade adapters and core together; history already lost during a mixed install
cannot be reconstructed, so use a new session for a finite guarantee.

The normalized event is versioned as `ControlEvent v2`:

```json
{
  "protocolVersion": 2,
  "lifecycleVersion": 2,
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

## Ownership and native capability reuse

The host owns execution and its system permissions. STS owns the additional
constraints of the user's task. An STS pass means that it adds no restriction;
the action still has to satisfy host permissions. The Codex adapter returns no
permission override for a pass.

| Responsibility | Owner | STS boundary |
| --- | --- | --- |
| Process execution, filesystem and network isolation | Host | Use native enforcement. STS path checks express task scope; they do not implement a sandbox. |
| Permission prompts, plugin trust and installation | Host | Use supported host flows. Do not change global settings to make a task pass. |
| Hook matching, process launch and timeouts | Host | Configure the needed events and supported budgets. Keep only necessary STS work in each handler. |
| Task mode, file scope, hash/dependency authority and task delegation budget | STS | Parse explicit directives, preserve corrections and explain decisions. A host permission grant does not create task authority. |
| Tool identity and event translation | Adapter | Preserve raw names and map verified host operations to shared facts. Do not infer identity from arbitrary prefixes. |
| Shell structure | Callable host interface or an appropriate parser | Verify access and coverage before reuse. STS applies task semantics to supported facts; unknown command structure must not become read-only through a partial match. |
| Agent creation, restart, interruption and native concurrency control | Host | Track additional task reservations from correlated host facts. STS does not schedule or terminate agents itself. |
| Task decisions and explanations | STS | Extend the existing status, runtime and explain surfaces. Keep audit data limited to metadata and distinguish responses from observed effects. |

Before replacing STS behavior with a native capability, establish:

1. The interface is callable from the installed integration, not only used
   inside the host or exposed to a separate client.
2. Its semantics cover the required actions and state transitions.
3. It operates at the intended task scope without changing other sessions.
4. The installed version demonstrates the expected result and failure behavior.

If native behavior covers the requirement, keep only the adapter and the
remaining task-specific logic. If it covers part, document that part. Missing
host facts remain unknown; local identifiers and timers cannot replace them.

### Codex reuse limits

Codex documents native filesystem/network permissions, hook matchers and a
spawned-thread concurrency setting. See [permissions](https://learn.chatgpt.com/docs/permissions),
[hooks](https://learn.chatgpt.com/docs/hooks) and the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The current configuration reference names the limit
`agents.max_concurrent_threads_per_session`, with `agents.max_threads` as a
legacy alias. It counts concurrently open spawned threads, excluding the primary
thread. STS `agents=N` counts reserved task capacity, including uncertain work.
These are different contracts. Native limits, zero, restarts and task-local
updates need equivalent-behavior evidence before replacing STS accounting.

A normal Hook does not select the active thread's permissions or agent limit.
App-server client settings are a separate integration surface; their existence
does not give an installed plugin control of its current thread. STS must not
edit shared Codex configuration to emulate a per-task directive.

Codex's documented `PreToolUse` does not support `permissionDecision: "ask"`.
The current adapter maps a decision that needs renewed task authority to a
supported denial and explanation. It does not claim to open a native approval
dialog. A later corrected directive can supply the missing task authority.

## Codex mapping

The shared parser accepts one directive at the start of the first non-empty
line, outside quotes and code blocks. Formal directive parsing does not scan
later text for fields.
Fields stay on that line before `--` or `: `. Unknown fields and conflicting
values leave the previous contract unchanged and report an error. Runtime
queries and labels use the same entry boundary.

Natural-language corrections skip fenced and indented code, inline code,
explicit Markdown quote lines, and quoted strings. This is a bounded text
filter, not a full Markdown parser. It preserves actual corrections in prose:
documenting `review only` leaves an edit task unchanged, while a direct request
to review without editing still selects review.

The Codex adapter binds UUID-based `spawn_agent` results `{agent_id, nickname}`
to the originating call. JSON objects and serialized JSON results are accepted.
`wait_agent` releases only requested UUID targets reported as completed or shut
down. The adapter also recognizes the exact names `multi_agent_v1wait_agent`,
`multi_agent_v1send_input`, `multi_agent_v1resume_agent`, and
`multi_agent_v1close_agent` emitted by namespaced v1 tools. Codex still reports
their spawn tool as `spawn_agent`. See the pinned [hook dispatch code](https://github.com/openai/codex/blob/b0af519c39766c173191fc39b341808619b51c74/codex-rs/core/src/tools/registry.rs)
and [tool-name flattening](https://github.com/openai/codex/blob/b0af519c39766c173191fc39b341808619b51c74/codex-rs/core/src/tools/mod.rs).

Codex desktop `0.154.0-alpha.6.2` uses a `collaboration` namespace. Its hook
names concatenate that prefix and the tool name, for example
`collaborationspawn_agent`, `collaborationfollowup_task`, and
`collaborationlist_agents`. The adapter maps the six known collaboration tools
to their short names before classification and lifecycle handling. It does not
strip arbitrary prefixes from third-party tools.

MultiAgentV2 returns `{task_name, nickname?}` from `spawn_agent` and
`{message, timed_out}` from `wait_agent`. The wait reports mailbox activity, not
completion. The adapter retains these spawn reservations because it cannot bind
them to a UUID. A path-only `list_agents` snapshot does not release them. Finite
`agents=N` capacity can therefore remain occupied after v2 work completes.
This is a compatibility limit; do not use path order or mailbox text to infer
completion. See the pinned [v2 tool implementation](https://github.com/openai/codex/tree/b0af519c39766c173191fc39b341808619b51c74/codex-rs/core/src/tools/handlers/multi_agents_v2).

Path aliases, errored statuses, and `close_agent.previous_status` do not prove
terminal execution. `SubagentStart` and `SubagentStop` are not registered;
payloads from older configurations remain ignored. `SubagentStop` is a stop
attempt that other hooks can continue.
Finite Guard rejects `send_input`, `resume_agent`, and v2 `followup_task` because
the host does not identify each restarted run in its completion results.
V2 `send_message` queues a message without starting a turn and does not enter
this restart gate. Watch mode reports restart uncertainty without denying the
call; that uncertainty persists if a later directive sets a finite Guard limit.

`interrupt_agent` and `close_agent` are control operations and remain available
in review mode. Their previous-status responses do not release reservations.
The native `PostToolUse` matcher selects only spawn and wait results, including
the supported namespaced names and the `Agent` alias. Ordinary tool results do
not launch that hook. The adapter also ignores ordinary results from older
configurations. Waits without supported completion facts do not enter the state
writer. Spawn results still record missing completion evidence, and proven UUID
wait results still update reservations under the lock.

Audit records use the same requested delegation count as admission decisions.
A rejected single-agent request records one requested unit and zero newly
reserved units; it does not report that an agent ran.

### Session end

Ordinary session end reads existing state without taking
a writer lock or releasing reservations. Session exit alone does not prove that
delegated work completed. An explicit `allDelegationsStopped` fact still follows
the existing locked update path.

## Claude Code mapping

`src/adapters/claude-hooks.cjs` maps:

```text
SessionStart         -> session.start
UserPromptSubmit     -> prompt.submit (also the /stop-that-shit:stop-that-shit slash form)
PreToolUse            -> action.before
SubagentStart         -> subagent.start
SubagentStop          -> ignored (a stop attempt can be continued by other hooks)
PostToolUse           -> action.after (by tool_use_id)
PermissionDenied      -> action.after / not_started (auto mode only)
PostToolUseFailure    -> action.after / unknown
SessionEnd            -> session.end
UserPromptExpansion  -> prompt.submit (Stop That Shit Skill only; optional on hosts that expose it)
```

Direct slash normalization preserves code indentation and newline boundaries.
It does not turn a quoted or indented slash example into a contract command.

The Claude adapter returns a `PreToolUse` `permissionDecision: "deny"` when the
shared controller denies an action. `agents=N` is enforced before a Claude
`Agent` tool runs. Its `PostToolUse` payload joins the real `tool_use_id` to the
returned `tool_response.agentId`; `status: "completed"` releases the activity,
while `status: "async_launched"` keeps it reserved. `SubagentStart` uses the
host-provided `agent_id`; the adapter does not require or invent a
`reservation_id`. A later `SubagentStop` alone cannot reclaim background
capacity: another hook can block that stop and continue the agent. This adapter
has no verified automatic terminal signal for that background path. Use a new
session for a finite limit when no supported joined result is available.

Under a finite `agents=N` limit, Guard denies `SendMessage` with
`DELEGATION_LIFECYCLE_UNPROVEN`. This tool can wake a stopped agent, but its
stop events do not identify the run. A delayed stop from a previous run cannot
safely release a new run's slot. Use a new `Agent` call instead. Without a
finite limit, messaging is unchanged; watch reports this boundary without denial.

The classifier covers Claude-native `Write`, `Edit`, `NotebookEdit`,
`EnterWorktree`, `Bash`, `PowerShell`, `Monitor`, `Agent`, current read tools,
and control/task tools. `Monitor` command sources reuse shell dependency/hash
classification; WebSocket monitors are read-only. `Workflow` is treated as
unbounded delegation and is denied by an armed Guard because its internal
subagent fan-out cannot be proven to satisfy the configured agent limits.
MCP/plugin tool names
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

The existing host-mode path treats editable-agent messages as authorization.
When a root-session user message containing no `$stop-that-shit` mention arrives
under an edit-capable agent (resolved through `client.app.agents()`; unknown agents fail
open) while the contract is `review`, the plugin advances the contract to
`change` with `source: host`, preserving file, dependency, and hash settings.
Quoted and embedded mentions suppress that promotion without becoming direct
authorization. Multipart text is joined with newlines; later parts cannot add
directive fields to the first line. Explicit directives always win. Read-only
agents and subagent messages never advance the root contract. The host permission layer
continues to apply independently.

An invalid directive adds error context and preserves the previous contract.
The event callback cannot reject a user turn, so `tool.execute.before` throws
the directive error until a corrected instruction clears it. This also applies
after reload, to child-session calls, and when context injection fails. Pending
errors prevent implicit editable-agent promotion. This input pause is separate
from shared Guard policy and applies even if the previous level was watch/off;
a valid watch/off directive clears it. Input pauses do not create shared
policy-denial audit events.

OpenCode creates a new session identifier for each `task` subagent. The plugin
maps child sessions to the root session contract. A task
`tool.execute.before` reserves its child count and `tool.execute.after` emits
`action.after` with the tool's explicit action ID. The adapter reads
`output.metadata.sessionId` to bind the child and `output.metadata.background`
to retain background activity, including foreground calls promoted to background.
A joined task result releases the slot. A terminal
child session update or documented `session.idle`/idle `session.status` event
emits `subagent.stop` when the child was explicitly associated. Deleting the
root session emits `session.end`, while deleting a child never clears the root
reservation. The plugin does not parse child
prompts as new user authority. Under a finite limit, Guard denies `task_id`
continuations because a reused child session ID does not identify its run.
Use a new task call instead. Without a finite limit, continuations are unchanged.
If ancestry cannot be resolved, it fails open
without treating the uncertain child prompt as user authority.

## Hermes Agent CLI

The Hermes adapter is implemented in `src/adapters/hermes-hooks.cjs` and
classifies tools in `src/adapters/hermes-tool-classifier.cjs`. The native Plugin
maps this deliberately small event surface:

```text
Hermes pre_llm_call  -> prompt.submit
Hermes pre_tool_call -> action.before
Hermes post_tool_call -> action.after
Hermes subagent_start/subagent_stop -> subagent.start/subagent.stop
Hermes on_session_end -> session.end
```

`pre_llm_call` maps `session_id` to `sessionId`,
`extra.user_message` to `prompt`, and `extra.turn_id` (or the available
top-level turn id) to `turnId`. A context result is rendered as
`{"context":"..."}`.

`pre_tool_call` maps the top-level `tool_name`, `tool_input`, `session_id`, and
`cwd` to `action.before`. A denied action is rendered as
`{"action":"block","message":"..."}`. Unknown events, empty payloads, and
non-applicable allow results produce no stdout and exit successfully.

An invalid directive returns error context from `pre_llm_call`; it does not
abort the model call. Until a corrected instruction clears the error,
`pre_tool_call` returns a block response, including after a runtime restart.
As with OpenCode, this is input rejection, independent of the previous
watch/off level, and does not create shared policy-denial audit events.

The adapter reserves the complete `delegate_task` batch. Its serialized JSON
result identifies a background dispatch through `status: dispatched`,
`mode: background`, and `subagent_ids`. Start events map these aliases to
`child_session_id`; later results or starts can complete the association.
Only completed/failed/error child-stop statuses release bound children. Timeout and
interrupted statuses can occur while a worker is still alive and retain capacity.
A synchronous result joins the batch only when all result entries are completed,
failed or error. A failed result here means the child returned and was cleaned up,
including provider rejection or invalid final output. Unknown result shapes and
session-end notifications retain capacity.
No fabricated `reservation_id` is required or accepted from Hermes lifecycle
hooks. The generated runtime ships together with the adapter.

### Explicit Hermes tool coverage

The first version uses an explicit, conservative table. An unlisted tool is not
silently promoted to a safe class merely because its name or input contains a
path.

| Class | Explicit coverage | Behavior |
| --- | --- | --- |
| `write` | `write_file`, `patch` | Extracts real targets for file locks; missing targets remain unproven. |
| `delegate` | `delegate_task` with one `goal` or a `tasks` batch | Reserves the number of child agents that will be started: one for `goal`, or `tasks.length` for a batch. The complete count is checked and reserved atomically before the tool runs. |
| `read` | `read_file`, `search_files`, `web_search`, `web_extract`, `vision_analyze` | Known read-only allowlist. |
| `control` | `clarify`, `todo`, and `delegate_task` with `action=list`, `action=steer`, or `action=stop` | Control operations; do not reserve agent-limit units and are not repository writes. |
| shell-derived | `terminal` | Reuses the existing shell classifier: explicit reads are `read`, explicit writes are `write`, and unproven commands are `unknown`. |
| `unknown` | `execute_code`, browser/computer-use, memory, cron, Skill management, message sending, and every unlisted built-in, plugin, or MCP tool | Fail open before an explicit contract; under `review`/`answer`/`monitor`, block as `MUTABILITY_UNPROVEN`. |

`write_file` and `patch` provide affected paths from their actual input. V4A
patches include every Create/Update/Delete/Move target. Paths are normalized
relative to Hook `cwd` with POSIX and Windows absolute-path handling. The
adapter reuses the existing dependency/hash detectors and does not duplicate
core mode, hash, dependency, file-lock, or agent-budget decisions.

A Hermes `delegate_task` call accepts a task array or its JSON string form.
A non-empty batch reserves its length; an empty array falls back to the single
`goal`, matching the host normalizer. The complete count is checked before
execution, including when `agents=0`.

## Pi

The Pi package entrypoint is `pi/stop-that-shit.ts`. It is tested against
`@earendil-works/pi-coding-agent` `0.84.4` and maps this extension surface:

```text
input               -> prompt.submit
before_agent_start  -> contract context message
tool_call            -> action.before -> { block: true, reason } on denial
tool_result          -> action.after plus watch-only context appended to the tool result
session_shutdown     -> session.end
```

The Adapter takes the stable session ID from Pi's session manager, preserves
`toolCallId` as the action ID, and maps `cwd`, structured tool input, `mode`
(`tui`, `rpc`, `json`, or `print`), and `hasUI` into the shared event. The same
decision path is used in UI and headless modes; notifications are UI-only.

`input` accepts both `$stop-that-shit` and Pi's native
`/skill:stop-that-shit` form. Input whose source is `extension` never creates
user authority. Pi can receive queued input while an Agent turn is streaming;
contract changes in that state are handled without changing the active
contract and must be submitted again after Pi is idle.

Invalid directives return `action: handled` from `input`, so that input does
not start a model turn. A visible custom message reports the error in UI and
headless sessions without triggering a turn. If delivery fails, the adapter
tries a UI notification and still returns handled. The previous contract is
unchanged; a corrected directive can start the next turn normally.

The explicit Pi table covers `read`, `grep`, `find`, `ls`, `write`, `edit`,
`bash`, and `powershell`. Every unlisted custom or package tool remains
`unknown`. The optional official `subagent` example is recognized only through
its documented single, `tasks`, and `chain` input shapes. The parent tool call
reserves the concurrent count atomically: one slot for a single task or a
sequential `chain`, and `tasks.length` for a parallel batch. Pi retains the
reservation by `toolCallId` until the official tool's `tool_result` confirms
that its children have joined, including failed children. An explicit background or
unknown-status result remains active because the current Pi extension API does
not expose a child-specific stop event. `session_shutdown` alone does not
confirm that such custom child work ended. Separate child Pi processes do not inherit the parent contract through
a proven standard ancestry channel.
Pi's user-initiated `!` and `!!` shell paths are outside the Agent `tool_call`
surface.

Pi operational adapter errors are caught so they retain the shared fail-open
behavior. Only a shared policy denial returns Pi's `block`; `terminate` is
omitted so the Agent can recover with an in-scope action.

## Shared shell classification

Codex Rules evaluate argument prefixes and the host execution path can parse
supported shell chains. That does not make `codex execpolicy check` a complete
shell parser for the plugin. Reuse requires a verified callable interface;
otherwise use bounded analysis and retain unknown results. See [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules).
The shared classifier analyzes a bounded static grammar. It does not expose
or duplicate the host's complete shell parser.

The shared shell classifier examines each command in a static chain before
classifying the whole call. Every command must be a supported read to return
`read`; a known write returns `write`, and otherwise the result is `unknown`.
It recognizes literal quoted arguments and simple `;`, newline, `&&`, `||` and
pipe separators. Quoted command examples remain data. Expansions, script blocks,
unproven shell wrappers, ambiguous escapes and incomplete syntax remain unknown.
This intentionally limited grammar applies without guessing the user's shell.
PowerShell's seven non-ASCII quote characters remain unknown where they can
open or close a string. An unquoted backslash also remains unknown because
Bash removes it before ordinary characters. Quoted Windows paths remain usable.

Embedded double quotes and doubled double quotes can become new arguments
under legacy PowerShell native argument passing. Such native program calls
remain unknown. Known PowerShell read cmdlets receive their literal arguments
directly, so their quoted searches remain available.
Legacy PowerShell also drops empty native arguments. Calls with empty arguments
must be reads both with the arguments preserved and with them removed. This
keeps harmless empty searches available while checking for newly exposed options.

Executable names must match supported commands; an argument containing
`git status` does not make an unknown program read-only. Git `-C` and
`--no-pager` preserve supported query classification. Branch mutations,
`git restore` and Git output-file options cannot pass review as reads.
Ripgrep `--pre` and `--hostname-bin` executable options remain unknown. Option
values and operands after `--` remain data, including literal option names.
Native sandbox and permission controls remain responsible for execution,
including programs' configured
behavior and unsupported invocation forms.
Git branch classification keeps argument boundaries and accepts only supported
query options. Unknown negations and abbreviations cannot borrow an earlier
`--list`. Values passed to `--format` remain data; arguments after `--` are
operands, including paths that happen to start with `--output=`.
Supported Git queries consume required option values before recognizing `--`
as an option terminator. For example, `--word-diff-regex --` consumes a regex;
it cannot hide a later `--output`. Unknown query options remain unknown, and
optional values must use their attached form.

Shell hash and dependency checks reuse this command analysis. Arguments to
proven reads are data, so searching for `npm install` or `Get-FileHash` does not
request those operations. Each command in a chain is checked separately; an
actual installation or hash operation keeps its existing authorization check.
Unproven shell syntax retains the conservative text checks.

Each adapter obtains mutability, hash/dependency intent, and affected paths from
one analysis entry point. Ordinary shell inputs are parsed once per action;
legacy individual classifier exports remain available. Host-specific input and
path normalization are preserved.
The optional `analysisReason` identifies a fixed classification cause, such as
an executable option or ambiguous native arguments. It adds detail to existing
denial messages and `explain` without changing authorization. Runtime records
store the reason code, not command text or argument values.

## Support matrix and evidence boundary

| Hermes surface | Status | Evidence and boundary |
| --- | --- | --- |
| Hermes CLI + native Plugin | Supported and tested offline | Real Hermes envelopes, adapter/controller cases, lifecycle entrypoint tests, and parallel active-reservation tests. |
| Hermes Gateway | Reload after lifecycle changes | Run `hermes gateway restart` after enabling, disabling, updating, rolling back, or reinstalling the plugin; it is not required on every use. |
| cron, Kanban worker, ACP, Desktop, or paths bypassing the standard tool dispatcher | Not supported or declared | No adapter contract or matching test exists for these surfaces. |

Host-specific event names, tool classification, paths, and response JSON belong
inside the Adapter. Model identity is evaluation metadata, not a new Adapter.
The Adapter may report that it returned context or a host-specific denial, but it
must not claim that the host prevented execution through every other path.
`RuntimeEvent v1` therefore records `hostEffect` as `unobserved`.

All five adapters are guardrails, not sandboxes. Specialized tool paths can
bypass normal Hooks, and a returned `permission_deny_returned` or Hermes block
response is evidence of the adapter response—not proof that the host ultimately
did not execute the action.

### Accounting after uncertain activity

Each permitted unbounded or unversioned resume call gets its own unresolved
entry. Later finite Guard delegation returns `DELEGATION_STATE_UNPROVEN`.
Confirmed whole-call joined/not-started evidence clears only that call's entry;
an unversioned old stop does not. If the host cannot provide sufficient evidence,
a new host session is needed for a finite guarantee. A bounded call with an
unknown result simply retains its original reservation. Reads, status collection,
and stop requests continue under their existing policies; a control operation
that can start work still requires delegation admission.

Schema 4 preserves budgets including zero, reservations and deduplication.
Every existing pre-v4 session has unverified history, including an empty ledger:
older versions could already have discarded running work. It remains usable for
ordinary work, but a new session is needed for a finite delegation guarantee.
Reads normalize in memory; the next locked mutation persists it. Runtime records report
`reservedUpperBound` and `countUnproven`, not a measured live-process count.

Host evidence: [Claude failure and permission events](https://code.claude.com/docs/en/hooks),
[Codex multi-agent handlers](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools/handlers/multi_agents),
[Hermes child execution](https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool_child_run.py).
These mappings have offline replay coverage; they do not establish installed-host
end-to-end behavior or model improvement.
