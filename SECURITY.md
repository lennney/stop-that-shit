# Security

Stop That Shit is an execution guardrail, not a security sandbox or permission
boundary. It can deny only lifecycle events that the active host surface sends
through covered and trusted Hooks. Specialized tool paths, disabled Hooks,
untrusted Hook definitions, host bugs, or direct user actions may bypass it.

## Supported version

`0.2.1` is the current release in the pre-1.0 line. Security and
compatibility support remain best effort.

## Reporting a vulnerability

Do not put secrets, private transcripts, or exploit details in a public issue.
GitHub private vulnerability reporting is enabled for this repository. Use the
[private security advisory form][private-report] for sensitive reports.

[private-report]: https://github.com/lennney/stop-that-shit/security/advisories/new

Useful reports identify the affected revision, host surface and version, Hook
trust state, minimal reproduction, expected boundary, and observed result.

## Maintainer release requirements

- Review executable Hook commands and their transitive local modules.
- Keep runtime code inside the installed plugin root and state inside the
  host-owned data or configuration directory.
- Test denial and Good Case completion together.
- Document known Hook bypasses and failed conformance cases.
- Never describe advisory `watch` behavior as enforcement.
