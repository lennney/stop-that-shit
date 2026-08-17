# Paired Codex evaluation

This harness tests one narrow claim: does Stop That Shit reduce specific
unauthorized actions without blocking the matching authorized action?

It does not estimate how common Codex overengineering is. It does not convert
unit tests into an effectiveness percentage.

## Matrix

The default plan contains five Bad/Good families:

| Family | Bad Case | Good Case |
| --- | --- | --- |
| Intent | A review must not edit | An explicit change may edit |
| Hash | CSV comparison does not need row hashes | A requested release checksum remains allowed |
| Scope | A narrow fix stays inside its file boundary | A real caller and focused test remain in scope |
| Dependency | A small helper does not need a package | An explicitly requested local dependency remains allowed |
| Deliverable meta | Public copy gains no unrequested diligence disclaimer | An explicitly requested source limitation remains visible |

Each case runs under three arms:

- `baseline`: Stop That Shit is disabled;
- `instruction`: the plugin is disabled and receives a short instruction-only
  control;
- `plugin`: the installed plugin is enabled and invoked with an explicit task
  contract.

The default is three repetitions:

```text
10 cases x 3 arms x 3 runs = 90 isolated Codex sessions
```

Each family is a validated `CaseBundle v1`:

```text
evals/codex-paired/cases/<family>/
  case.json
  fixtures/bad/
  fixtures/good/
```

A publishable bundle requires a sanitized task, minimal fixtures, one Bad Case,
the nearest Good Case with one decisive fact changed, deterministic acceptance,
and a confirmed privacy review. Create and validate bundles with:

```powershell
npm run sts -- case new --id <slug>
npm run sts -- case validate evals/codex-paired/cases/<slug>
```

Validation checks structure and containment; it does not certify fixture code as
safe. Read external bundles before running their acceptance commands.

## Inspect the plan

This command does not start Codex or create run artifacts:

```powershell
npm run eval:paired -- --dry-run
```

Filter by family or arm while developing:

```powershell
npm run eval:paired -- --dry-run --runs 1 --case intent
npm run eval:paired -- --dry-run --runs 1 --case hash --arm plugin
npm run eval:paired -- --case-dir C:\path\to\case-bundle --dry-run
```

## Run live sessions

Live evaluation requires:

- a dedicated, authenticated Codex home used only for this evaluation;
- an external workspace root with no applicable `AGENTS.md` or
  `AGENTS.override.md` in its ancestor chain;
- Stop That Shit installed there from the exact revision under test;
- its two Hooks reviewed and trusted in the CLI TUI;
- no other enabled plugin, global `AGENTS.md`, or instruction that applies the
  same rules to every arm.

Create and authenticate that profile yourself. The runner never copies login
credentials. In PowerShell, point Codex and the runner at the same dedicated
directory before installing and trusting the plugin:

```powershell
$env:CODEX_HOME = 'C:\path\to\sts-eval-codex-home'
$env:STS_EVAL_CODEX_HOME = $env:CODEX_HOME
codex login
codex plugin marketplace add <local-checkout-root>
codex plugin add stop-that-shit@stop-that-shit
codex
```

In that CLI TUI, use `/hooks` to inspect and trust the two handlers. Exit it,
then confirm that `codex plugin list` shows Stop That Shit as the only enabled
plugin. The runner refuses a profile with another enabled plugin.

Start paid sessions only with `--run`:

```powershell
npm run eval:paired -- --run --runs 1 --case intent --model gpt-5.6-luna --reasoning medium --max-cells 6
npm run eval:paired -- --run --model gpt-5.6-luna --reasoning medium --max-cells 90
```

Live runs require explicit `--model`, `--reasoning`, and `--max-cells` values.
The runner refuses a selected matrix above that hard paid-session cap. Remember
that `--case intent` selects both `intent-bad` and `intent-good`: three arms and
three repeats therefore select 18 cells, not 9. Inspect the dry-run plan before
spending. Result bundles also record the Codex version, plugin version and Git
revision, OS, architecture, and sandbox. A revision ending in `+dirty` is
diagnostic only and should not enter a published comparison.

The default sandbox is `workspace-write`. If Windows cannot initialize that
sandbox, the runner has a separately named unrestricted-sandbox option for
disposable evaluation fixtures only. Inspect `npm run eval:paired -- --help`
before using it; never place that option in a default command or automation. It
grants the spawned Codex session unsandboxed machine access, so use it only with
reviewed local fixtures and an external temporary workspace:

```powershell
npm run eval:paired -- --help
```

You may pass the profile with `--codex-home` instead of the environment
variable. Live fixture repositories default to a directory under the operating
system temporary directory, outside this source repository. Override that root
with `--workspace-root` or `STS_EVAL_WORKSPACE_ROOT`; the runner refuses a root
inside the source repository or below an Agent instruction file.

The baseline and instruction arms start Codex with all plugins
disabled. The plugin arm enables plugins and Hooks. Since the preflight permits
only Stop That Shit, this isolates the intended variable.

The runner does not use `--dangerously-bypass-hook-trust`. Each cell receives a
fresh Git fixture and an ephemeral Codex session.

Runs are sequential. Codex executes in the external workspace root. After each
cell, the runner archives raw events, stderr, the final workspace, metadata-only
runtime events, and a scored `result.json` under `evals/codex-paired/runs/`, then
removes the external cell workspace. The archive directory is ignored by Git.
Review generated artifacts for private paths and task content before sharing
them.

Acceptance can be recomputed from an archived run without starting Codex.
Treat a result bundle as untrusted input: it can contain executable `command`
acceptance checks. Review the local bundle before allowing those checks, and do
not rescore a downloaded bundle merely because the operation does not call a
model.

```powershell
npm run eval:paired -- --rescore evals/codex-paired/runs/<stamp> --allow-acceptance-commands
```

Bundles without command checks do not need the opt-in. Rescore validates cell
coordinates and workspace-relative paths before rewriting `result.json` and
`summary.json`.

## Scoring

Every case has executable acceptance checks. The checks cover:

- requested behavior or a valid review finding;
- absence of unrequested process narration in public copy, while preserving an
  explicitly requested source limitation;
- changed-file boundaries;
- forbidden hash activity;
- an exact dependency authorization;
- a checksum that matches its source file.

The summary reports completed and passed cells, infrastructure exclusions,
runtime checked/context/permission-deny response counts, and paired
baseline-to-plugin outcomes: `improved`, `regressed`, `unchanged`, or
`incomparable`. Infrastructure failures do not enter the effect denominator.
A permission-deny response is not a win when the task is incomplete, and its
host effect remains `unobserved`. A smaller diff is not a win when the Good Case
fails.

## Claim gate

Do not publish an improvement percentage from one run. Keep failures and null
results. Require all Good Cases to pass before an initial qualitative claim.
Repeat every cell at least three times.

This is still a small synthetic corpus. Model behavior varies, `codex exec`
support for plugin Hooks can change, and a deterministic check is not proof of
general effectiveness.
