# Client profit control

Profit control is the v0.10 operating surface for products and books across client workspaces. It joins platform-attributed advertising facts to an independent business source while keeping every item, asset, mapping, test, wave, budget pool, and optimizer run inside one client membership scope.

## Evidence model

Each profit item represents one exact commerce SKU or one book format identified by ISBN and optional ASIN. Economics are versioned rather than overwritten: net receipt, variable cost, required profit reserve, learning-loss limit, and daily budget ceiling. A verified version must leave positive room for acquisition.

An item needs an exact campaign mapping and an independent mapping. Meta and Amazon campaign reports provide attributed spend, sales, and purchases. Shopify paid order lines provide SKU receipts, units, and refunds; PBS statement bundles provide title receipts and units. Platform sales never substitute for independent receipts. Stale, missing, partial, or failed sources block scaling.

The decision engine can return `blocked`, `observe`, `test`, `scale`, or `stop`. It uses conservative screening contribution and remaining-loss calculations. These are operating gates and portfolio ranking inputs, not causal proof or a promise of profit.

## Immutable product assets

Commerce tests start with a registered asset version. Each version records its item, type, source reference, SHA-256 content hash, and the operator's rights, claims, and evidence approvals. A fully approved version also requires an approval record. Creating a replacement preserves the old version as `superseded`; the prior bytes and approvals are never edited in place.

Hook tests accept image, video, or copy versions. Headline tests require copy, and landing-page tests require a landing-page version. Audience tests still reference the approved creative context. Book keyword and product-target tests do not use this commerce asset registry because Sponsored Products normally derives its presentation from the listing.

## Candidate queues and measured waves

An operator registers one hypothesis and one variable. Book items accept keyword or direct product-target tests. Commerce items accept hook, headline, audience, or landing-page tests. The generator creates 2 to 300 unique candidates with seed provenance and stages 2 to 20 arms at a time.

Approving a draft creates a setup wave and holds the rest of the library. Before a wave can run, the operator must map every active candidate to a distinct exact source entity beneath a campaign already mapped to the same item:

- a Meta ad for commerce tests;
- an Amazon keyword with the candidate's declared exact, phrase, or broad match type;
- a directly verifiable Amazon `ASIN_SAME_AS` product target for direct-target tests.

Orbit never guesses this identity from a label. All arms in one wave must belong to the same advertiser connection and parent campaign. At setup Orbit rechecks current blockers and approved assets, then freezes source asset hashes, exact bindings, the account reporting timezone, declared calendar window, 1-to-30-day attribution maturity, wave loss boundary, and complete verified economics snapshot. A fully past window is labeled historical. A prospective window must be registered before its start, no more than 90 account-calendar days ahead. A partially elapsed window is rejected. Registering a wave performs no platform write.

Evaluation is unavailable until the attribution window has matured in the frozen account timezone and the bound connection has completed a healthy refresh after that time. The evaluator reads source facts only at the bound entity and frozen dates. It records impressions, clicks, spend, attributed purchases and revenue, CPA, modeled contribution, modeled risk, the reason for every verdict, a per-arm source-fact fingerprint, and a SHA-256 fingerprint for the complete decision packet.

One mature arm can be labeled a **screening leader** when it clears the affordable-acquisition hurdle with at least ten purchases and headroom. Five or more purchases can support a `viable` result. Loss-boundary and below-hurdle rules reject weak arms; sparse or missing response stays `inconclusive`. A leader can remain as the control while the next held challengers enter another bounded wave. Operators can also complete or stop the test, and every transition is audited.

This comparison is an observational screen unless delivery used a valid randomized assignment and outcome design. Platform allocation, selection effects, delayed or corrected attribution, and demand outside the measured channel can change the result. The system deliberately calls the best arm a screening leader rather than claiming causal lift.

## Amazon report coverage

Client-scoped Amazon collection maintains restart-safe Reporting v3 jobs for campaign, advertised-product, keyword, and product-target grains. Keyword and product-target wave evaluation uses those exact target-level facts. The bootstrap Brain also collects source-specific search-term grains for discovery and proposal generation. Pending asynchronous reports keep the last completed evidence visible and do not advance source freshness until collection succeeds.

## Shadow budget allocator

A client budget pool has a daily ceiling, learning ceiling, vertical scope, and reserve percentage. A run includes only currently eligible items, ranks scale evidence before learning tests, obeys each item's daily ceiling, preserves the reserve, and may leave all remaining cash unallocated. Each immutable run stores an evidence fingerprint for review. It performs no platform write.

## Pilot gate and recovery

The pilot gate requires advertising and independent receipt sources, verified economics for every included item, exact mappings with current evidence, and no failed or dead-letter collection jobs. Connection jobs use scheduled exponential retries; exhausted work remains visible for an operator-created retry. Shopify, Meta, and PBS support dated backfills, while Amazon reporting resumes its persisted asynchronous jobs.

Before live use, compare one complete window with both source consoles, resolve every identity, verify economics from current records, and keep actions in observation or shadow mode for a full attribution window. Automated tests use synthetic provider data and cannot validate a real account's permissions, attribution behavior, listing eligibility, or economics.
