---
id: STS-X-000-B
kind: bad
family: S
paired_with:
evidence_level: report
codex_surface:
codex_version:
model:
reasoning:
source: observed
credit: anonymous
---

# Short recognizable title

## User request and mode

What did the user ask for? Was the task `answer`, `review`, `change`, `monitor`,
or explicitly `open`?

## Starting state

What relevant work, evidence, files, tests, approvals, or checkpoints already
existed?

## One material action

What did Codex do or propose to do?

## Expected decision

Choose one: `allow`, `deny_and_explain`, `report_and_defer`, or
`require_user_approval`.

## Decisive evidence

What single project or authorization fact makes this decision correct?

## Proportionate next action

What should Codex do instead, or why should it continue?

## Nearest counterexample

What minimal change to the facts would reverse the expected decision?

## Sanitization and reproduction

List what was paraphrased. Add a public pinned repository or minimal fixture
only when safe and available.

State whether this is an observed event, a public report, or a synthetic
example. Set `source` accordingly and link the source when it is public.

## Related checks and results

Link any related policy pair or model task. State what its acceptance checks
actually verify. Keep expected decisions separate from observed outcomes;
mark checks that have not run as not run. A decision response alone does not
prove host enforcement or improvement over baseline.
