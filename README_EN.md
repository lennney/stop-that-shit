<p align="center">
  <img src="assets/stop-stamp.svg" alt="A red STOP audit stamp" width="240">
</p>

<h1 align="center">Stop That Shit</h1>

<p align="center">
  <img src="https://img.shields.io/github/stars/lennney/stop-that-shit?style=flat-square&color=111111&label=stars" alt="GitHub stars">
  <img src="https://img.shields.io/github/v/release/lennney/stop-that-shit?include_prereleases&sort=semver&style=flat-square&color=111111&label=release" alt="Latest release">
  <a href="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml"><img src="https://github.com/lennney/stop-that-shit/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/works%20with-Codex-111111?style=flat-square" alt="Works with Codex">
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-111111?style=flat-square" alt="Works with Claude Code">
  <img src="https://img.shields.io/github/license/lennney/stop-that-shit?style=flat-square&color=111111" alt="MIT license">
</p>

<p align="center">
  <strong>You asked for one file. Codex split it into six modules, called in three agents, and added SHA-256 checksums. Stop That Shit.</strong><br>
  Stop That Shit runs locally through adapters for Codex, Claude Code, and OpenCode.<br>
  <a href="#install">Install</a> ·
  <a href="#bad-case--good-case">Bad / Good Case</a> ·
  <a href="cases/README.md">Cases</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="README.md">中文</a>
</p>

Ask Codex for one small file and you may get a module tree, several subagents,
a new dependency, and a SHA-256 checksum nobody uses.

Every step comes with a careful explanation. The requested work is still not
finished, and a noticeable part of the token budget went to work Codex invented
for itself.

Adding “do not overengineer” to `AGENTS.md` helps until the file becomes a
history of every behavior that annoyed you. Stop That Shit turns the small,
high-confidence part of that history into a Skill and an executable Guard.

Stop That Shit gives Codex, Claude Code, and OpenCode a task boundary. They
share one core Guard; thin adapters translate each host's events. Each agent
still reads the repository and follows necessary consequences. When the Guard
can prove that an action crossed the boundary, it returns a red stamp:

```text
STOP / INTENT
Guard returned permission deny.
Reason: MODE_FORBIDS_MUTATION
State: ARMED / review
Event: evt_...
```

Version [`0.0.3`](https://github.com/lennney/stop-that-shit/releases/tag/0.0.3)
is Technical Preview 3. LLM runs vary, and Hooks see only part of a host agent
run. The Skill and Guard can reduce some unwanted work. Neither can guarantee
how the model will behave.

| Start with | What it adds | Friction |
| --- | --- | --- |
| **Skill + Guard** | Stop Ladder plus machine-enforced boundaries | Default; review the host Hook configuration |
| **Skill only** | The Stop Ladder and task-mode guidance | Optional; no enforcement |

## Quick install

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
`UserPromptSubmit` and `PreToolUse` after you inspect their commands. See
[Install](#install) for expected status and the no-Hook option. You can also
give [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) to Codex and let it run
the non-interactive steps.

### OpenCode from GitHub

OpenCode 1.18.18 or newer can install this repository globally without cloning it:

```bash
opencode plugin github:lennney/stop-that-shit -g
```

Restart OpenCode and use `$stop-that-shit review -- ...`. The command installs
the Guard; the bundled Skill and optional `/sts` alias are not registered
automatically. See [INSTALL.md](INSTALL.md#opencode-install-from-github) for
details.

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

The pain tends to look reasonable one decision at a time:

- checksum files that no command reads;
- guards for inputs that no supported path can produce;
- user-facing caveats copied from internal risk notes when no current decision
  needs them;
- a rubric or audit loop where the task needs an engineering decision;
- feature flags, migration frameworks, and wrappers for a future no one asked for;
- one more guard whose only reason is to protect the previous guard.

Each piece has an explanation. Together they can bury a small feature under
defensive code, caveats, and process.

## Why hashing is blocked by default

Hashing is concrete enough for the Hook to recognize on covered tool paths. It
also has a clean question: does the digest save real work and change the next
action?

We use the test documented by
[HERO](https://github.com/wanshuiyin/HERO-Anti-OverDefense): the digest must
replace a costlier operation, and its result must control what happens next.

```text
STOP
Hash every row, then compare every row anyway.

ALLOW
Use a digest to skip rereading an unchanged large file.
```

`0.0.3` denies a recognized new hash operation by default. Use `hash=allow`
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

## What the Guard stops

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

## How it works

The Skill guides semantic choices. Hooks enforce explicit facts before supported
tools run. Small host Adapters translate each host's events into the same core
decision interface. Each Adapter exposes the host events it needs, for example
hard denial before tool use and lifecycle events that carry the active
contract. See [HOST-ADAPTER-CONTRACT.md](HOST-ADAPTER-CONTRACT.md).

## Limits and evidence

Specialized tool paths can bypass normal Hooks. The plugin does not judge code
quality, repair Codex runtime bugs, or act as a security sandbox.

The test suite proves policy behavior on covered events. It does not prove a
general improvement in model behavior. [EVIDENCE.md](EVIDENCE.md) records the
tests, live runs, null results, and exclusions.

In my own use, I have not seen the unnecessary SHA-256 behavior recur since
enabling Stop That Shit. That is a personal observation, not a controlled
benchmark. The local Runtime records metadata-only Hook checks and separates
checked actions, context responses, and permission denies. It still reports
host effect as `unobserved`.

## Install

### Claude Code: Skill + Guard

Requires Node.js 18 or newer. From the local checkout root:

```bash
claude plugin validate .
claude plugin marketplace add ./
claude plugin install stop-that-shit@stop-that-shit
```

Restart or `/reload-plugins`. Claude loads `skills/`, `hooks/hooks.json`, and the
Claude adapter. The Guard covers `Write`, `Edit`, `NotebookEdit`, `EnterWorktree`,
shell/`Monitor` mutation, dependency/hash intent, optional file locks, and
`Agent` budgets on supported Hook paths. Claude `Workflow` is conservatively
denied while the Guard is armed because its internal subagent fan-out cannot be
bounded by `agents=N`.

### Codex: Skill + Guard

```bash
codex plugin marketplace add lennney/stop-that-shit
codex plugin add stop-that-shit@stop-that-shit
```

Restart Codex. Open a fresh Codex CLI TUI, enter `/hooks`, and review the two
Stop That Shit handlers. A trusted installation shows `Active 1 / Review 0` for
`UserPromptSubmit` and `PreToolUse`. `Stop 0` is expected because the plugin
does not install a Stop handler. If Codex Desktop sends `/hooks` as a normal
message, use the CLI TUI for this review, then restart Desktop.

### Optional: Skill only

If you do not want command Hooks, install only the advisory Skill. For Claude Code:

```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

For Codex, the remote Skill Installer path is:

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.0.3/skills/stop-that-shit
```

Start a new task, then invoke the host-native Skill form. A standalone Claude Code skill is `/stop-that-shit`; an installed plugin skill is namespaced as `/stop-that-shit:stop-that-shit`; Codex uses `$stop-that-shit`. This path needs no Hook trust,
but it cannot enforce a task boundary or change the host sandbox and approval
settings.

See [INSTALL.md](INSTALL.md) for the complete Skill and Guard paths. Run the
local checks:

```powershell
npm test
npm run eval
npm run eval:paired -- --dry-run
npm run release:check
```

The paired command prints a 72-cell plan and starts no model runs by default.
Live runs require a dedicated Codex home with only this plugin enabled. See
[the paired Codex eval](evals/codex-paired/README.md) before using `--run`.

## Help define the boundary

This project grows through case pairs, not through more prohibitions:

```text
report -> counterexample -> reproduction -> enforcement
```

A report can stop at the first step and still be useful. You do not need to
write Hook code or build a benchmark. Enforcement comes last, and only when the
evidence is reproducible and the decision is reliable.

- Codex did work the request did not need? [Report a Bad Case](https://github.com/lennney/stop-that-shit/issues/new?template=bad-case.yml).
- A guard would stop work that was actually necessary? [Report a Good Case](https://github.com/lennney/stop-that-shit/issues/new?template=good-case.yml).
- Have a public reproduction? Turn one case pair into a fixture and open a PR.

A useful pair changes one fact and keeps the rest of the task the same. The Bad
Case shows where Codex crossed the boundary. The Good Case keeps the rule from
becoming another blunt restriction. Only reproducible, high-confidence parts
belong in the Guard; the rest can improve the Skill and case catalogue.

Start with the [case catalogue](cases/README.md) and
[contribution guide](CONTRIBUTING.md). Remove private code, secrets, account
data, full transcripts, and identifying paths before you post. A small,
sanitized issue is enough.

## License

[MIT](LICENSE)
