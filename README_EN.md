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
  <em>Finish the job. Skip the busywork.</em>
</p>

<p align="center">
  A Skill + Guard to curb unnecessary defenses and scope creep in AI coding agents.<br>
  Codex · Claude Code · OpenCode · Hermes Agent CLI · Pi<br>
  <a href="#the-shit-philosophy">SHIT philosophy</a> ·
  <a href="#before--after">See an example</a> ·
  <a href="#quick-install">Install</a> ·
  <a href="cases/README.md">Cases</a> ·
  <a href="README.md">中文</a>
</p>

---

You ask your agent to export a file. It adds a SHA-256 checksum nobody reads.
"Just in case."

You ask for a review; it finds a bug and starts editing. One fix becomes a plan
to refactor neighboring modules. The checks have answered the question, but it
wants another agent to "make sure one last time."

Every step has a careful explanation. The result is still missing, the tokens
keep going, and you're left keeping the agent on task.

**Still no result. Now I'm supervising the agent.**

I tried adding rules to `AGENTS.md`: "do not edit," "do not overengineer,"
"ask before doing extra work." Every frustration became another rule.
Eventually, `AGENTS.md` was overengineered too.

**Stop That Shit.** Finish the work the task needs. Stop piling on work it doesn't.

## The SHIT philosophy

We call these behaviors SHIT:

- **S — Scope creep.** A fix expands into an unrelated refactor. Complete the
  callers, data migrations, and tests that the request requires. Stop additions
  with no current purpose.
- **H — Hashing & hypothetical hardening.** An unread checksum or a compatibility
  layer for an imagined future. Protection must detect a problem and lead to
  rejection, recovery, or diagnosis. Keep effective defenses, omit unused ones,
  and repair those that swallow failures, report false success, or duplicate side effects.
- **I — Intent violation.** You said read-only review; the files changed anyway.
  Review means reporting findings; editing needs change authority. Respect the user's boundary.
- **T — Task thrashing.** The reading, testing, and reviewing restart with no
  change or new question. Reuse evidence that answers the current question.
  Add relevant checks when code or acceptance conditions change. Finish once the work
  is done and sufficiently verified.

**Meet the task's responsibilities in full, and let real needs drive complexity.**
If that requires more files, a migration, or cross-component tests, complete them.

## Before / after

The next step reads only `report.csv`. No release check or other step uses a
digest, yet the export includes one:

```js
await writeFile("report.csv", csv);
await writeFile("report.csv.sha256", createHash("sha256").update(csv).digest("hex"));
```

Applying the STS rule leaves:

```js
await writeFile("report.csv", csv);
```

This simplified example drops the unused checksum and still delivers the file.
More examples are in the [case catalogue](cases/README.md).

If the release process reads the checksum and rejects mismatches, keep it.
Set `hash=allow` to authorize it.

**Complete the necessary work.** If a configuration migration must support
already shipped data, finish the migration, update readers and writers, and test
compatibility, even if the diff grows. Do not leave broken callers behind.

## What we have checked

The 18 public Bad/Good decision cases check whether rules stop unnecessary
actions and allow required work. They cover read-only review, affected callers,
shipped-data migrations, release checksums, and file, dependency, and subagent
boundaries. Model behavior on real tasks is evaluated separately.

The [evidence record](EVIDENCE.md) includes tests, historical Codex / GPT-5.6 runs,
and results with no difference. See the [paired evaluation guide](evals/codex-paired/README.md)
to reproduce the comparisons.

## How it works

When this SHIT appears, read the relevant code and trace the call path.
Then decide in this order:

```text
1. What must be delivered?       → Establish the result, authority, and support commitments
2. Can existing tools do it?     → Start with a direct solution
3. What concrete gap remains?    → Add the behavior and protection it needs
4. What does this defense do?    → Keep effective protection, omit waste, repair harm
5. Is the result verified?       → Finish when no in-scope blocker remains
```

Check existing code, standard libraries, native platform features, and installed
dependencies. Use what fits the required behavior and state lifetime. Add a
mechanism when a concrete gap calls for it.

A new optional mechanism without a purpose can wait. Existing protection with an
unclear role needs inspection before removal. Real trust boundaries and support
commitments justify protection before an incident occurs.

Line counts, file counts, and check counts cannot replace this judgment.
[Read the full rules](skills/stop-that-shit/SKILL.md).

## Quick install

Most hosts require Node.js 18 or newer; Pi 0.84.4 itself requires Node.js
22.19 or newer. See [INSTALL.md](INSTALL.md) for the full setup.

Expand your host. For guidance without runtime enforcement, [install only the Skill](INSTALL.md#optional-skill-only).

<details>
<summary>Claude Code</summary>

Download and extract the [0.2.1 source](https://github.com/lennney/stop-that-shit/archive/refs/tags/0.2.1.zip), then run from the checkout root:

```bash
claude plugin validate .
claude plugin marketplace add ./
claude plugin install stop-that-shit@stop-that-shit
```

Restart Claude Code or run `/reload-plugins`, then invoke:

```text
/stop-that-shit:stop-that-shit review -- Review this diff. Report findings; do not edit.
```

</details>

<details>
<summary>Codex</summary>

```bash
codex plugin marketplace add lennney/stop-that-shit --ref 0.2.1
codex plugin add stop-that-shit@stop-that-shit
```

`--ref 0.2.1` pins the install to a version tag instead of mutable
`main`. Restart Codex. In a fresh CLI TUI, enter `/hooks` and trust
`UserPromptSubmit` and `PreToolUse` after inspecting their commands. You can
also give [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) to Codex for the
non-interactive steps.

</details>

<details>
<summary>OpenCode from GitHub</summary>

OpenCode 1.18.18 or newer can install this repository globally without cloning it:

```bash
opencode plugin github:lennney/stop-that-shit -g
```

Restart OpenCode and use `$stop-that-shit review -- ...`. The command installs
the Guard; the bundled Skill and optional `/sts` alias are not registered
automatically. See [INSTALL.md](INSTALL.md#opencode-install-from-github) for
details.

</details>

<details>
<summary>Hermes Agent CLI</summary>

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

</details>

<details>
<summary>Pi Coding Agent</summary>

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

</details>

## Use it

In Codex or a host-neutral prompt, state the task:

```text
$stop-that-shit review -- Review this diff. Report findings; do not edit.
$stop-that-shit change -- Fix the config read failure, including affected callers and checks.
```

The Claude Code plugin uses `/stop-that-shit:stop-that-shit`.
The Pi Skill uses `/skill:stop-that-shit`.

| Command | Purpose |
| --- | --- |
| `review` | Review and report findings |
| `answer` | Answer a question |
| `monitor` | Keep checking and reporting |
| `change` | Permit changes needed to complete the task |
| `watch` | Observe actions without blocking |
| `status` / `runtime` | Inspect the current state and local records |

Add parameters when the task needs a more specific boundary:

```text
$stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- Fix this behavior.
$stop-that-shit change deps=allow -- Add the requested parser dependency.
$stop-that-shit change hash=allow -- Generate the checksum required by the release process.
$stop-that-shit change agents=1 -- Use one independent test subagent.
```

If you do not yet know every affected file, trace the call path before setting `files=`.

### What the stamp covers

The Skill guides engineering judgment. The Guard checks explicit boundaries
before supported tool calls:

| Action | Default when the Guard is armed |
| --- | --- |
| Write during `review`, `answer`, or `monitor` | Stop |
| Add a dependency | Ask; `deps=allow` permits it |
| Launch a subagent | Stop above the `agents=N` budget |
| Add a recognized hash operation | Stop; `hash=allow` permits it |
| Write outside `files=` | Stop |

The Guard does not decide that a cache, retry, or migration is unnecessary from
its name. See the [Adapter contract](HOST-ADAPTER-CONTRACT.md) for host integration.

## Optional: Stop That Shit Slop

The work is done, but the agent keeps talking. STSS removes unused defenses,
tightens repeated hedging, and keeps conditions that affect a decision.
An example from the fixed offline cases:

```text
INPUT   We may perhaps potentially be able to finish the migration in roughly six to
        eight weeks, depending on access approval.
OUTPUT  We estimate six to eight weeks, subject to access approval.
```

The range and approval condition remain. If approval is required before work
starts, state that timing explicitly: “The estimated migration time is six to
eight weeks after access approval.”

The full plugin includes STSS. You can also install it alone, without a Hook.
From the repository root:

```bash
npx skills add ./skills/stss --global
```

`rewrite` edits supplied text and is the default mode. `audit` reports findings
and the smallest proposed fix.

| Host | Rewrite | Audit |
| --- | --- | --- |
| Codex | `$stss rewrite -- Make this proposal direct.` | `$stss audit -- Find defensive padding.` |
| Claude Code plugin | `/stop-that-shit:stss rewrite -- ...` | `/stop-that-shit:stss audit -- ...` |
| Standalone Claude Skill | `/stss rewrite -- ...` | `/stss audit -- ...` |
| Pi | `/skill:stss rewrite -- ...` | `/skill:stss audit -- ...` |

See the [STSS Skill](skills/stss/SKILL.md) for the full method and the six
[STSS examples](skills/stss/references/examples.md) for paired cases, including
wording that must remain.

## FAQ

**Should every checksum go?**

Release integrity checks, deduplication, and skipping repeated processing can
all give a checksum a job. Comparing a file against a trusted expected digest
and rejecting a mismatch is useful even if it adds computation. Use `hash=allow`
when it is needed. The Guard checks authority; the task determines the purpose.

**I installed it. Why is nothing blocked yet?**

Installation starts in `OBSERVING / unconfirmed`. An explicit `review`, `answer`,
`monitor`, or `change` sets the Guard to `ARMED`. `watch` always observes without
blocking. A Skill-only installation has no runtime enforcement.

**Does a stop stamp prove the action never ran?**

`permission_deny_returned` (`execution_denial_returned` in OpenCode) means the
Guard returned a denial. The host's final action needs separate observation,
so the Runtime records `hostEffect: unobserved`. The host sandbox handles
security isolation.

**Does it save my code or conversations?**

The local Runtime stores task-boundary state and metadata, without code or
conversation text. See [PRIVACY.md](PRIVACY.md).

**How do I update, uninstall, or work on it?**

See [update checks](INSTALL.md#check-for-updates),
[disabling and uninstalling](INSTALL.md#disable-or-uninstall),
[local development](INSTALL.md#local-guard-development), and the
[changelog](CHANGELOG.md).

## Send the counterexample

Your agent invented more work? [Report a Bad Case](https://github.com/lennney/stop-that-shit/issues/new?template=bad-case.yml).

STS blocked something the task needed? [Report a Good Case](https://github.com/lennney/stop-that-shit/issues/new?template=good-case.yml).
That matters just as much.

Tell us what you requested, what the agent added or left unfinished, and which
fact would change the decision. See the [case catalogue](cases/README.md) for
examples and the [contribution guide](CONTRIBUTING.md) for sanitizing and reproducing them.

I do not want another hundred prohibitions in `AGENTS.md`. I want each case to
make the next decision better.

If this helps, [give it a star](https://github.com/lennney/stop-that-shit).
You can also join the conversation on [LINUX DO](https://linux.do).

## License

[MIT](LICENSE)
