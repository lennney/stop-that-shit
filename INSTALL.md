# Install Stop That Shit

These instructions target [`0.2.4`](https://github.com/lennney/stop-that-shit/releases/tag/0.2.4).

For local checkout validation, use the flow under
[Local Guard development](#local-guard-development).

If an agent is doing the installation for you, give it
[`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md). That guide separates commands
the agent can run from the Hook review that you must complete yourself.

## Claude Code: Skill + Guard

The Guard requires Node.js 18 or newer. From the local checkout root, add the
checkout as a local Claude marketplace, then install the plugin:

```bash
claude plugin validate .
claude plugin marketplace add ./
claude plugin install stop-that-shit@stop-that-shit
```

Restart Claude Code after installation. The packaged manifest registers:

- `SessionStart` — injects the current contract into a new session;
- `UserPromptSubmit` — reads host-neutral `$stop-that-shit ...` directives,
  natural explicit corrections, and the direct `/stop-that-shit:stop-that-shit
  ...` slash form. Handling the slash form here keeps direct Skill invocation
  armed even on hosts that do not expose the `UserPromptExpansion` event;
- `PreToolUse` — classifies covered actions and can return permission deny;
- `SubagentStart` — injects the current contract into a started subagent. Agent
  budget enforcement happens earlier on `PreToolUse` for the `Agent` tool;
- `PostToolUse` — reads available delegation results;
- `PostToolUseFailure` — preserves capacity when completion is unproven;
- `PermissionDenied` — releases a reservation for a call confirmed not started;
- `SessionEnd` — preserves unresolved activity rather than assuming completion.

Hosts that expose `UserPromptExpansion` may register it for earlier,
pre-expansion arming; the adapter keeps that handler, but the packaged
`hooks/hooks.json` stays limited to events every supported host accepts.

## Codex: Skill + Guard

The Guard requires Node.js 18 or newer. Add the repository as a Codex
marketplace, then install the plugin:

```powershell
codex plugin marketplace add lennney/stop-that-shit --ref 0.2.4
codex plugin add stop-that-shit@stop-that-shit
```

Restart Codex after installation.

## Verify the source

Inspect these executable surfaces before trusting them:

- `hooks/hooks.json` and `hooks/stop-that-shit-claude.cjs` for Claude Code;
- `hooks/codex-hooks.json` and `hooks/stop-that-shit.cjs` for Codex;
- `src/adapters/`;
- `src/`

From a local checkout, run:

```powershell
npm ci
npm test
npm run eval
npm run release:check
```

## Review the packaged Hooks

Codex records trust for the Hook definition hash, so inspect each Stop That Shit
command before trusting it. Start a fresh Codex CLI TUI and enter `/hooks`.

Compare the plugin's entries with [`hooks/codex-hooks.json`](hooks/codex-hooks.json).
Review the handlers in the installed tag's manifest. The current entries cover:

- `UserPromptSubmit` reads the task mode and explicit boundaries;
- `PreToolUse` checks a supported action before it runs;
- `PostToolUse` reads supported delegation results;
- `SessionEnd` does not prove that unresolved children have completed.

After review, confirm that the handlers listed by the installed definition are
active. Other plugins can add entries, so compare sources rather than total row
counts. This tag does not register `Stop`, `SubagentStart`, or `SubagentStop`
for Codex, and does not automatically continue a finished turn. Subagent events
from older Codex configurations remain ignored; they do not prove completion or
release capacity.

Some Codex Desktop builds send `/hooks` as an ordinary message. In that case,
complete the review in the CLI TUI and restart Desktop. An update may require
another review because Codex records trust against the Hook definition hash. Do
not bypass Hook trust for ordinary installation. See the official
[Codex Hook trust documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## Directive entry

Submit one `$stop-that-shit` directive on the first non-empty line, outside
quotes and code blocks. Up to three leading spaces are accepted; four spaces
or a tab indicate a code example. Put task text after `--`, `: `, or a newline.
Do not put an introduction before the directive. Embedded examples do not set
directive fields. Unknown fields and conflicting values return an error and
preserve the previous contract; submit a corrected directive before continuing.

Natural-language mode corrections also skip code examples, explicit Markdown
quote lines, and quoted text. For example, adding a `review only` example to
README does not switch an active edit task to review.

Chinese observation objects such as `只观察实际定时轮次` preserve the existing
contract. Standalone `只观察` still selects monitor; `只观察，不要修改代码`
selects review. Heartbeat XML does not establish a trusted directive source.
To restore an authorized change, send `$stop-that-shit change -- ...` as a
direct message with the directive on the first non-empty line. Use the host
plugin manager directly to disable or uninstall the plugin when needed.

Codex and Claude return a prompt-block response for an invalid directive.
Pi handles the input without starting a model turn. OpenCode and Hermes add
error context and pause tool calls until a corrected instruction clears the
error. A valid watch/off directive also clears that pause. This input rejection
does not change the previous contract or the shared watch/off policy.

## Upgrade

Update the plugin or standalone Skill through its host installation flow, then
restart or reload. Checking a version is not an update. Codex users must inspect
and trust new or changed Hook definitions before those handlers can run.

`agents=N` now means reserved concurrent capacity, not cumulative calls. New
sessions default to unlimited; migration preserves valid existing limits,
including `0`. Schema 4 retains unresolved legacy activity. A finite Guard
needs matching terminal evidence or a new host session; an upgrade or session
end does not clear that activity.

### Delegation capacity and uncertain completion

`agents=N` reserves concurrent capacity; `0` denies new delegation. A parallel
batch is checked as a whole, while a serial Pi `chain` reserves one slot.
Confirmed completion releases the associated reservation; a stop request,
session end, or unknown result does not prove completion. Under a finite limit,
Claude `SendMessage` and OpenCode `task_id` resume calls are denied because the
hosts do not supply a run generation that would make later completion safe to
attribute. Calls allowed under watch/off or an unlimited budget may leave
unresolved capacity when switching back to a finite Guard. Start a new host
session if that activity cannot be resolved. Valid legacy budgets, including
`0`, survive schema migration. See the [adapter contract](HOST-ADAPTER-CONTRACT.md)
for the host-specific evidence and lifecycle rules.

## Run a smoke test

### Claude Code

Use a disposable repository. First arm read-only review:

```text
/stop-that-shit:stop-that-shit review -- Review this repository. Report findings; do not edit.
```

A covered `Write`, `Edit`, `NotebookEdit`, `EnterWorktree`, mutating
`Bash`/`PowerShell`/`Monitor` command, or unknown shell command must not run
under the armed non-mutating contract. Then switch:

```text
/stop-that-shit:stop-that-shit change -- Create scratch/sts-smoke.txt containing the word pass.
```

That narrow write should proceed. For a file-lock test:

```text
/stop-that-shit:stop-that-shit lock change files=scratch/sts-smoke.txt -- Change only this file.
```

A covered write to a different path should be denied.

### Codex

In a disposable repository, start a review task:

```text
$stop-that-shit review -- Review this repository. Report findings; do not edit.
```

A covered write must be denied. Then explicitly switch the contract:

```text
$stop-that-shit change -- Create scratch/sts-smoke.txt containing the word pass.
```

The narrow write should proceed. This checks installation and contract
switching. It does not prove a general improvement in model behavior.

For the three-arm baseline/instruction/plugin test, read
[`evals/codex-paired/README.md`](evals/codex-paired/README.md). It starts no paid
sessions unless you pass `--run`.

## OpenCode: install from GitHub

OpenCode V1 1.18.18 or newer can install this repository directly from GitHub
without a checkout or npm publication:

```bash
opencode plugin github:lennney/stop-that-shit -g
```

The command installs the package into OpenCode's cache and adds the GitHub spec
to the global OpenCode configuration. Package lifecycle scripts are not run.
Restart OpenCode, then set a contract with the host-neutral form:

```text
$stop-that-shit review -- Review this diff; do not edit.
```

The GitHub package installs the executable Guard. It does not automatically
register the bundled Skill or an `/sts` alias. To add only the optional alias,
put this entry in your OpenCode configuration:

```json
{
  "command": {
    "sts": {
      "description": "Set the Stop That Shit task contract",
      "template": "$stop-that-shit $ARGUMENTS"
    }
  }
}
```

OpenCode V1 denies covered actions by throwing before tool execution. `deps=ask`
and `hash=ask` therefore stop the action and ask you to submit a new explicit
`allow` contract; they do not open a second interactive permission prompt.

Contract state and runtime metadata use `stop-that-shit/` below the OpenCode
state directory on Unix (`XDG_STATE_HOME` or `~/.local/state`) and below
`LOCALAPPDATA/opencode` on Windows. A plugin `dataDir` option overrides this.
OpenCode V1 currently has no external-plugin uninstall
subcommand; remove `github:lennney/stop-that-shit` from the global
configuration's `plugin` list, then restart OpenCode.

### OpenCode V2

The V2 adapter in this checkout targets OpenCode **2.0.18**. It shares the same
package and policy core with V1; V1's minimum remains **1.18.18**. V2 support
starts with release 0.2.4.

For local acceptance, install this checkout's dependencies with
`npm ci --ignore-scripts`, then configure its **package directory**:

```json
{
  "plugins": [
    { "package": "/absolute/path/to/stop-that-shit" }
  ]
}
```

On Windows, use a path such as `C:/projects/stop-that-shit`. OpenCode 2.0.18
ignores explicitly configured single-file paths; point at the directory that
contains `package.json`. A packed local artifact can instead be installed with
`npm install --ignore-scripts /path/to/stop-that-shit.tgz`; configure the installed
`node_modules/stop-that-shit` directory. This does not require lifecycle scripts.

The V2 CLI command is
`opencode plugin add github:lennney/stop-that-shit`. V2 `plugin add` accepts npm
and Git sources, not local `.tgz` files. Local packed-host acceptance does not
establish GitHub-source installation; use the directory route for a local checkout.

Restart OpenCode and use the same `$stop-that-shit review` / `change` commands.
For noninteractive `opencode run`, pass the directive through stdin: these
tested CLI versions quote positional messages containing spaces, which makes
the directive quoted text instead of an instruction.
V2 uses a typed tool error for a Guard denial, allowing the session to continue
with permitted actions. `deps=ask` and `hash=ask` still require an explicit new
contract. The optional `/sts` alias above is a V1 configuration example.

V2 reads delivered root-session user messages, ignores synthetic and child
instructions as authority, and injects context before model requests. Native
`shell`, `patch`, `write`, `edit`, and `subagent` calls use the shared policy.
Finite `agents=N` contracts reject `subagent` continuation via `sessionID`;
start a new child instead. Unknown child outcomes retain reserved capacity.
Code Mode's direct JavaScript/network effects are not fully covered by tool
hooks. In review mode its unknown outer `execute` action is denied by the
existing policy; permitting it in change mode does not establish full coverage.

To remove the V2 plugin, remove its entry from `plugins` and restart. Keep the
same `dataDir` if one was configured. V2 plugin storage holds processed message
IDs and pending status/runtime query replies until delivery or session deletion.
Contract state and runtime evidence retain their existing format.

Maintainers can run the packed-host checks with `STS_OPENCODE_V1_BIN` and
`STS_OPENCODE_V2_BIN` set to the respective executables:
`node --test test/opencode-dual-smoke.test.mjs`. The checks use a local model
stand-in and verify denial, continued reading, and explicit change after restart.

## Hermes Agent CLI

Requires Node.js 18 or newer.

```fish
hermes plugins install lennney/stop-that-shit/.hermes-plugin --no-enable
hermes plugins enable stop-that-shit
hermes plugins list
```

After enabling, CLI users must start a new Hermes CLI process or session. Gateway
users must run:

```fish
hermes gateway restart
```

These steps are not required every time the plugin is used. Restart the
corresponding Hermes process only after enabling, disabling, updating, rolling
back, or reinstalling the plugin.

## Pi Coding Agent

The Pi adapter is tested with `@earendil-works/pi-coding-agent` `0.84.4`, which
requires Node.js `22.19.0` or newer. Pi packages execute with full system access;
review the source and use a pinned release before installing it from Git.

From a checkout that contains the Pi adapter, install it globally:

```bash
pi install /absolute/path/to/stop-that-shit
```

Add `-l` for a project-scoped installation. The tagged release contains
the Pi adapter; use this pinned Git ref instead of an unpinned branch:

```bash
pi install git:github.com/lennney/stop-that-shit@0.2.4
```

Start a new Pi process, or run `/reload` in the TUI after changing package
resources. Arm the Guard with either form:

```text
/skill:stop-that-shit review -- Review this diff. Report findings; do not edit.
$stop-that-shit review -- Review this diff. Report findings; do not edit.
```

Pi contract changes submitted while an Agent turn is streaming are not applied
to that turn; submit them again after Pi is idle. The adapter enforces parent
budgeting for the documented optional `subagent` tool, but does not claim that
separate child Pi processes inherit the contract. Remove the same source with
`pi remove <source>`.

## Optional: Skill only

If you do not want command Hooks, install only the advisory Skill. For Claude
Code, copy the Skill into the user skills directory:

```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

For Codex, ask the built-in Skill Installer to install the shared Skill folder:

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.2.4/skills/stop-that-shit
```

To install only Stop That Shit Slop from the tagged checkout:

```bash
npx skills add ./skills/stss --global
```

Start a new task so the host discovers it. Skill only needs no Hook trust and
has no runtime enforcement. It is advisory, model behavior can vary, and your
existing sandbox and approval settings still apply.

## Local Guard development

The repository includes `.agents/plugins/marketplace.json`. Install a local
checkout with:

```powershell
codex plugin marketplace add <local-checkout-root>
codex plugin add stop-that-shit@stop-that-shit
```

Run local validation from the checkout root:

```powershell
npm ci
npm test
npm run eval
npm run eval:paired -- --dry-run
npm run release:check
```

The paired command prints a 144-cell plan without calling a model. Before using
`--run`, read the [live Codex comparison guide](evals/codex-paired/README.md).
Live runs require a dedicated Codex home with only this plugin enabled.

## Check for updates

With the package executable installed:

```bash
sts doctor --check-update
```

From a source checkout:

```bash
npm run sts -- doctor --check-update
```

Only this explicit command queries GitHub Releases. It returns `installed`,
`latest`, and `releaseUrl`. It does not install updates or display reminders
during startup or tasks. Standalone STSS updates remain under the host or Skill
Installer update flow.

## Disable or uninstall

Use `/hooks` to disable the Codex Guard immediately, then remove the plugin and
marketplace when no longer needed. Skill only can be removed separately from
the host Skills directory.

```powershell
codex plugin remove stop-that-shit@stop-that-shit
codex plugin marketplace remove stop-that-shit
```

For a Skill-only installation, remove its exact installed directory, then start
a new Codex task:

```powershell
Remove-Item -LiteralPath "$env:CODEX_HOME\skills\stop-that-shit" -Recurse -Force
```

If `CODEX_HOME` is unset, the default Skills directory is
`$HOME\.codex\skills\stop-that-shit`. Check the resolved path before removing
it.

Claude Code plugins are removed with the host's plugin controls. Claude Code
cleans up `CLAUDE_PLUGIN_DATA` when the plugin is uninstalled from its last
scope unless you uninstall with `--keep-data`.

The Guard stores per-session contracts and delegation state, metadata-only
runtime events, and manual labels in the host-provided data directory
(`PLUGIN_DATA` for Codex, `CLAUDE_PLUGIN_DATA` for Claude Code).
Review that directory separately if you uninstall. See [PRIVACY.md](PRIVACY.md)
for the distinction between session state and runtime events.

## Oh My Pi (unreleased candidate)

The OMP Extension is checked with `@oh-my-pi/pi-coding-agent` `18.4.4`.
Published STS `0.2.4` does not contain it. Use a local checkout or an extracted
candidate package that contains `omp/stop-that-shit.ts`:

```bash
omp -e /absolute/path/to/stop-that-shit/omp/stop-that-shit.ts --skills /absolute/path/to/stop-that-shit/skills --sts-contract "review agents=0 -- inspect"
```

Review the source before accepting OMP's extension trust prompt. Keep the
OMP entrypoint explicit: the package's `pi.extensions` field selects the Pi
adapter. `--skills` loads both advisory Skills; `--sts-contract` sets the root
contract before tools run, including headless sessions.

In an idle root session, use `/sts review -- ...`, `/sts change -- ...`, or
`/sts status`. These native commands finish without a model turn. Invalid
commands preserve the previous contract. The TUI also accepts first-line
`$stop-that-shit` and `/skill:stop-that-shit` input. OMP 18.4.4 does not emit
the Extension `input` event for RPC/SDK prompts, so use `/sts` for RPC mode
changes and `--sts-contract` for print/SDK startup. A directive embedded in
a model prompt cannot replace that control path.

With a finite `agents=N`, `write agent://…` is rejected because it can wake
untracked work. Use a new `task` call for tracked delegation. Reading `proc://…`
and cancelling with `write proc://<id>/kill` remain available. Ordinary process
input is not classified as a filesystem write.

Contract input received mid-turn is handled with a request to resubmit while
idle. Extension-generated input and child commands cannot grant root authority.
Unreadable or malformed saved child links preserve the file and allow read-only
recovery. Restore a known-good link or start a new root session. Start a new OMP
process after changing the adapter.
To stop loading it, omit the Extension and Skills arguments on the next launch.

Packed native CLI/RPC checks observed review denial with no file created,
continued reading, and an allowed change write. Native child-executor checks
observed root inheritance, rejected child authority, completed-slot reuse,
and a permitted child write. These checks use a deterministic local provider.
The interactive TUI also passed these paths with a local provider, including
native task completion and rejection of a reused task execution ID.
Git-source installation remains unverified.
