# Install Stop That Shit 0.1.0

The current multi-platform release is
[`0.1.0`](https://github.com/lennney/stop-that-shit/releases/tag/0.1.0).

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

Restart Claude Code after installation. The plugin registers four Hook events:

- `SessionStart` — injects the current contract into a new session;
- `UserPromptSubmit` — reads host-neutral `$stop-that-shit ...` directives,
  natural explicit corrections, and the direct `/stop-that-shit:stop-that-shit
  ...` slash form. Handling the slash form here keeps direct Skill invocation
  armed even on hosts that do not expose the `UserPromptExpansion` event;
- `PreToolUse` — classifies covered actions and can return permission deny;
- `SubagentStart` — injects the current contract into a started subagent. Agent
  budget enforcement happens earlier on `PreToolUse` for the `Agent` tool.

Hosts that expose `UserPromptExpansion` may register it for earlier,
pre-expansion arming; the adapter keeps that handler, but the packaged
`hooks/hooks.json` stays limited to events every supported host accepts.

## Codex: Skill + Guard

The Guard requires Node.js 18 or newer. Add the repository as a Codex
marketplace, then install the plugin:

```powershell
codex plugin marketplace add lennney/stop-that-shit
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
npm test
npm run eval
npm run release:check
```

## Review two Hooks

Codex records trust for the Hook definition hash, so inspect each Stop That Shit
command before trusting it. Start a fresh Codex CLI TUI and enter `/hooks`.

Only two events are required:

- `UserPromptSubmit` reads the task mode and explicit boundaries;
- `PreToolUse` checks a supported action before it runs.

After review, both rows show `Installed 1 / Active 1 / Review 0`. `Stop 0` is
expected; the plugin does not install a Stop handler.

Some Codex Desktop builds send `/hooks` as an ordinary message. In that case,
complete the review in the CLI TUI and restart Desktop. An update may require
another review because Codex records trust against the Hook definition hash. Do
not bypass Hook trust for ordinary installation.

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

OpenCode 1.18.18 or newer can install this repository directly from GitHub
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

OpenCode denies covered actions by throwing before tool execution. `deps=ask`
and `hash=ask` therefore stop the action and ask you to submit a new explicit
`allow` contract; they do not open a second interactive permission prompt.

Contract state and runtime metadata are stored below OpenCode's state directory
in `stop-that-shit/`. OpenCode currently has no external-plugin uninstall
subcommand; remove `github:lennney/stop-that-shit` from the global
configuration's `plugin` list, then restart OpenCode.

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

## Optional: Skill only

If you do not want command Hooks, install only the advisory Skill. For Claude
Code, copy the Skill into the user skills directory:

```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

For Codex, ask the built-in Skill Installer to install the shared Skill folder:

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.1.0/skills/stop-that-shit
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

The Guard stores only the active per-session contract in the host-provided data
directory (`PLUGIN_DATA` for Codex, `CLAUDE_PLUGIN_DATA` for Claude Code).
Review that directory separately if you uninstall.
