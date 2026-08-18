# Install Stop That Shit as an Agent

This file is for an agent that is helping a user install Stop That Shit. Keep
the installation narrow. Do not clone the repository, modify the user's host
configuration, copy authentication files, or bypass Hook review.

## Claude Code

1. Confirm that `claude` is available and Node.js 18 or newer is installed.
2. From the local checkout root, validate it:

   ```bash
   claude plugin validate .
   ```

3. Add the local marketplace and install the plugin:

   ```bash
   claude plugin marketplace add ./
   claude plugin install stop-that-shit@stop-that-shit
   ```

4. Ask the user to restart Claude Code or run `/reload-plugins`.
5. In a disposable repository, verify that review stays read-only:

   ```text
   /stop-that-shit:stop-that-shit review -- Review this repository. Report findings; do not edit.
   ```

   Then give explicit change authority:

   ```text
   /stop-that-shit:stop-that-shit change -- Create scratch/sts-smoke.txt containing the word pass.
   ```

Report whether the review attempted a covered write and whether the change
created only the requested file. Do not claim that one smoke test proves a
general improvement in model behavior.

## Codex

1. Confirm that `codex` is available and Node.js 18 or newer is installed.
2. Run these commands one at a time:

   ```powershell
   codex plugin marketplace add lennney/stop-that-shit
   codex plugin add stop-that-shit@stop-that-shit
   ```

3. Ask the user to restart Codex.
4. Ask the user to open a fresh Codex CLI TUI and enter `/hooks`.
5. Stop and let the user inspect and trust the Hook commands.

A correct Guard installation has these two active events:

```text
UserPromptSubmit  Installed 1  Active 1
PreToolUse        Installed 1  Active 1
```

The other events, including `Stop`, should show zero installed Hooks. An update
can require another review because Codex records trust for the Hook definition.
Do not disable or work around this review.

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

## Smoke test

Use a disposable repository. Do not run the write test in the user's active
project.

First, verify that review stays read-only:

```text
$stop-that-shit review -- Review this repository. Report findings; do not edit.
```

Then give explicit change authority:

```text
$stop-that-shit change -- Create scratch/sts-smoke.txt containing the word pass.
```

Report whether the review attempted a covered write and whether the change
created only the requested file. Do not claim that one smoke test proves a
general improvement in model behavior.

## Skill-only fallback

If the user does not want Hooks, install the advisory Skill instead:

```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.0.2/skills/stop-that-shit
```

Ask the user to start a new Codex task after installation. Explain that this
mode has no runtime enforcement and cannot change Codex sandbox or approval
settings.
