# Test waves and the learning loop

Orbit v0.2 connects candidate libraries to measured cells, fixed test windows, and versioned findings. The same workflow serves product creatives and Amazon book keywords. It works with console-managed advertising and normalized report imports while live API access is being arranged.

This release implements **observational screening**. It does not randomize people, create ads, change bids, prove incremental lift, or enforce an external cash cap.

## Operator workflow

1. Set up a campaign with verified economics, attribution, and availability.
2. In **Experiment lab**, generate candidates and shortlist challengers.
3. Open the library and select **Register measurement wave**.
4. Map the baseline and challengers to exact reporting IDs, labels, kinds, and match types. A new ID can be registered before its first report. The operator checks these mappings; Orbit cannot verify platform content yet.
5. Fix the dates, budget, mature loss boundary, click floor, and minimum modeled gain per 100 clicks. The baseline is additional to the shortlisted challenger limit.
6. Download the setup sheet and configure delivery in the advertising console. This is an identity/plan reference, **not** a platform bulk-upload file. Keep creative, destinations, offers, and targeting definitions stable.
7. Import campaign/day totals and target/day facts. Include zero rows only for verified no-delivery days. Refresh the test window as delayed conversions arrive.
8. Inspect **Test waves** and repair missing, stale, or unreconciled evidence. Manage console delivery when a budget or loss boundary is flagged.
9. After maturity, record the result and a note. A limit result can be recorded earlier when evidence is complete and current. Inconclusive and unprofitable results belong in the library too.
10. In **Learning library**, create a follow-up from a current finding. Its source learning ID is retained. If OpenAI is selected, the chosen finding and notes are explicitly untrusted context in the bounded idea-generation request.

The synthetic demo includes a recorded product finding and a book wave ready for review, evaluated at its labeled snapshot date.

## Immutable plans

A wave copies candidate content, reporting definitions, campaign economics, hypothesis, dates, and decision parameters. A SHA-256 plan identifier fingerprints the contract. Later shortlist changes do not rewrite it.

Prospective registration requires a first date after the current UTC day. Historical registration requires a past start and remains labeled **historical review**. Choosing candidates after seeing results can bias a historical finding.

Windows cover 7–56 days, within retained two-year history and the next 90 days. Exactly one baseline and at least one shortlisted challenger are required. Reporting IDs are distinct. A target cannot appear in overlapping wave windows, including cancelled/concluded waves, preventing duplicate evidence and budget accounting. Use a later window or distinct cells for another test.

Commerce arms use creative cells. Amazon challengers currently use keyword candidates; a book baseline can also use an automatic or product target. Product-target generation and independent asset verification remain future work.

## Local budget accounting

Registration uses SQLite `BEGIN IMMEDIATE`. Validation, reporting definitions, the plan, and its journal entry commit or roll back together.

```text
open wave reservation  = max(0, wave budget - observed arm spend in its window)
campaign commitment   = total imported campaign spend + open reservations
experiment commitment = sum(max(budget, observed spend)) for open waves
                      + sum(observed spend) for concluded/cancelled waves
```

New plans must fit campaign and experiment allowances. Existing target reports must reconcile against campaign totals first. Recorded spend is not charged again as a reservation. Cancellation/conclusion releases unused planning capacity while retaining observed spend; report corrections affect subsequent allocation checks.

These coordinate **local plans only**. Platforms can keep spending or report late. Cancelling a local wave does not pause ads. Imported overspend or reduced allowances does not retroactively rewrite earlier plans; the operator must reconcile and manage the console.

The loss boundary uses aggregate **mature modeled contribution before the profit reserve**. Recent cohorts are excluded to avoid treating delayed conversions as settled losses. This can understate current losses until attribution matures. The budget flag uses all imported arm spend, including immature cohorts.

## Evidence gates

Evaluation uses the full registered window, independently of the overview date selector:

- Every completed day requires a parent row and a row for each arm.
- Arm clicks, purchases, spend, and sales cannot collectively exceed matching parent/day totals.
- Every included row needs an export from the last 48 hours.
- Economics and attribution must match the snapshot; current readiness and local monitoring must remain active.
- Mature refunds without matched purchases block per-purchase refund estimation.
- The final click cohort must complete its attribution window before a performance conclusion.
- Every arm needs seven mature days and the registered click floor; otherwise a complete valid wave is inconclusive.

The click floor is not a sample-size/power guarantee. A promising challenger also needs at least 20 mature purchases.

An open measurement wave holds back campaign-level scale recommendations. Earlier increase proposals receive a different evidence fingerprint and cannot be accepted as current. Reduction and evidence-repair signals remain visible; avoiding unnecessary delivery changes does not override a loss or reporting problem.

## Conditional comparison model

```text
p | mature clicks, purchases ~ Beta(1 + purchases, 19 + clicks - purchases)
u = net receipt - variable cost - profit reserve - observed refunds / purchases
c = observed mature spend / mature clicks
modeled contribution per 100 clicks = 100 × (u × p - c)
```

For `k` arms, each beta tail receives `0.05 / (2k)` probability mass. Bounded binary search inverts the existing beta-tail implementation. Transformed endpoints are ordered even if `u` becomes negative. A union bound gives at least 95% joint **posterior** coverage under this conditional model. This is not a frequentist error-rate or causal guarantee. [NIST explains the general multiple-comparison concern](https://www.itl.nist.gov/div898/handbook/prc/section4/prc463.htm); the Bayesian model and thresholds here are Orbit design choices.

A challenger is **ready to confirm** when its lower contribution bound is positive and exceeds the baseline's upper bound by the registered gain. If several qualify, the highest lower bound is chosen for confirmation; this does not establish superiority over every challenger. A clearly stronger baseline is retained. If all upper bounds are negative, no arm cleared the reserve hurdle. Other complete comparisons remain inconclusive.

CPC, refund rate, and economics are treated as fixed. The model omits their uncertainty, correlated clicks, selection bias, fatigue, delivery mix, and counterfactual demand. Conditioning on clicked traffic does not evaluate a creative's full effect on everyone exposed. Genuine randomized experiments require an assignment and outcome design, as distinguished in [Statsig's experiment overview](https://docs.statsig.com/experiments/overview). Use a suitable controlled design for confirmation.

## Findings and corrections

A learning retains the computed result, observed/mature metrics, hypothesis, note, source plan, evidence fingerprint, and promising candidate snapshot. Operators cannot submit custom numerical verdicts. The API recomputes the result in the transaction and rejects stale evidence with HTTP 409.

The first finding concludes the local wave. Repeated identical evidence is idempotent. Corrected facts can produce a new immutable revision that supersedes the old one. Earlier notes and results remain under **Show prior revisions**.

The fact fingerprint ignores export timestamps when numbers are unchanged. Routine refreshes do not invalidate findings. Corrected numbers or changed economics flag old findings, which cannot seed follow-ups until resolved. Mere report aging does not erase a historical snapshot, although recording a new conclusion requires fresh reports. New economics require a newly registered test; old plans cannot be silently repriced.

Dataset/campaign scope applies to plans, exports, conclusions, reuse, and AI context. Local dataset separation is not hosted multi-tenant authorization.

## Limits and connection work

This release supports 200 waves/workspace, 4,000 learning revisions, and 500 target definitions/campaign. Native search-term harvesting, platform experiments, asset verification, and ad execution remain future work. Authorized Ads reporting and independent Shopify/PBS reconciliation are still the next connection milestones; wave and reporting-ID contracts now provide their measurement destination.
