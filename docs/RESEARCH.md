# Investigation: a contribution-first advertising system

Researched September 20–22, 2026. Both product advertising and Amazon book advertising have equal priority. Pathway currently manages book campaigns in the Amazon advertising console. A business partner believes an API connection exists, but the exact product—Amazon Ads API, Selling Partner API, or Advantage access—and the location of its server configuration still need confirmation. No credentials were requested or inspected.

This document distinguishes observed local implementation, documented platform behavior, and our proposed design. No live accounts were queried and no ads were launched.

## 1. What is already worth building on

### Enthusiast Supply Co.

Inspected the local `enthusiast-supply-co` project, including:

- `marketing/ADS_OPERATING_SYSTEM.md`, `marketing/ad-intelligence.json`, and the performance import contract.
- `scripts/ad-experiments.mjs` and the analyst, pipeline, budget, and Meta connector modules under `scripts/ad-intelligence/`.
- `operations/unit-economics.mjs` and the commerce architecture described in `README.md`.

**Observed:** the current commerce path is Shopify. The project has draft creative registries, versioned test runs, creative fingerprints, aggregate report ingestion, decision memory, an optional structured AI analyst, a read-only Meta Insights connector, and financial/evidence gates. The inspected configuration does not establish active paid campaigns, approved AI spend, or a working Meta connection. Its readiness documentation explicitly treats checked-in campaigns as drafts.

The strongest parts to preserve are:

1. A creative has a stable ID and immutable content version. Editing the asset or landing-page context changes the experiment's identity.
2. Product availability, rights, claims, fulfillment, margin, tracking, and budget are part of the experiment contract.
3. Reports pin currency, timezone, attribution settings, date basis, and campaign/ad-set/creative mappings.
4. Fresh exports replace overlapping historical observations rather than adding duplicate conversions.
5. An AI recommendation cites evidence and has a bounded action vocabulary. It cannot grant itself authority.
6. A signup leader is not a purchase winner. Unequal platform delivery is not a randomized experiment.
7. Its AI cost reservation and financial reconciliation patterns are useful precedents for the larger system.

**Design consequence:** generalize these contracts into reusable adapters and account-scoped services. Do not embed a second copy of Enthusiast's private operational registries. Its one-project CLI workflow is a useful starting point, not a finished multi-client allocator.

### PBS HQ

Inspected `PBS_HQ/amazon/README.md`, the Amazon view and period-resolution modules, related schema paths, and the frontend's Amazon integration structure.

**Observed:** PBS HQ pulls Amazon Advantage vendor data through **Selling Partner API (SP-API)**. Its capture processes include catalog mapping, settled sales, real-time demand, inventory/traffic, forecasts, and purchase orders. The map resolves EAN/ISBN/ASIN through internal book and publisher identifiers. Distributor view is explicitly part of the reporting key.

Important accounting boundaries already learned there:

- All-vendor manufacturing demand, PBS consignment sell-through, and Amazon ad-attributed sales answer different questions.
- `shipped_cogs` is Amazon's vendor procurement cost, not publisher receipts.
- Publisher earnings derived from list price and consignment units are estimates, not remittances. An inspected application-specific percentage must not become a universal advertising margin.
- Ordered real-time demand and settled shipped sales cannot be silently combined.
- A completed job can still have missing coverage; partial success must remain visible.
- Source settlement boundaries should clamp selectable periods. Comparisons need comparable coverage.

**Design consequence:** PBS should supply book identity, authorized publisher scope, availability, and independently reconciled economics. It cannot supply advertising authorization or prove which incremental orders an ad caused. Preserve publisher isolation and report grain when integrating.

### Other local context

A targeted inspection of `pbs-MCP-Server` and `sages-brain` confirmed related publisher/reporting context but did not establish an existing reusable Amazon Ads execution integration. No customer correspondence, reports, credentials, or private records were copied into this public repository.

## 2. Platform findings

### Amazon Ads is a separate integration

Amazon describes its Ads API as the programmatic interface for advertising management and reporting, including integrations built by partners serving advertisers. Access and advertiser authorization are separate from the existing SP-API reporting connection. Orbit can now discover Ads profiles and run its Reporting v3 contract when approved credentials are configured; CSV workflows remain available. [Amazon Ads API overview](https://advertising.amazon.com/about-api)

The official developer documentation and Amazon's published Postman collections were checked on September 22, 2026. The implemented contract covers profile discovery, Sponsored Products v3 entity reads/writes, and the `spCampaigns`, `spTargeting`, `spSearchTerm`, and `spAdvertisedProduct` daily reports. Account authorization, quota behavior, and actual profile/report parity remain pilot verification items. See [the implemented contract](AMAZON_API.md), [Getting started](https://advertising.amazon.com/API/docs/en-us/guides/get-started/overview), and [Reporting v3](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/overview).

### Book tests are mostly targeting and bidding tests

Sponsored Products supports automatic discovery, keyword targeting, product targeting, match-type choices, and negative targeting. This creates a useful search process: discover relevant terms, examine search-term performance, promote promising terms into controlled tests, and review waste before excluding it. [Amazon targeting guide](https://advertising.amazon.com/library/guides/targeting-with-sponsored-products)

Book campaigns also require eligible, available titles and policy-compliant assets. Format, country, and ad-product eligibility need verification in each account. Sponsored Products ordinarily inherits the book listing rather than offering unlimited independent image/headline variations; inventory, cover, metadata, reviews, price, and product-page quality can matter outside the ad manager. [Amazon's author guide](https://advertising.amazon.com/library/guides/authors-guide-to-sponsored-products)

**Our design:** partition automatic discovery, broad/phrase exploration, exact confirmation, and product/ASIN targeting. Record source search term, match type, book format, placement, bid policy, and attribution contract. Never rename an exploratory keyword as a proven winner solely because its retail ROAS is positive.

### An average daily budget is not a hard cash boundary

Amazon documents the ability to spend up to 100% above an average daily budget on a given day, with choices for additional spend settings. Some introductory guides still describe a smaller percentage. Read the actual account's settings and applicable current API documentation; do not derive cash safety from an introductory example. [Amazon daily budgeting policy](https://advertising.amazon.com/resources/whats-new/sponsored-ads-daily-budgeting-policy-and-options)

**Our design:** inventory platform budget rules, account settings, dynamic bid behavior, and placement adjustments before making a proposal. Maintain separate client cash/loss allowances and conservative commitments. A pause is not instantaneous, and delayed reporting means software monitoring cannot guarantee zero overshoot. The first live pilot needs operator-agreed headroom and a tested stop procedure.

### Attribution is not a receipt, and a recent zero is not final

Amazon's reporting guidance distinguishes attribution timing and retail sales from KDP sales/royalty reporting; orders, shipping, returns, and page-read royalties can arrive on different schedules. Book formats and halo rules require care. The public help result was available in search, but the full help page required a session; confirm the exact account/report definitions during onboarding. [Amazon attribution reference](https://advertising.amazon.com/help/GX7KDKHMWQYMJ385)

**Our design:** pin the report's attribution window and date basis, refresh trailing cohorts, and keep attributed retail sales separate from business receipts. Never count the same units again by adding SP-API demand to ad conversions. Treat Kindle page-read revenue and series read-through as separate estimates with provenance, not free margin used to justify a higher bid.

### Product advertising should complement platform optimization

Enthusiast already contains a scoped Meta Insights collection pattern. The official Meta Insights page returned a rate-limit response during this investigation, so current permissions, account review, API version, attribution parameters, and experiment capabilities still need verification before a live adapter is implemented. [Meta Marketing API](https://developers.facebook.com/docs/marketing-api/), [Insights API](https://developers.facebook.com/docs/marketing-api/insights/)

Our manager should decide **which ideas to test and how much business risk to accept**. The advertising platform still performs auction-time delivery. Rapidly changing bids, audiences, and creative simultaneously makes learning harder; creating hundreds of campaigns at once can fragment evidence.

For causal creative confirmation, use actual exclusive experimental arms where the account supports them. TikTok documents native split tests separately from ordinary algorithmic ad delivery. [TikTok split tests](https://ads.tiktok.com/help/article/split-testing?lang=en)

### Orders and refunds belong in an independent business ledger

Shopify's current integration documentation establishes a GraphQL Admin API boundary for products, inventory, orders, and refunds. Ordinary order access is limited to the recent window unless Shopify approves `read_all_orders`; SKUs are case-sensitive; and inventory quantities such as available, on-hand, incoming, and committed have different meanings. Webhooks need raw-body HMAC verification, retries, delivery deduplication, out-of-order handling, and periodic API reconciliation. A notification should not be mistaken for settled cash. [Admin API access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes), [orders query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders), [inventory item](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem), [webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)

**Our design:** a separate ledger resolves paid order → discounts → refund/return → fulfillment cost → net contribution. Channel attribution stays attached as a modeled relationship. Deduplicated business revenue is not the sum of Meta, TikTok, and other channels' claims. The manual v0.7 contract, readiness controls, reconciliation formula, and future connector boundary are specified in [Product commerce](COMMERCE.md).

### Exploration and exploitation require a model of uncertainty

Thompson sampling is a useful framework for sequential decisions that balance gathering information with using current evidence. It is not a universal guarantee, and its assumptions matter. [Russo et al., A Tutorial on Thompson Sampling](https://arxiv.org/abs/1707.02038)

**Our design:** begin with transparent contribution calculations and an explicitly limited posterior model. Later compare capped allocation policies through offline replay and shadow operation. Add calibrated priors, nonstationarity handling, marginal return models, and randomized confirmation before operational automation. A bandit ranking is not a causal significance certificate.

### The LLM is an idea and interpretation layer

OpenAI's Structured Outputs documentation establishes the schema-constrained response pattern used for this build. The optional integration requests JSON-schema output, validates it again, handles refusals/incomplete responses, and sends `store:false`. It exposes no spending tools. [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

**Our design:** use models for keyword hypotheses, creative briefs, clustering, and evidence-linked explanations. Keep accounting, caps, source validity, and execution permissions in deterministic code. Treat imported copy and catalog descriptions as data, never instructions to the model.

## 3. The profit model that changes the decisions

For one book format in a simplified example:

| Item                                            | Amount |
| ----------------------------------------------- | -----: |
| Retail price                                    |    $20 |
| Publisher net receipts after channel deductions |    $10 |
| Print and other variable costs                  |     $4 |
| Contribution before ads                         |     $6 |
| Desired profit reserve                          |     $1 |
| Maximum acquisition cost at the target          |     $5 |
| Break-even retail ROAS                          |  3.33× |
| Target retail ROAS                              |  4.00× |
| Break-even ACOS                                 |    30% |
| Target ACOS                                     |    25% |

At 2× retail ROAS the campaign spends $10 to acquire a $20 retail purchase, earning only $6 before ads: it loses $4. This is why neither ROAS > 1 nor a universal “good ACOS” is a profit policy.

The general model is:

```text
contribution before ads = actual net receipts - variable business costs
contribution after ads = contribution before ads - advertising cost
target CAC             = unit contribution before ads - profit reserve
affordable CPC         = conversion probability × target CAC
```

The first release uses static verified unit assumptions and imported aggregate purchase counts, then subtracts explicit net-receipt refund adjustments and ad spend. It labels this **modeled contribution**, before fixed overhead. It is not a reconciled ledger, an incrementality estimate, or a company profit statement.

## 4. How to test hundreds without spending on hundreds at once

Separate **idea capacity** from **paid concurrency**. For example, 200 candidates × 100 clicks × $0.50/click would cost $10,000 just to collect that click floor. That floor would still not guarantee sufficient statistical power or purchases.

Our proposed sequence:

1. Generate a broad library with provenance and explicit relevance/claims review.
2. Remove duplicates, unsupported claims, unavailable products, irrelevant terms, and economically impossible cases before any paid test.
3. Allocate a small capped screening wave with a stable control. Preserve the rest as a queue.
4. Wait for the chosen attribution maturity and evidence threshold. Do not repeatedly declare winners by inspecting noisy daily results.
5. Confirm promising candidates with controlled comparisons or incrementality tests where feasible.
6. Scale in bounded steps, measuring **marginal** profit and fatigue after each step.
7. Record the outcome and conditions so future hypotheses can reuse a lesson without treating another client's result as proof.

The current application implements libraries, shortlist limits, campaign-level recommendations, and normalized measured keyword/product-target/creative-cell imports. Target evidence is checked against parent campaign totals and can seed a new draft with provenance. It does **not** automatically map every drafted candidate to a live experimental arm, consume native search-term exports, or execute platform experiments.

## 5. What must be learned from the first pilot

For each track, choose one account and a small number of items with known economics. Observe existing activity before changing it. Validate identity mappings, source freshness, attribution lag, currency/timezone handling, return rates, publisher/shop receipts, and budget semantics. Then compare proposed decisions with the operator's actual review.

The success condition is not a photogenic ROAS chart. It is a reproducible decision that respects the client's limits, can be explained from saved evidence, can be audited after reporting corrections, and improves measured contribution under a fair comparison. An inconclusive or unprofitable result must remain a valid outcome.
