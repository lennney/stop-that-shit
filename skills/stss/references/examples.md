# STSS examples

These synthetic pairs show the boundary between defensive padding and a limit that changes the reader's decision. They are examples, not a banned-word list.

## 1. Proposal disclaimer — DROP unless requested

### Bad Case

**Request:** Rewrite this pilot result for a proposal.

**Before:** We should note that this was only a limited first-round pilot and is not intended to prove that the approach works in every setting. In 120 tickets, 24-hour completion rose from 68% to 76% after automatic triage was introduced.

**Rewrite:** In the first 120-ticket pilot, 24-hour completion rose from 68% to 76% after automatic triage was introduced.

**Why:** The sample and observed result already bound the claim. The unrequested universal disclaimer has no decision consumer.

### Nearest Good Case

**Changed condition:** The approving manager requires the proposal to state that the internal pilot does not represent general deployment.

**Rewrite:** In the internal 120-ticket pilot, 24-hour completion rose from 68% to 76% after automatic triage was introduced. This internal pilot does not represent general deployment.

**Boundary:** Keep a requested limitation that affects approval.

**Claim Diff:** Both versions preserve the sample, metric, and observed change. Neither adds causation.

## 2. Hedge stack — CALIBRATE to one uncertainty

### Bad Case

**Request:** Tighten the schedule statement.

**Before:** We may perhaps potentially be able to finish the migration in roughly six to eight weeks, depending on access approval.

**Rewrite:** We estimate six to eight weeks, subject to access approval.

**Why:** The range and dependency are real. Four layers of uncertainty are not.

### Nearest Good Case

**Changed condition:** Six to eight weeks is the current estimate, and work cannot begin before access approval.

**Rewrite:** The estimated migration time is six to eight weeks after access approval.

**Boundary:** Keep the range and prerequisite. Remove only duplicated uncertainty.

## 3. Negative scope — DROP unless it changes ownership

### Bad Case

**Request:** Rewrite the scope paragraph.

**Before:** This proposal is not a comprehensive redesign and does not try to address every support workflow. It covers intake, routing, and escalation.

**Rewrite:** This proposal covers intake, routing, and escalation.

**Why:** Positive scope is enough when no excluded area changes ownership or acceptance.

### Nearest Good Case

**Changed condition:** The contract assigns billing to another team and requires the exclusion to be explicit.

**Rewrite:** This proposal covers intake, routing, and escalation; billing remains out of scope.

**Boundary:** Keep an exclusion that prevents an ownership mistake.

## 4. Diligence narration — DROP unless the method was requested

### Bad Case

**Request:** Make the recommendation direct.

**Before:** We reviewed the available documents and tried to be appropriately cautious. Although we could not verify every possible edge case, we believe the team should start with the two highest-volume queues.

**Rewrite:** Start with the two highest-volume queues.

**Why:** The recommendation is the deliverable. The diligence monologue does not change it.

### Nearest Good Case

**Changed condition:** The reader explicitly asks how to identify the two highest-volume queues.

**Rewrite:** Start with the two highest-volume queues. Rank them by ticket counts from the previous 30 days.

**Boundary:** Keep a requested method because it makes the recommendation executable.

## 5. Hollow claim — audit; do not invent

### Bad Case

**Request:** Audit this sentence: “Our innovative framework creates significant value through a robust, user-centric approach.”

**Audit:** CALIBRATE — The claim supplies no mechanism or measured outcome. Replace it with the actual mechanism and evidence, or remove it.

**Why:** Direct writing cannot repair missing evidence by fabricating specificity.

### Nearest Good Case

**Changed condition:** The source provides both a mechanism and a measured pilot result.

**Rewrite:** Matching request IDs reduced duplicate tickets by 14% in the pilot.

**Boundary:** Use supplied evidence. Do not invent a number or mechanism to make prose sound concrete.

## 6. Causal boundary — KEEP the evidence boundary

### Bad Case

**Request:** Rewrite an observational pilot result without overstating causation.

**Before:** The pilot clearly proves that automatic triage caused completion to improve from 68% to 76%.

**Rewrite:** During the observational pilot, 24-hour completion rose from 68% to 76% after automatic triage was introduced.

**Why:** Removing hedging is not permission to strengthen the evidence.

### Nearest Good Case

**Changed condition:** Requests were randomly assigned, the control group completed 68%, and the automatic-triage group completed 76% under the prespecified analysis.

**Rewrite:** In the randomized comparison, automatic triage increased completion from 68% in the control group to 76%.

**Boundary:** A randomized comparison can support the causal wording that an observational sequence cannot.

## Already direct

**Before:** The migration will take six to eight weeks after access approval.

**After:** The migration will take six to eight weeks after access approval.

Stop when there is nothing useful to remove.
