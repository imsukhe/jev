---
name: jev-audit
description: Audit local jev usage records and identify avoidable agent cost. Use when the user asks for jev cost reports, token spending, context bloat, unnecessary tool calls, or cost-reduction recommendations.
---

# jev audit

Run `jev report --json` from the target project. If no usage records exist, state that measured usage is unavailable.

Inspect cost in this order:

1. Input and cache-write tokens caused by repeated context.
2. Tool output larger than needed for the decision.
3. Duplicate searches, file reads, builds, and tests.
4. Unnecessary parallel agents and repeated retries.
5. Model or reasoning escalation that had no evidence-based trigger.

Report measured totals separately from estimates. For each recommendation, state the expected mechanism and the evidence. Never recommend removing security checks, required tests, or user-requested detail simply to reduce usage.

If the report includes a `jev` host entry, that is spend on TypeSafe's JEV model from `jev compact` calls, not host token usage — report it separately, and note it only accrues when compaction is explicitly enabled. Compare it against the context it saved before calling it worthwhile.
