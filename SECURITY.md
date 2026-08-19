# Security

Stop That Shit is an execution guardrail, not a security sandbox or permission
boundary. It can deny only lifecycle events that the active host surface sends
through covered and trusted Hooks. Specialized tool paths, disabled Hooks,
untrusted Hook definitions, host bugs, or direct user actions may bypass it.

## Supported version

`0.1.0` is the first multi-platform release in the pre-1.0 line. Security and
compatibility support remain best effort.

## Reporting a vulnerability

Do not put secrets, private transcripts, or exploit details in a public issue.
Before public release, the repository owner must enable GitHub private
vulnerability reporting. Until a private channel exists, submit only a
sanitized issue that asks the maintainer to establish private contact.

Useful reports identify the affected revision, host surface and version, Hook
trust state, minimal reproduction, expected boundary, and observed result.

## Maintainer release requirements

- Review executable Hook commands and their transitive local modules.
- Keep all runtime paths inside the installed plugin root or `PLUGIN_DATA`.
- Test denial and Good Case completion together.
- Document known Hook bypasses and failed conformance cases.
- Never describe advisory `watch` behavior as enforcement.
