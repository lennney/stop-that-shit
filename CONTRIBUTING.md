# Contributing to Stop That Shit

Stop That Shit is built from real Codex behavior, paired counterexamples, and
small verifiable controls. You do not need to write Hook code to contribute.
The smallest useful contribution is one sanitized issue with the request, the
unnecessary or necessary action, and the reason it should be stopped or kept.

## Fastest ways to help

1. Submit a **Bad Case** where Codex left the authorized task.
2. Submit a **Good Case** where a seemingly extra action was actually necessary.
3. Pair an existing case labeled `needs-counterexample`.
4. Turn a sanitized case into a reproducible fixture.
5. Improve a classifier, Hook, test, installer, or explanation.
6. Re-run the paired evaluation on another supported Codex version or model.

## Where a change belongs

| If you want to change | Start here |
| --- | --- |
| Agent guidance or the Stop Ladder | `skills/stop-that-shit/SKILL.md` |
| Hook discovery and lifecycle events | `hooks/` |
| Task contracts and decisions | `src/` |
| Codex event translation | `src/adapters/` |
| A Bad Case or Good Case | `cases/0.0.1/` |
| Reproducible model evaluation | `evals/codex-paired/cases/<family>/` |
| Regression coverage | `test/` |

User-facing setup belongs in `README.md`, `README_EN.md`, `INSTALL.md`, or
`INSTALL_FOR_AGENTS.md`. Keep raw sessions, private repositories, and launch
material out of this repository.

## Before opening a pull request

- Open or link a case before changing Guard decisions.
- Keep one concern in the pull request. Do not bundle policy, installer, and
  README changes unless one cannot work without the others.
- Add only files needed for the stated change. Do not reformat or reorganize
  unrelated files.
- Do not edit generated release output or commit local run directories.
- Do not start paid Codex evaluations unless a maintainer requests them.
- Run the relevant focused test, then the repository checks listed in the pull
  request template.

All pull requests require maintainer review. `CODEOWNERS` requests that review
for every tracked path. Maintainers can close changes that expand the product
boundary, lack a counterexample, expose private material, or make claims beyond
the supplied evidence.

## Evidence levels

| Level | Required evidence |
| --- | --- |
| `report` | Sanitized request, action, expected decision, and reason |
| `trace` | Starting state, decisive evidence, and relevant action sequence |
| `repro` | Pinned public repository or minimal fixture with repeat steps |
| `paired-eval` | Isolated baseline/plugin runs plus executable completion and counterexample checks |

Reports are welcome. They do not need to arrive as perfect evals.

## Case contribution rules

- Describe one material action per case.
- Use S, H, I, or T only when the decisive evidence fits that family.
- Give the expected decision and the proportionate next action.
- Include the nearest counterexample, or mark the case as needing one.
- Prefer a minimal contrast: one changed fact should reverse the verdict.
- Do not infer model training motives from behavior.
- Do not use LOC, file count, token count, or elapsed time as the verdict by
  itself. Those are signals, not task authorization.
- Sanitize private material before posting.

Use [`cases/_template.md`](cases/_template.md) for a catalogue PR. A GitHub issue
is enough for an initial report.

For a publishable executable pair, create a `CaseBundle v1` and validate it:

```powershell
npm run sts -- case new --id <slug>
npm run sts -- case validate evals/codex-paired/cases/<slug>
```

The bundle must contain both fixtures, deterministic acceptance, sanitized task
text, and a confirmed privacy review. Agent instruction files, symlinks, path
escape, and unknown assertion types are rejected.

## Case labels

- `case:bad` — Codex crossed the requested boundary;
- `case:good` — the action was necessary and must remain allowed;
- `needs-counterexample` — the case still needs its nearest opposite;
- `good first issue` — a small contribution with enough context to start.

Keep evidence level and SHIT family in the issue body until the case is clear.
The project does not need a label for every field.

## Code changes are case-first

A policy or Hook PR must name the case it changes.

Passing means:

1. the Bad Case is blocked, deferred, or escalated as expected;
2. the paired Good Case still proceeds;
3. the requested result still completes;
4. no new repetition or continuation loop appears;
5. the intervention explains its SHIT family, evidence, and next step.

One concern per PR. A classifier change, installer refactor, and README rewrite
belong in separate contributions.

## Evaluation claims

Any public effectiveness claim must state:

- repository and immutable revision;
- Codex surface and version;
- model and reasoning setting;
- permissions and enabled plugins;
- exact baseline and Stop That Shit configuration;
- run count, failures, and exclusions;
- task-completion and Good Case results, not only prevented actions;
- negative and null results.

Never turn one successful trace into a universal percentage.

## Community loop

Maintainers should publish a regular case roundup containing:

- newly accepted Bad Cases;
- newly accepted Good Cases;
- unpaired cases where help is wanted;
- cases promoted to reproducible evals;
- policies changed or rejected because of counterexamples;
- supported Codex versions actually tested.

Contributors choose anonymous or credited publication. Useful reports receive
the same credit as code. Finding the Good Case that prevents a bad rule is a
first-class contribution.

## What not to submit

- raw secrets, authentication data, proprietary code, or full private sessions;
- complaints without a recognizable action and expected alternative;
- style disputes presented as authorization failures;
- rules that stop legitimate security, migration, accessibility, or regression
  work merely because it is large;
- claims that Stop That Shit fixes Codex runtime bugs it can only mitigate.

Bring the trace. Bring the counterexample. Help Codex stop the right shit.
