# Evidence

## Personal field observation

As of 2026-08-14, after using Stop That Shit locally, the maintainer has not
seen the unnecessary SHA-256 behavior recur. This is an anecdotal observation,
not a controlled benchmark or a claim about general model behavior.

The local Runtime now records metadata-only Hook checks and separates checked
actions, context responses, and permission denies. It records host effect as
`unobserved`; a returned permission deny is not evidence that the host skipped
the action.

Version: 0.1.0 First Multi-platform Release
Release: https://github.com/lennney/stop-that-shit/releases/tag/0.1.0
Previous release: https://github.com/lennney/stop-that-shit/releases/tag/0.0.3
Last updated: 2026-08-20

This tree is validated with deterministic Hook-schema simulations, real
child-process stdin/stdout entrypoint tests, cross-platform path regression
tests, and shared policy tests:

- 181/181 executed runtime/unit/integration tests pass, including the preserved
  Codex tests, Claude child-process Hook simulations, OpenCode adapter/plugin
  regressions, and Hermes native-plugin/runtime tests; one optional installed
  OpenCode smoke is skipped when OpenCode 1.18.18 or newer is unavailable;
- 18/18 executable Bad/Good policy case arms pass;
- Claude review-mode denial, namespaced slash-command arming, POSIX/Windows path
  normalization, `NotebookEdit`, `PowerShell`, `Monitor`, `EnterWorktree`, and
  `Workflow` fan-out handling have dedicated regressions;
- two independent Claude Hook processes cannot oversubscribe `agents=1`;
- all checked-in `.cjs` files pass `node --check`, all JSON files parse, and the
  release allowlist passes with 135 files;
- the generated CaseBundle validator and its schema were not changed;
- on a local Windows host, `claude plugin validate` reported no warnings and a
  live smoke session armed the Guard through both the `$stop-that-shit`
  directive and the namespaced slash form, with a covered write denied.

## Published technical preview

Verified locally:

- plugin and Skill validators pass;
- 92/92 automated unit, integration, privacy, CaseBundle, CLI, and rescore tests
  pass locally;
- 14/14 executable Bad/Good case arms pass;
- packaged Hook input/output works on Windows;
- review blocks covered writes and explicit change preserves the Good Case;
- optional file locks handle repository-relative and absolute patch paths;
- dependency authority, subagent budget, and high-confidence hash authority have
  paired allow/stop coverage;
- release allowlist excludes internal research, captured live runs, and private
  references.
- a fresh minimal live Codex smoke run kept `review` read-only and completed the
  paired one-line `change` with 1/1 focused test.
- Codex CLI `0.147.0` loaded the current two-event manifest in an isolated
  profile. The TUI reported one installed and active handler for
  `UserPromptSubmit` and `PreToolUse`, with zero handlers for every other event.
- the public paired-eval harness produces a fixed baseline/instruction/plugin
  plan over four Bad/Good families. The default command is dry-run only.
- every observing or armed before-action check produces a metadata-only local
  RuntimeEvent when storage is writable; damaged tail records are ignored and
  audit write failures do not alter Guard decisions;
- `status`, `runtime`, `explain`, and append-only human labels expose that local
  evidence without changing the active task contract;
- the four public families are validated `CaseBundle v1` directories, and
  archived results can be rescored without another model call.
- the 0.0.3 release candidate passed 92/92 automated tests, 14/14 executable
  policy case arms, the 101-file release allowlist, and an installed-cache Hook
  smoke before publication.

The current runtime stores active contract state plus metadata-only decision
events and independent annotations. It does not store prompts, tool inputs,
commands, path text, code, diffs, outputs, model responses, or raw session IDs.
It registers two Hook events: `UserPromptSubmit` and `PreToolUse`. It no longer
performs action fingerprinting, compaction checkpointing, automatic scope
discovery, or semantic compatibility/new-file guessing.

## Exact two-Hook candidate smoke

The installed candidate's `hooks.json` matched the working tree and contained
only `UserPromptSubmit` and `PreToolUse`.

Three fresh, single-seed smoke cells were run on disposable Git fixtures:

- Guard review: reported the defect and left the file unchanged;
- Guard change: changed only the requested file and passed the focused test;
- Skill with Hooks disabled: loaded the same Skill, changed only the requested
  file, and passed the focused test.

One Guard change process failed before a model session started while the local
Codex CLI was being updated. It is an infrastructure failure, not a product
result. The failed cell was retained locally and rerun after the CLI install
completed.

These smoke cells verify the two-Hook package and its no-Hook degradation path.
They do not show an improvement over baseline.

## Public 0.0.2 install acceptance

The immutable `0.0.2` tag points to commit
`a5c937045e8a8de75e897459e4ba5f6c2cc9ae81`. The plugin was reinstalled into a
dedicated Codex profile from that source. The installed plugin reported version
`0.0.2`, its runtime tree matched the tagged source byte-for-byte, and its
installed Hook returned `deny / I/MODE_FORBIDS_MUTATION` for `apply_patch` under
an explicit review contract.

This verifies installation integrity and the covered Hook response. It does not
prove that the host prevented the action, and it is not an effectiveness result
against baseline.

## Public 0.0.1 install acceptance

The published GitHub repository was installed into a fresh Codex profile using
the two README commands. The installed plugin reported version `0.0.1`.

- interactive Hook review showed only `UserPromptSubmit` and `PreToolUse` as
  installed and active;
- a live review reported the defect and left the fixture unchanged;
- the installed Guard returned `deny / I/MODE_FORBIDS_MUTATION` for a covered
  write under the review contract;
- a live change modified only the locked source file and passed the focused
  test;
- the Skill was installed separately from the public `0.0.1` tag, loaded with
  plugins and Hooks disabled, modified only the requested file, and passed the
  focused test;
- the documented plugin and marketplace removal commands completed and left no
  marketplace plugins in the isolated profile.

An initial Skill-only CLI attempt used an approval policy that left the fresh
profile read-only. Codex rejected both the edit and the test command. Re-running
with Codex workspace-write automatic approval passed. This confirms that the
Skill does not override host sandbox or approval policy.

## What the earlier live runs taught us

Exploratory Codex CLI `0.145.0` runs used `gpt-5.6-sol`, `medium` reasoning,
`workspace-write`, approval `never`, and independent Git fixtures.

Two direct plugin runs with a hand-written file list passed tests but left a
reachable development fixture stale. They are scored 0/2 complete, not as an
effectiveness win. A separate read-only discovery experiment found the omitted
fixture, but added time, concepts, and another failure mode. That workflow was
removed from the current product rather than promoted to the default.

The same experiments found an absolute-path false positive. The current Adapter
normalizes patch paths relative to Hook `cwd`, with regression coverage.

These runs informed the simplification. They are not live acceptance evidence
for every behavior of the current reduced package. After simplification, one
fresh `review`/`change` smoke pair passed on Codex CLI `0.145.0`; it verifies the
core mode switch only, not general effectiveness.

## Minimal Intent effect pilot

On 2026-08-13, a four-cell directional pilot used Codex CLI `0.147.0`,
`gpt-5.6-luna`, medium reasoning, `workspace-write`, approval `never`, and an
isolated profile containing the local `0.0.2` candidate. It ran the Intent
Bad/Good pair once under `baseline` and `plugin`. The source revision was dirty,
so the result is diagnostic and is not eligible for a published comparison.

All four cells passed deterministic task acceptance with no infrastructure
errors. The baseline already kept the Bad review read-only, so the plugin showed
no task-level improvement. Both Good cells completed the authorized edit, so
the plugin showed no Good Case regression. The paired result was two unchanged,
zero improved, and zero regressed comparisons.

The plugin Bad cell checked five actions and returned one permission deny for a
`Bash` action classified as `MUTABILITY_UNPROVEN`. The model response identified
that action as a test command, not an attempted edit. The plugin still completed
the review, but this deny is evidence of conservative review-mode behavior, not
evidence that an unauthorized mutation was prevented. The plugin Good cell
checked three actions and returned no denies.

This pilot verifies live interception plus task completion on one pair. It does
not demonstrate an effectiveness gain over baseline. No additional sessions
were run after the null result.

## Not yet verified

The following are explicit limitations, not 0.1.0 release blockers. The project
does not require a large benchmark to make a probabilistic mitigation claim.

- a multi-scenario live baseline/plugin matrix for the reduced candidate;
- interactive `/hooks` trust on a separate physical machine;
- live macOS and Linux Hook behavior beyond the automated CI matrix;
- several distinct community scenarios and multiple seeds;
- specialized tool paths that may bypass normal Hook coverage.

The upgraded paired-eval harness is available, but its 90-session default matrix
has not been run or published. A generated plan, RuntimeEvent count, or
permission-deny response is not effectiveness evidence. Host effect remains
`unobserved` until the task-level acceptance result is evaluated.

## Runtime-evidence diagnostic pilot

On 2026-08-13, a local diagnostic run used Codex CLI `0.147.0`,
`gpt-5.6-luna`, medium reasoning, `workspace-write`, approval `never`, and an
isolated Codex home. The source revision was dirty, so the run was never eligible
for a published comparison.

The requested `intent` family expanded to 18 cells because it contains both Bad
and Good cases. Ten cells completed before the run was terminated: three
baseline Bad, three instruction Bad, three plugin Bad, and one baseline Good.
The six Bad control cells and one Good control cell passed deterministic
acceptance. All three plugin cells were excluded as infrastructure failures:
the isolated profile loaded an older plugin cache without `RuntimeEvent v1`, and
each reported zero checked actions. Eight cells were not run. No effectiveness
comparison can be made from this run.

This failure produced two harness gates: live preflight now compares the
installed plugin runtime tree with the source tree byte-for-byte, and every paid
run requires a `--max-cells` hard cap. Model and reasoning effort are also pinned
and recorded. The stale cache was refreshed after the run, but no additional
model sessions were started.

## HERO-derived round 1

Three single-seed baseline/plugin pairs covered HERO H-001, E-003, and the H-003
Good Case. All six runs completed correctly; plugin runs introduced no Hook
blocks and preserved necessary hashing. Because every baseline was already
correct, the result is null-effect plus Good Case non-regression, not evidence
of improvement.

## Community reproduction screening

A synthetic candidate derived from a public endpoint/input scope-creep report
was run once per baseline/plugin arm. Both changed the same two necessary files,
passed the focused test, and added no abstraction, state, dependency, or mock
framework. The candidate is `not-reproduced` and is excluded from effectiveness
counts. Other strong public reports currently lack a sanitized repository or
exact task, so they remain `report-only` rather than being converted into more
leading synthetic fixtures.

## Claim rule

Do not claim that Stop That Shit solves overengineering across coding agents or
publish an improvement percentage from unit tests or this single scenario.

The defensible 0.1.0 claim is:

> In Codex, Claude Code, OpenCode, and Hermes Agent CLI, Stop That Shit provides
> a short on-demand decision ladder and enforces a few explicit task-authority
> rules on covered host action paths. Hermes 0.1.0 coverage is limited to the
> native Plugin callbacks `pre_llm_call` and `pre_tool_call`; Gateway support
> refers to the restart lifecycle after plugin changes, not coverage of every
> Hermes surface. It may reduce some forms of execution drift, but it does not
> guarantee an effect on stochastic model behavior.
