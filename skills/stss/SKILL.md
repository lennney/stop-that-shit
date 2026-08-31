---
name: stss
description: Reduce defensive disclaimers, stacked hedging, and self-protective narration in proposals and decision-facing writing. Use when the user asks to rewrite or audit a proposal, plan, research contribution, executive summary, or similar text for directness. Do not use for ordinary code work or unrelated prose.
license: MIT
---

# Stop That Shit Slop

别再废话。

Make the point without writing for an imaginary critic. Preserve any limitation that changes the reader's decision.

## Stay in scope

Reduce defensive wording in decision-facing text. Do not classify text as AI-written, promise to remove an "AI voice," humanize unrelated prose, or perform a general style cleanup.

Judge sentences by their decision use, not by who or what may have written them.

## Select the mode

- `rewrite`: Return a tighter version. This is the default when the user provides text without a mode.
- `audit`: Identify defensive writing and propose the smallest useful fix. Do not rewrite the full text.

Follow an explicit mode. Infer the mode from the request only when none is given.

## Record the claims

Before editing, build a private Claim Ledger from the supplied material:

- facts and numbers;
- named actors and sources;
- evidence strength;
- stated uncertainty and scope;
- the action requested from the reader.

Do not print the ledger unless the user asks for it. Do not add facts, sources, numbers, certainty, or causality.

## Test each defensive sentence

Apply the Sentence Consumer Test:

1. Who will use this sentence?
2. What decision does it change?
3. What becomes false or misleading if it is removed?

Choose one action:

- `DROP`: It only narrates diligence, anticipates criticism, apologizes, or says what the document does not attempt.
- `CALIBRATE`: It contains real uncertainty but uses stacked hedges. Keep one precise limitation.
- `RELOCATE`: It matters, but interrupts the main claim. Move it next to the affected claim or decision.
- `KEEP`: It changes a legal, safety, financial, methodological, contractual, or scope decision.

Do not decide from a keyword alone. The same phrase can be waste in one context and necessary in another.

## Rewrite

1. Lead with the requested claim, decision, or proposal.
2. State scope positively: say what the work covers.
3. Replace stacked hedges with one evidence-matched qualifier.
4. Remove internal process narration unless the process is requested or material.
5. Put a necessary limitation beside the claim it limits.
6. Compare the result with the Claim Ledger.

Return only the requested artifact unless the user asks for commentary. If the text is already direct and faithful, return it unchanged.

## Audit

Report only actionable findings. For each finding, give:

- the span or sentence;
- `DROP`, `CALIBRATE`, `RELOCATE`, or `KEEP`;
- the decision reason;
- the smallest replacement when one is needed.

Use `NO_DECISION_CONSUMER` when a sentence has no reader decision to serve. If there are no actionable findings, say so and stop.

## Check the claim diff

Before returning the result, verify:

- no supplied fact, number, source, or actor disappeared without reason;
- no new fact, number, source, or actor appeared;
- uncertainty did not become certainty;
- correlation did not become causation;
- a requested or decision-relevant limitation remains visible.

Run one claim-preserving pass. Do not add a score, a probability that text is AI-written, a change diary, or repeated self-review.

Read [references/examples.md](references/examples.md) when the boundary is ambiguous or the user asks for examples.
