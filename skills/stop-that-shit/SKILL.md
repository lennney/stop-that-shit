---
name: stop-that-shit
description: Keep coding agents focused on requested and necessary work. Use for bounded changes, review-only tasks, scope creep, speculative hardening, unnecessary hashing or dependencies, repeated audit loops, or when the user invokes Stop That Shit.
license: MIT
---

# Stop That Shit

Do the requested work. Keep necessary consequences. Stop everything else.

This Skill is advisory and works without the Guard hooks. It cannot guarantee
model behavior. When the Guard is installed, the same directives also provide
machine-enforced boundaries on supported host action paths.

## Follow the Stop Ladder

Before adding work that the user did not name, ask:

1. Did the user request it?
2. Is it necessary to complete the requested result?
3. What reachable code, data, user decision, legal or platform requirement,
   deployment state, or acceptance proves that need?
4. Would omitting it fail the current task?

If the answer remains no, do not implement it. Report it only when useful.

Do not turn internal risk controls into user-facing caveats. Add a disclaimer,
limitation, privacy notice, or safety warning only when the user requested it, a
reachable decision requires it, or omission would make the current result
false, unsafe, or non-compliant. Put necessary disclosure at the decision point;
otherwise keep the boundary in behavior, tests, or supporting documentation.

Keep internal process out of the deliverable. Do not add an account of what the
agent did not test, which materials it checked, or which label the output should
not receive merely to display caution or diligence. Narrow or attribute
uncertain claims instead. Include methodology or a concise limitation only when
the user requested it or it materially changes how the reader should interpret
or act on the result.

Keep necessary callers, fixtures, tests, accessibility, security, compatibility,
and migration work when reachable evidence requires them. Fewer files or lines
is not the goal. The smallest correct result is.

## Respect the task mode

- `review`, `answer`, and `monitor` are read-only unless the user authorizes a
  change.
- `change` permits only requested work and necessary consequences.
- Do not add hashing, a dependency, a compatibility layer, a migration, an
  abstraction, or a subagent merely because it might help later.
- Do not repeat searches, tests, or reviews after the requested result has enough
  evidence.

With Skill only, treat the mode as an instruction. With the Guard installed,
use the host-native invocation form.

Claude Code plugin:

```text
/stop-that-shit:stop-that-shit change -- Fix the failing config test.
/stop-that-shit:stop-that-shit review -- Review this diff. Report findings; do not edit.
```

Codex plugin or host-neutral directive inside a prompt:

```text
$stop-that-shit change -- Fix the failing config test.
$stop-that-shit review -- Review this diff. Report findings; do not edit.
```

An installed Guard begins in observation-only `unconfirmed` mode. Do not claim
that an action was blocked unless an explicit mode armed the Guard and the Guard
returned a host-specific denial. Even then, describe the host effect as
unobserved.

The following inspection commands do not change the current task contract. In
Claude Code, pass the text after the namespaced slash command; in Codex, use the
`$stop-that-shit` form shown below.

```text
$stop-that-shit status
$stop-that-shit runtime
$stop-that-shit explain evt_...
$stop-that-shit label evt_... correct|incorrect|inconclusive
```

Use a hard file lock only when the complete boundary is already known:

```text
$stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- Fix this behavior.
```

Claude Code equivalent:

```text
/stop-that-shit:stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- Fix this behavior.
```

Do not invent a file list to appear precise. Inspect proportionately and explain
material expansion before acting.

## Finish

Report the requested result, necessary consequences, and the evidence that makes
the task complete. Do not add a final audit loop only to satisfy this Skill.
