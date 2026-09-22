# Delivery plan

Both tracks have equal priority. Milestones are defined by evidence and functioning workflows rather than unsupported completion dates. External Ads API approval and advertiser authorization can proceed while console imports are useful.

## Milestone 0 — implemented local foundation

- Product, Amazon book, and combined portfolio dashboards.
- Separate synthetic demo and empty business workspace.
- Persistent campaign setup, static unit economics, and readiness attestations.
- Normalized daily CSV and one explicit Amazon console CSV profile.
- Atomic import corrections, source freshness, complete-period comparisons.
- Campaign-level contribution screening and a bounded posterior calculation.
- Target explorer for normalized keyword/product-target/creative-cell facts, parent reconciliation, and source-linked next-test drafts.
- Experiment drafts, up to 300 distinct template candidates, small shortlist waves, exports.
- Optional structured OpenAI idea generation with request reservations.
- Saved proposal decisions and a local journal.
- Integration guides, primary-source research, and production architecture.

## Milestone 0.2 — implemented measurement and learning loop

- Immutable test-wave plans and candidate snapshots, with prospective versus historical registration.
- Baseline/challenger mappings to console/report IDs for both portfolios, plus setup-sheet export.
- Atomic local reservations against campaign and experiment allowances.
- Full-window maturity, freshness, coverage, economics, and reconciliation checks.
- Conditional contribution comparison bands accounting for the registered arm count.
- Promising, baseline-leading, below-hurdle, and inconclusive findings.
- Budget/loss review signals, local cancellation, and release of unused planning capacity.
- Immutable recorded findings, correction-aware revisions, and a searchable learning library.
- Evidence-linked follow-up experiments, with optional AI receiving the chosen finding as context.

See [the workflow](EXPERIMENTS.md). This shared work advances part of Milestone 2 while Ads access is being arranged. Live connectors, causal experiments, and spending authority remain separate milestones.

The following milestones describe remaining production work.

## Milestone 0.3 — implemented reporting hub

- Saved account/report contracts and explicit campaign mappings for both portfolios.
- Multi-campaign and target/creative CSV batches with staged row comparisons.
- Atomic application, duplicate protection, stale-preview conflicts, and old-export rejection.
- Immutable applied receipts and paginated before/after observation revisions.
- Correction overlap with the learning library and separate target/campaign accounting.
- Preserved publisher refund adjustments and retained spend on zero-click product days.
- Browser workflows, accessibility checks, and transaction/correction regression coverage.

See [Reporting hub](REPORTING.md). Live OAuth, automated collection, native Meta/TikTok and Amazon target/search-term adapters, and production client authorization remain in the following milestones.

## Milestone 0.4 — implemented brain and book portfolio

- Connector contract with classified errors; a simulated account that supports every read and write, and an Amazon Ads Sponsored Products v3 adapter (token refresh, paginated lists, async reports, keyword/negative/budget writes).
- Verified profile discovery with marketplace, currency, timezone, account type, and region identity.
- Restart-safe Reporting v3 jobs split into 31-day requests, long restatement refreshes, exact contract validation, bounded S3 downloads, pending health, and a success-only watermark.
- Daily campaign, keyword, search-term, and advertised-product ingestion. Live reports retain missing cells as missing evidence rather than fabricated zeros.
- Search-term ingestion at the term/keyword/day grain; keyword cells reuse the target tables.
- Policy engine: negative, harvest, bid-up, bid-down, pause, budget-up, and budget-down proposals with expected prior state, commitment, idempotency key, cooldown, per-run cap, and open-wave hold.
- Operating modes (observe, recommend, supervised, bounded), versioned policy envelope, daily commitment reservation, outbox execution, platform read-back, uncertain-result reconciliation, and a kill switch.
- AI relevance review of harvest and negative candidates, proposal explanations, and provider-agnostic idea generation (Claude default, OpenAI supported), cached and reservation-limited.
- Business ledger import and scorecards that show ledger contribution beside attributed sales.
- Bulk book catalog and individual format editor with same-ASIN units, net-receipt economics, fixed 56-day loss allowances, daily budget ceilings, ASIN/campaign reconciliation, and mixed-title automation holds.
- Background and pending-report cycles, browser journeys, 500-title scale coverage, and regression coverage for restarts, throttling, timezones, partial data, drift, envelopes, policy changes, kill switch, and lost responses.

See [The brain](BRAIN.md) and [Amazon API contract](AMAZON_API.md). Remaining from Milestones 1–3: the OAuth authorization flow, Meta/TikTok/Shopify adapters, encrypted multi-tenant credential storage, product-target and placement actions, independent receipt/royalty reconciliation, and a live supervised pilot.

## Milestone 1 — connected observation, two equal tracks

| Product track                                             | Amazon books track                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Authorized Meta account discovery and Insights collection | Confirm existing Amazon Ads API approval and authorize a pilot advertiser     |
| Shopify scoped order/refund/inventory adapter             | Advertiser OAuth consent flow and production token storage                    |
| Enthusiast registry and creative-ID mappings              | Daily campaign, target, search-term, and placement report contracts           |
| Product release gates and stock readiness                 | PBS book/ASIN/format/publisher mappings and availability                      |
| Independent order contribution reconciliation             | Contract-specific net receipts, costs, returns, and settlement reconciliation |

Shared work: authenticated operator access, client/account scopes, PostgreSQL migrations, encrypted credential storage, background jobs, report raw storage, retry/backfill logic, coverage health, and versioned economics.

**Exit evidence:** source reports reconcile, duplicate imports do not change totals, delayed corrections propagate correctly, account scope cannot leak across clients, stale/partial feeds are visible, and connection cards show verified account state. No bid/budget writes yet.

## Milestone 2 — a useful experiment operating system

| Product track                                                | Amazon books track                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| Creative asset/version registry and claim/rights provenance  | Search-term ingestion and relevance review                       |
| Creative/ad-set/landing-page experiment identity             | Keyword/match-type/ASIN identity and negative-target proposals   |
| Hypothesis → asset brief → approved candidate → measured arm | Discovery → harvested term → exact test → measured target        |
| Product-specific CAC and stock-aware test allocation         | Format-specific break-even ACOS, affordable CPC, and budget pool |

Shared work: immutable experiment plans, target/creative-level outcomes, actual controls, attribution maturity, predeclared loss boundaries, evidence-linked AI analysis, and searchable learning memory.

**Exit evidence:** an operator can trace a hypothesis through one measured screening wave and a confirmation decision, including an honest “inconclusive” result. Variant counts alone are not completion.

## Milestone 3 — supervised execution

Implement exact bid, budget, pause, keyword, and creative operations only for the verified capabilities of each platform/account. Add proposal previews, authorization scopes, atomic reservations, expected-prior-state checks, outbox processing, platform read-back, and uncertain-result reconciliation.

**Exit evidence:** duplicated jobs do not duplicate spend changes; concurrent proposals cannot overcommit a budget pool; revoked approvals and stale evidence stop execution; timeouts reconcile before retry; emergency stop behavior is tested and its limitations documented.

## Milestone 4 — pilot and shadow optimizer

Select one commerce account and one book advertiser, with a small number of ready items and known economics. Observe existing activity, run the optimizer in shadow, compare proposals to operator review, and wait for mature outcomes. Confirm changes against a suitable baseline/control. Exercise loss limits and recovery procedures before widening authority.

**Exit evidence:** reconciled economics, calibrated uncertainty, useful recommendation acceptance/abstention, no unexplained overshoot, auditable outcomes, and a bounded policy the owner actually wants enabled. A positive result is not guaranteed; revising or abandoning an unprofitable offer is legitimate.

## Milestone 5 — bounded autonomy and scale

- Preauthorized policies with durable scope, limits, cooldown, expiry, and revocation.
- Client-specific cash pools and inventory/availability constraints.
- Candidate clustering, prior calibration, drift/fatigue detection, and marginal return estimation.
- Compare constrained allocation policies through replay and live controls.
- Scalable reporting storage/retention only after measured workload justifies it.
- Provider cost accounting, job SLOs, incident recovery, and operator explanations.

**Exit evidence:** autonomy improves the chosen economic objective under controlled evaluation and remains within demonstrated operational limits. More campaigns, model calls, and parameters are not success metrics by themselves.

## Useful owner inputs for the next implementation milestone

These do not block the local foundation already delivered:

1. Confirmation that the partner's connection is approved Amazon Ads API access, where its server configuration lives, and one test advertiser profile authorized for observe-only validation.
2. One pilot publisher/title/format with actual net receipts, print/variable costs, return assumptions, and a learning allowance.
3. One ready Enthusiast SKU with verified costs, stock/fulfillment, approved creative evidence, and Meta account authorization.
4. The deployment target and operator/client access model before exposing this local tool on a network.
5. Optional AI provider configuration and a chosen cost allowance.

The repository contains no request to paste secrets into chat. Credentials belong in the chosen server secret store.
