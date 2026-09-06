<p align="center">
  <img src="assets/stop-stamp.svg" alt="Stop That Shit red STOP stamp for an AI coding agent task-boundary Guard" width="240">
</p>

<h1 align="center">Stop That Shit（别再造史了）</h1>

<p align="center">
  <a href="https://github.com/lennney/stop-that-shit/releases"><img src="https://img.shields.io/github/v/release/lennney/stop-that-shit?include_prereleases&sort=semver&style=flat-square&color=111111&label=release" alt="Latest release"></a>
  <a href="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/lennney/stop-that-shit/ci.yml?branch=main&style=flat-square&label=build" alt="Build status"></a>
  <img src="https://img.shields.io/github/license/lennney/stop-that-shit?style=flat-square&color=111111" alt="MIT license">
</p>

<p align="center">
  <strong>You asked an agent for one output file. It also generated a SHA-256 checksum that no later command reads. Stop That Shit.</strong><br>
  Stops unrequested defensive work and task-boundary drift invented by AI coding agents.<br>
  Supports <a href="INSTALL.md#codex-skill--guard">Codex</a>, <a href="INSTALL.md#claude-code-skill--guard">Claude Code</a>, <a href="INSTALL.md#opencode-install-from-github">OpenCode</a>, <a href="INSTALL.md#hermes-agent-cli">Hermes Agent CLI</a>, and <a href="INSTALL.md#pi-coding-agent">Pi</a>.<br>
  <a href="#quick-install">Install</a> ·
  <a href="#bad-case--good-case">Bad / Good Case</a> ·
  <a href="cases/README.md">Cases</a> ·
  <a href="#release-021">0.2.1</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="README.md">中文</a> ·
  <a href="https://linux.do">LINUX DO Community</a>
</p>

The checksum gets generated, but it saves no work and leaves the rest of the task
unchanged. On another task, the extra work might be a guard, a compatibility
layer, a full test run, or another process step. Codex, Claude Code, OpenCode, Hermes Agent CLI, and Pi
can all do this: each step sounds reasonable on its own, but the user did not ask
for it and the task does not need it.

I tried adding “do not edit,” “do not overengineer,” and “ask before doing extra
work” to `AGENTS.md`. The file kept growing. Stop That Shit turns those checkable
boundaries into a Skill and an executable Guard.

You choose a mode such as `review` or `change`, then add file, dependency, hash,
or subagent limits when the task needs them. Stop That Shit checks those explicit
boundaries on covered Hook paths. The agent still reads the repository and
follows necessary consequences. When the Guard can prove that an action crossed
the boundary, it returns a red stamp:

```text
STOP / INTENT
Guard returned permission deny.
Reason: MODE_FORBIDS_MUTATION
State: ARMED / review
Event: evt_...
```

<a id="release-021"></a>

## 0.2.1: Scoped Guard false-allow fixes

`0.2.1` is a patch release for `0.2.0`. It tightens `files=` contracts across
host path representations.

- Absolute paths and host-reported paths relative to `cwd` now use one comparison
  form. The comparison preserves the original path casing.
- Unknown tools and actions with unproven target paths require approval under a
  narrow `files=` boundary; explicit `files=**` remains a wide boundary.
- An empty `files=` value no longer becomes unbounded. Dot segments, repeated
  separators, and Windows path casing follow platform semantics.
- Five boundary cases have regression coverage.

## 0.2.0: From one extra action to one extra sentence

Version 0.1.x handles the action side of SHIT: an unread `.sha256`, a compatibility layer for an imagined future, or an edit during a review.

Version 0.2.0 applies the same test to writing. An agent drafting a proposal starts answering a critic who is not there. It says the work is not a complete study, does not cover every case, and may not apply to everyone. These sentences spend tokens without changing a decision.

Extra work is defense through action. Extra prose is defense through words.
An unread checksum and a disclaimer that changes no decision have the same problem: neither has a consumer.

The Stop Ladder still asks whether an action should exist. The new **Stop That Shit Slop** Skill uses the Sentence Consumer Test to decide whether defensive wording should be removed, tightened, or kept.

> Why does an agent keep defending itself against a critic who is not there?
>
> “This is not a complete study.” “It does not cover every case.” “It may not apply to everyone.”
>
> I did not ask.
>
> Stop spending my tokens on defensive prose for an imaginary critic.
>
> Stop That Shit 0.2.0 adds Stop That Shit Slop: decide whether a sentence should be removed, tightened, or kept.

Version `0.2.0` keeps the Stop Ladder, Guard, five host Adapters, and paired cases. It adds Stop That Shit Slop as a standalone Skill.

| Start with | What it adds | Friction |
| --- | --- | --- |
| **Skill + Guard** | Stop Ladder plus machine-enforced boundaries | Default; review the host Hook configuration |
| **Skill only** | The Stop Ladder and task-mode guidance | Optional; no enforcement |

## Started with Codex and GPT-5.6, now works across agents

The project started with Codex. Public records include exploratory runs on Codex
CLI `0.145.0` with `gpt-5.6-sol` and a directional pilot on Codex CLI `0.147.0`
with `gpt-5.6-luna`. Five Adapters now share the same task-boundary core. The
Codex install path, GPT-5.6 records, and paired eval remain in
[EVIDENCE.md](EVIDENCE.md) and the [paired Codex eval](evals/codex-paired/README.md).

## Quick install

Most hosts require Node.js 18 or newer; Pi 0.84.4 itself requires Node.js
22.19 or newer. See [INSTALL.md](INSTALL.md) for the full setup.

### Claude Code

Extract the repository, then from the checkout root:

```bash
claude plugin validate .
claude plugin marketplace add ./
claude plugin install stop-that-shit@stop-that-shit
```

Restart Claude Code or run `/reload-plugins`, then invoke:

```text
/stop-that-shit:stop-that-shit review -- Review this diff. Report findings; do not edit.
```

### Codex

```bash
codex plugin marketplace add lennney/stop-that-shit --ref 0.2.1
codex plugin add stop-that-shit@stop-that-shit
```

`--ref 0.2.1` pins the install to a version tag instead of mutable
`main`. Restart Codex. In a fresh CLI TUI, enter `/hooks` and trust
`UserPromptSubmit` and `PreToolUse` after inspecting their commands. You can
also give [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) to Codex for the
non-interactive steps.

### OpenCode from GitHub

OpenCode 1.18.18 or newer can install this repository globally without cloning it:

```bash
opencode plugin github:lennney/stop-that-shit -g
```

Restart OpenCode and use `$stop-that-shit review -- ...`. The command installs
the Guard; the bundled Skill and optional `/sts` alias are not registered
automatically. See [INSTALL.md](INSTALL.md#opencode-install-from-github) for
details.

### Hermes Agent CLI

Requires Node.js 18+.

```fish
hermes plugins install lennney/stop-that-shit/.hermes-plugin --no-enable
hermes plugins enable stop-that-shit
hermes plugins list
```

After enabling it, CLI users need to start a new Hermes CLI process or session;
Gateway users need to run:

```fish
hermes gateway restart
```

These steps are not required every time the plugin is used. The corresponding
Hermes process only needs to be restarted after enabling, disabling, updating,
rolling back, or reinstalling the plugin.

### Pi Coding Agent

The current adapter is pinned and tested against
`@earendil-works/pi-coding-agent` `0.84.4`. Install a checkout that contains the
adapter:

```bash
pi install /absolute/path/to/stop-that-shit
```

Start a new Pi process, or run `/reload` in the TUI after resource changes. Then
invoke:

```text
/skill:stop-that-shit review -- Review this diff. Report findings; do not edit.
```

The `0.2.1` tag includes the Pi adapter and both Skills. See [INSTALL.md](INSTALL.md#pi-coding-agent).

## Bad Case / Good Case

```text
BAD CASE
User   Review this diff. Do not edit.
Codex  Calls apply_patch.
STS    STOP / INTENT: review does not authorize mutation.

GOOD CASE
User   Fix the P1 finding only.
Codex  Applies one patch and runs the affected check.
STS    ALLOWED: the requested result needs this action.
```

The Good Case matters as much as the stop. Shipped data can require a
migration. A release pipeline can require a checksum. A shared contract can
require a broad test run. If the user or repository supplies the reason, that
work stays.

## What SHIT means

A bounded task commonly escapes in four directions:

| | Failure | Familiar shape |
| --- | --- | --- |
| **S** | Scope creep | One fix turns into a refactor. |
| **H** | Hashing and hypothetical hardening | An unused digest, defense, or disclaimer. |
| **I** | Intent violation | A review or question turns into an edit. |
| **T** | Task thrashing | Settled work gets reread, retested, or reviewed again. |

Stop That Shit does not count lines or reward smaller diffs. It asks whether each extra action is requested or required by reachable code, data, and acceptance criteria.

Common examples include checksums and guards with no consumer; user-facing
caveats copied from inactive internal risks; rubrics and audit loops where the
task needs an engineering decision; and feature flags, migrations, or wrappers
for a future nobody requested.

## Why hashing is blocked by default

The Hook can recognize hashing with high confidence on covered tool paths. It
uses the test documented by [HERO](https://github.com/wanshuiyin/HERO-Anti-OverDefense):
the digest must replace a costlier operation, and its result must control what
happens next.

```text
STOP
Hash every row, then compare every row anyway.

ALLOW
Use a digest to skip rereading an unchanged large file.
```

The current version denies a recognized new hash operation by default. Use `hash=allow`
when the user or the repository supplies the missing job. The Hook does not try
to infer that job from code it has not seen.

## Use Stop That Shit

Most tasks need one line. Claude Code plugin:

```text
/stop-that-shit:stop-that-shit change -- Fix the failing config test.
/stop-that-shit:stop-that-shit review -- Review this diff. Report findings; do not edit.
```

Codex or host-neutral prompt directive:

```text
$stop-that-shit change -- Fix the failing config test.
$stop-that-shit review -- Review this diff. Report findings; do not edit.
```

Add a boundary when you know it in advance:

```text
$stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- Fix this behavior.
$stop-that-shit change deps=allow -- Add the requested parser dependency.
$stop-that-shit change hash=allow -- Generate the requested release checksum.
$stop-that-shit change agents=1 -- Use one independent test shard.
```

Skip `files=` when you do not know every affected file. Codex should inspect the
real call path and update the callers, fixtures, or tests needed to finish the
request.

Installation begins in `OBSERVING / unconfirmed`: covered actions are checked
and recorded, but the Guard does not infer authorization or return permission
deny. `review`, `answer`, `monitor`, or `change` explicitly arm it; `watch`
keeps observation-only behavior.

Inspect the local evidence chain without changing the current task contract:

```text
$stop-that-shit status
$stop-that-shit runtime
$stop-that-shit explain evt_...
$stop-that-shit label evt_... correct|incorrect|inconclusive
```

`permission_deny_returned` describes the Guard response, not a proven host
effect. Stop That Shit reports host effect as `unobserved`.

## What the AI agent Guard stops

| Covered host action | Default | You can allow it with |
| --- | --- | --- |
| Write during `review`, `answer`, or `monitor` | Stop | Switch to `change` |
| Add a dependency | Ask | `deps=allow` |
| Launch a subagent | Stop above budget | `agents=N` |
| Add a recognized hash operation | Stop | `hash=allow` |
| Write outside a file lock | Stop | Expand `files=` |

The Hook needs a supported event and enough input to make the decision. It does
not infer whether a cache, retry, abstraction, migration, compatibility layer,
or new file belongs in your project. The Skill handles those choices with four
questions:

1. Did the user ask for it?
2. Does the requested result need it?
3. What reachable evidence shows that need?
4. Would the current acceptance fail without it?

The agent reports or defers the extra work when the answers do not support it.

## How the Skill, Hooks, and Adapters work

The Stop That Shit Skill applies the Stop Ladder. Hooks check explicit boundaries
before tool use. Adapters translate Codex, Claude Code, OpenCode, Hermes Agent CLI,
and Pi events into one decision interface. Other harnesses need an equivalent
before-action event; see [HOST-ADAPTER-CONTRACT.md](HOST-ADAPTER-CONTRACT.md).

STSS applies the Sentence Consumer Test. It needs no before-action Hook, so it can ship alone.

## Coverage and public evidence

Stop That Shit governs task authority on supported Hook paths; the host sandbox
handles security isolation. [EVIDENCE.md](EVIDENCE.md) records tests, GPT-5.6
runs, null results, and uncovered paths.

The maintainer has not seen the unused SHA-256 behavior recur since enabling the
plugin; the document records this as a field observation, separate from paired
eval. The local Runtime stores metadata only and separates checked actions,
context responses, permission denies, and `hostEffect: unobserved`.

The twelve fixed STSS responses provide rule and regression acceptance. See the six
[STSS examples](skills/stss/references/examples.md) for the complete case set.

## Choose your Skill

| Skill | Where the agent stops | Common entry point |
| --- | --- | --- |
| **Stop That Shit** | Scope creep, intent violations, unused defensive engineering, and repeated audits | `$stop-that-shit review -- ...` |
| **Stop That Shit Slop** | Defensive disclaimers, hedge stacks, and self-defense with no decision use | `$stss rewrite -- ...` |

Install both Skills or use either one alone.

## One test: who consumes it?

Stop That Shit uses the Stop Ladder for actions:

1. Did the user ask for it?
2. Can the current result succeed without it?
3. Which code, data, deployment state, or acceptance condition requires it?
4. Would omitting it fail current acceptance?

STSS applies the same test to sentences:

1. Who uses this sentence?
2. Which decision does it change?
3. What becomes false or misleading if it is removed?

STSS records the facts, numbers, sources, actors, and evidence strength in a Claim Ledger.
It then chooses `DROP`, `CALIBRATE`, `RELOCATE`, or `KEEP`.
Claim Diff checks that facts and numbers remain, evidence is not invented, and correlation does not become causation.

## What 0.2.0 adds

- A standalone `stss` Skill.
- The existing `$stop-that-shit` entry point and Guard contract remain unchanged. STSS is an optional addition.
- Two modes: `rewrite` edits the text; `audit` reports findings and the smallest fix.
- Six Good/Bad CaseBundle families, twelve synthetic fixtures, and matching fixed offline responses.
- Full-plugin discovery and a standalone STSS install path.
- An explicit version query: `sts doctor --check-update`.

## Stop That Shit Slop: standalone install and invocation

### Standalone install

From the current repository root:

```bash
npx skills add ./skills/stss --global
```

This installs Stop That Shit Slop without a Hook.

### Invoke it

Without a mode, STSS defaults to `rewrite` for supplied text. `audit` reports findings and the smallest fix without rewriting the full artifact.

| Host | Rewrite | Audit |
| --- | --- | --- |
| Codex | `$stss rewrite -- Make this proposal direct.` | `$stss audit -- Find defensive padding.` |
| Claude Code plugin | `/stop-that-shit:stss rewrite -- ...` | `/stop-that-shit:stss audit -- ...` |
| Standalone Claude Skill | `/stss rewrite -- ...` | `/stss audit -- ...` |
| Pi | `/skill:stss rewrite -- ...` | `/skill:stss audit -- ...` |

The original task-boundary entry point stays the same:

```text
$stop-that-shit review -- Review this diff. Report findings; do not edit.
$stop-that-shit change -- Fix the failing configuration test.
$stop-that-shit change hash=allow -- Generate the release checksum I requested.
```

## Three cases: what STSS reduces and keeps

These synthetic cases use the same inputs and boundaries as the fixed offline acceptance set.

### 1. DROP: remove a defense with no consumer

```text
INPUT   We should note that this limited first-round pilot is not intended to prove the
        approach works in every setting. In 120 tickets, 24-hour completion rose from
        68% to 76% after automatic triage was introduced.

OUTPUT  In the first 120-ticket pilot, 24-hour completion rose from 68% to 76% after
        automatic triage was introduced.
```

The sample, metric, and observation remain. The imaginary universal claim is gone.

### 2. CALIBRATE: collapse four hedges into one real condition

```text
INPUT   We may perhaps potentially be able to finish the migration in roughly six to
        eight weeks, depending on access approval.

OUTPUT  We estimate six to eight weeks, subject to access approval.
```

The range and dependency remain. Only the repeated hedging is reduced.

### 3. KEEP: approval uses this sentence

```text
INPUT   In an internal pilot covering 120 tickets, 24-hour completion rose from 68% to
        76% after automatic triage was introduced. The approving manager needs the
        proposal to state that this internal pilot does not represent general deployment.

OUTPUT  In the internal 120-ticket pilot, 24-hour completion rose from 68% to 76% after
        automatic triage was introduced. This internal pilot does not represent general deployment.
```

This limitation changes the approval decision, so it stays.

See the six [STSS examples](skills/stss/references/examples.md) and their executable [`evals/stss`](evals/stss) counterparts.

## Optional: Skill only

If you do not want command Hooks, install only the Stop That Shit advisory Skill. For Claude Code:

```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

For Codex, the remote Skill Installer path is:

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.2.1/skills/stop-that-shit
```

Start a new task, then invoke the host-native Skill form. A standalone Claude Code skill is `/stop-that-shit`; an installed plugin skill is namespaced as `/stop-that-shit:stop-that-shit`; Codex uses `$stop-that-shit`. This path needs no Hook trust,
but it cannot enforce a task boundary or change the host sandbox and approval
settings.

For the standalone STSS path, see [Stop That Shit Slop](#stop-that-shit-slop-standalone-install-and-invocation) above.

## Local verification

```powershell
npm test
npm run eval
npm run eval:paired -- --dry-run
npm run release:check
```

The paired command prints a 144-cell plan and starts no model runs by default.
Live runs require a dedicated Codex home with only this plugin enabled. See
[the paired Codex eval](evals/codex-paired/README.md) before using `--run`.

## Check for updates manually

After installing the package executable, run:

```bash
sts doctor --check-update
```

Use the equivalent command in a source checkout:

```bash
npm run sts -- doctor --check-update
```

Only this explicit command queries GitHub Releases.
It returns `installed`, `latest`, and `releaseUrl`.
It does not install an update or display reminders during startup or tasks.
A standalone STSS installation remains under its host or Skill Installer update flow.

## Help coding agents stop at the boundary

If you have hit this problem, [star the repository](https://github.com/lennney/stop-that-shit)
or send it to the teammate whose `AGENTS.md` keeps growing. The project grows
through case pairs:

```text
report -> counterexample -> reproduction -> enforcement
```

- Codex did work the request did not need? [Report a Bad Case](https://github.com/lennney/stop-that-shit/issues/new?template=bad-case.yml).
- A guard would stop work that was actually necessary? [Report a Good Case](https://github.com/lennney/stop-that-shit/issues/new?template=good-case.yml).
- Have a public reproduction? Turn one case pair into a fixture and open a PR.

First contribution? See the paired reference cases: [Bad Case #1](https://github.com/lennney/stop-that-shit/issues/1) / [Good Case #2](https://github.com/lennney/stop-that-shit/issues/2). Their `Sanitized scenario request` sections quote sanitized scenarios; they are not repository implementation tasks.

In a useful pair, one fact changes and the rest of the task stays the same. The
Bad Case marks where Codex should stop; the Good Case preserves necessary work.
Only reproducible, high-confidence parts enter the Guard. STSS writing cases use
the same rule: public fixtures must be synthetic or sanitized and name the reader
decision that changes.

Start with the [case catalogue](cases/README.md) and
[contribution guide](CONTRIBUTING.md). Remove private code, secrets, account
data, full transcripts, and identifying paths before you post. A small,
sanitized issue is enough.

## License

[MIT](LICENSE)
