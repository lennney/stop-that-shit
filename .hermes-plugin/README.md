# Stop That Shit Hermes Plugin

This directory is the only Hermes integration entrypoint. It contains the native
Hermes Agent plugin and its self-contained Node runtime bundle.

## Install and verify

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

## Runtime path

```text
Hermes native Plugin
  -> .hermes-plugin/__init__.py
  -> .hermes-plugin/runtime/stop-that-shit.cjs
  -> existing src/ policy modules bundled into one runtime
```

`__init__.py` is the only Hermes host entrypoint. It invokes the generated
runtime synchronously through Node and preserves the existing fail-open
behavior for missing Node, invalid output, runtime errors, and timeouts.

## Build and verify the bundle

```text
npm run hermes:build
npm run hermes:check
node --test test/hermes-hook.test.cjs test/hermes-plugin-package.test.cjs
```

The runtime is generated from the existing `src/` module graph by
`scripts/build-hermes-plugin.cjs`. Do not edit the generated file manually.
The bundle must run when only `.hermes-plugin/` is copied to an installation
location; it must not depend on `../src` or the development checkout.

## Current coverage and failure semantics

- `pre_llm_call` may return `{ "context": "..." }` for the current user turn.
- `pre_tool_call` may return `{ "action": "block", "message": "..." }` before a tool executes.
- Missing Node, timeout, invalid JSON, runtime failure, or empty output fails open
  as no plugin result.
- Other Hermes surfaces are not claimed by this plugin.
- This plugin does not modify Hermes configuration automatically and is not a
  security sandbox; host execution effects remain outside its observation.
