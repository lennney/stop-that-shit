<p align="center">
  <img src="assets/stop-stamp.svg" alt="Stop That Shit red STOP stamp for an AI coding agent task-boundary Guard" width="240">
</p>

<h1 align="center">Stop That Shit（别再造史了）</h1>

<p align="center">
  <a href="https://github.com/lennney/stop-that-shit/stargazers"><img src="https://img.shields.io/github/stars/lennney/stop-that-shit?style=flat-square&color=111111&label=stars" alt="GitHub stars"></a>
  <a href="https://github.com/lennney/stop-that-shit/releases"><img src="https://img.shields.io/github/v/release/lennney/stop-that-shit?include_prereleases&sort=semver&style=flat-square&color=111111&label=release" alt="Latest release"></a>
  <a href="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml"><img src="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/works%20with-Codex-111111?style=flat-square" alt="Works with Codex">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-111111?style=flat-square" alt="Works with Claude Code">
  <img src="https://img.shields.io/badge/works%20with-OpenCode-111111?style=flat-square" alt="Works with OpenCode">
  <img src="https://img.shields.io/badge/works%20with-Hermes%20Agent%20CLI-111111?style=flat-square" alt="Works with Hermes Agent CLI">
  <img src="https://img.shields.io/github/license/lennney/stop-that-shit?style=flat-square&color=111111" alt="MIT license">
</p>

<p align="center">
  <strong>You asked an agent for one output file. It also generated a SHA-256 checksum that no later command reads. Stop That Shit.</strong><br>
  Stops unrequested defensive work and task-boundary drift invented by AI coding agents. Supports Codex, Claude Code, OpenCode, and Hermes Agent CLI.<br>
  <a href="#quick-install">Install</a> ·
  <a href="#bad-case--good-case">Bad / Good Case</a> ·
  <a href="cases/README.md">Cases</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="README.md">中文</a>
</p>

The checksum gets generated, but it saves no work and leaves the rest of the task
unchanged. On another task, the extra work might be a guard, a compatibility
layer, a full test run, or another process step. Codex, Claude Code, OpenCode, and Hermes Agent CLI
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

Version [`0.1.0`](https://github.com/lennney/stop-that-shit/releases/tag/0.1.0)
is the first multi-platform release. Codex, Claude Code, OpenCode, and Hermes
Agent CLI now share the same Guard, Skill, paired cases, and metadata-only local
Runtime through four host Adapters.

| Start with | What it adds | Friction |
| --- | --- | --- |
| **Skill + Guard** | Stop Ladder plus machine-enforced boundaries | Default; review the host Hook configuration |
| **Skill only** | The Stop Ladder and task-mode guidance | Optional; no enforcement |

## Started with Codex and GPT-5.6, now works across agents

The project started with Codex. Public records include exploratory runs on Codex
CLI `0.145.0` with `gpt-5.6-sol` and a directional pilot on Codex CLI `0.147.0`
with `gpt-5.6-luna`. Four Adapters now share the same task-boundary core. The
Codex install path, GPT-5.6 records, and paired eval remain in
[EVIDENCE.md](EVIDENCE.md) and the [paired Codex eval](evals/codex-paired/README.md).

## Quick install

Requires Node.js 18 or newer. See [INSTALL.md](INSTALL.md) for the full setup.

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
codex plugin marketplace add lennney/stop-that-shit
codex plugin add stop-that-shit@stop-that-shit
```

Restart Codex. In a fresh CLI TUI, enter `/hooks` and trust
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

## SHIT happens

The name labels four ways a bounded task gets away from you:

| | Failure | A familiar shape |
| --- | --- | --- |
| **S** | Scope creep | One fix turns into a refactor. |
| **H** | Hashing and hypothetical hardening | Unused digests, defenses, or caveats. |
| **I** | Intent violation | A review or question turns into an edit. |
| **T** | Task thrashing | Codex rereads, retests, or re-reviews settled work. |

The plugin does not count lines or reward smaller diffs. It asks whether each
extra action is requested or required by reachable code, data, and acceptance
criteria.

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

`0.1.0` denies a recognized new hash operation by default. Use `hash=allow`
when the user or the repository supplies the missing job. The Hook does not try
to infer that job from code it has not seen.

## Use it

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

The Skill handles semantic choices, Hooks check explicit boundaries before tool
use, and Adapters translate Codex, Claude Code, OpenCode, and Hermes Agent CLI events into one
decision interface. Other harnesses need an equivalent before-action event; see
[HOST-ADAPTER-CONTRACT.md](HOST-ADAPTER-CONTRACT.md).

## Coverage and public evidence

Stop That Shit governs task authority on supported Hook paths; the host sandbox
handles security isolation. [EVIDENCE.md](EVIDENCE.md) records tests, GPT-5.6
runs, null results, and uncovered paths.

The maintainer has not seen the unused SHA-256 behavior recur since enabling the
plugin; the document records this as a field observation, separate from paired
eval. The local Runtime stores metadata only and separates checked actions,
context responses, permission denies, and `hostEffect: unobserved`.

## Optional: Skill only

If you do not want command Hooks, install only the advisory Skill. For Claude Code:

```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

For Codex, the remote Skill Installer path is:

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.1.0/skills/stop-that-shit
```

Start a new task, then invoke the host-native Skill form. A standalone Claude Code skill is `/stop-that-shit`; an installed plugin skill is namespaced as `/stop-that-shit:stop-that-shit`; Codex uses `$stop-that-shit`. This path needs no Hook trust,
but it cannot enforce a task boundary or change the host sandbox and approval
settings.

## Local verification

```powershell
npm test
npm run eval
npm run eval:paired -- --dry-run
npm run release:check
```

The paired command prints a 72-cell plan and starts no model runs by default.
Live runs require a dedicated Codex home with only this plugin enabled. See
[the paired Codex eval](evals/codex-paired/README.md) before using `--run`.

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

In a useful pair, one fact changes and the rest of the task stays the same. The
Bad Case marks where Codex should stop; the Good Case preserves necessary work.
Only reproducible, high-confidence parts enter the Guard.

Start with the [case catalogue](cases/README.md) and
[contribution guide](CONTRIBUTING.md). Remove private code, secrets, account
data, full transcripts, and identifying paths before you post. A small,
sanitized issue is enough.

## License

[MIT](LICENSE)
