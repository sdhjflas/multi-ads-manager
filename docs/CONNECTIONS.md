# Connected observation control plane

Orbit v0.8 adds one read-only connection system for the product and Amazon-book tracks. It collects source facts, preserves native identities, records health and reconciliation gaps, and feeds the existing profitability gates. A successful API call is not enough to make a source healthy: the selected account must match, the currency must be USD, the response contract must validate, and identities needed by the profit model must reconcile.

No source connection can write an ad, budget, product, order, or publisher record. Amazon execution remains a separate Brain policy path. Credentials saved through Connections always construct the Amazon adapter with writes disabled.

## Shared lifecycle

Each connection belongs to a client workspace and stores:

- provider, external account/profile identity, region, currency, timezone, and granted scopes;
- read-only capabilities and per-capability readiness;
- last attempt, last success, source-as-of date, overlap watermark, and next due sync;
- normalized source-object fingerprints and source-native IDs;
- durable jobs with status, attempt, counts, classified error, and audit events;
- only a `secretConfigured` flag in browser-visible data.

OAuth state is random, SHA-256 hashed at rest, expires after ten minutes, and is consumed atomically once. Shopify callbacks also require the provider HMAC and the exact store identity. Meta exchanges the authorization code and then requests a long-lived user token. Amazon exchanges the Login with Amazon code for a refresh token. PBS currently uses its existing scoped bearer-token boundary.

Jobs classify authorization, throttling, timeout, unavailable, and invalid-contract failures. Transient work retries with exponential delay and moves to a dead-letter state after five attempts; an operator can create a fresh retry without mutating the failed record. Backfills carry a durable cursor. A process restart marks an interrupted running job failed and leaves queued work available for the worker. Verified Shopify webhooks discard the payload after signature verification and enqueue a full source reconciliation, avoiding storage of customer payloads. Successful sources refresh on a 24-hour schedule; `CONNECTION_SYNC_INTERVAL_MINUTES` controls the due-job scan.

## Credential boundary

Set `ORBIT_VAULT_KEY` to 32 random bytes encoded as 64 hex characters or base64. Orbit encrypts each credential JSON document with AES-256-GCM using a random 96-bit nonce. The connection ID is authenticated additional data, which prevents moving ciphertext to a different record. The key fingerprint is stored so the server fails clearly after an accidental key change. Ciphertext, nonces, tags, access tokens, refresh tokens, and client secrets are never returned by connection APIs.

The SQLite schema now models operators, client workspaces, and explicit client memberships. Every browser connection query and mutation uses the server's verified local-operator identity plus dataset and client ID; a caller cannot select a client without a membership. OAuth callbacks and signed webhooks use one-time/provider signatures before resolving an unscoped connection ID. Background jobs carry the connection's stored client scope.

Operators can create and switch client workspaces in Connections. Source credentials, normalized objects, jobs, and audit events remain in that client. The older campaign, commerce, book, and Brain tables are dataset-scoped, so only the bootstrap **Pathway workspace** projects source data into them. A secondary client can collect and inspect isolated source facts, but every object remains `unmapped` until those legacy tables receive `client_id`; its credentials never enter the dataset-scoped Amazon Brain. This fail-closed boundary prevents a new client from being blended into the bootstrap portfolio.

This remains a loopback-only release. The local bootstrap operator is not hosted login, and SQLite membership checks are not a substitute for PostgreSQL row-level security. `server/index.ts` refuses a non-loopback bind. Before public deployment, map an authenticated identity to `operatorId`, remove automatic local bootstrap, enforce the same client predicate in PostgreSQL and object storage, add CSRF/session controls, and rehearse vault-key rotation. The new model and tests are the security foundation for that move; they do not claim hosted multi-tenancy is complete.

## Shopify

The adapter uses the version-pinned Admin GraphQL endpoint and an offline/custom-app access token. It requests only products, inventory, and orders. The first collection overlaps sixty days, consistent with ordinary `read_orders` access; later runs overlap the previous watermark by seven days so late refunds replace the same order-line identity.

Collected facts:

- shop identity, currency, and IANA timezone;
- product variant ID, product ID, exact SKU, price, inventory quantity, and update time;
- non-test paid/refunded order lines, with later cancellations correcting the same line to zero units and receipts;
- discounted line and allocated shipping receipts plus line-level refund amounts, excluding sales tax.

Mapped variants create or refresh product-portfolio records while preserving operator-entered economics, approvals, loss limits, and fulfillment modes. New variants arrive with economics and release evidence unverified. Aggregate order lines contain no customer name, email, address, phone, or payment details. Corrections use the existing immutable commerce-ledger revision path. Variants without a SKU, duplicate SKUs, and orders for unknown SKUs remain source facts and put reconciliation in `partial` state.

The query rejects orders or refund collections with more than 100 lines rather than silently truncating them. Refunded shipping and Shopify Payments disputes/chargebacks are not yet collected; the product cost model's chargeback/return allowances remain required, and a live pilot must reconcile those adjustments separately. Live webhooks also require a publicly reachable HTTPS deployment, which this loopback release intentionally does not enable.

Primary sources: [Shopify app authentication](https://shopify.dev/docs/apps/build/authentication-authorization), [GraphQL Admin API](https://shopify.dev/docs/api/admin-graphql/latest), [orders query](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders), and [webhook topics/scopes](https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic).

## Meta Ads

The adapter uses a version-pinned Graph API and the Marketing API with `ads_read` and `business_management`. It discovers authorized ad accounts, refuses an ambiguous multi-account authorization until an `act_...` ID is selected, and currently accepts USD accounts.

Each full entity snapshot collects campaigns, ad sets, ads, and ad creatives. Daily ad-level Insights overlap seven days after the prior watermark and keep account, campaign, ad-set, ad, and date identity. The request uses conversion report time and the account attribution setting. Purchase actions use one priority basis (`omni_purchase`, then `purchase`, then pixel purchase) so overlapping action labels are not added together. Spend and purchase value are normalized to integer cents; native action arrays remain alongside the normalized fields.

Campaigns without an exact Meta reporting-hub mapping remain visible and make the connection partial. A Meta attributed purchase is still platform evidence, not an independently paid Shopify order. Product profitability only becomes actionable after Shopify reconciliation and the existing attribution-maturity, economics, inventory, and release gates pass.

Pagination accepts only HTTPS `graph.facebook.com` continuation URLs, removes any query-string access token, retains the Authorization header, rejects repeated pages, and stops at a bounded maximum. Configure `META_GRAPH_API_VERSION` explicitly and update contract fixtures before advancing it.

Primary source: [Meta Marketing API documentation](https://developers.facebook.com/docs/marketing-apis/).

## Amazon Ads

Connections now support three credential paths: the existing server environment, encrypted credentials entered by an authorized operator, or Login with Amazon consent using the approved Ads application. They are distinct from Selling Partner API or Advantage credentials.

The connection sync discovers profiles, verifies the selected profile/currency/timezone/region, and snapshots Sponsored Products campaigns, ad groups, keywords, negative keywords, product targets, and negative product targets. It also runs restart-safe Reporting v3 campaign and advertised-product jobs for the last 60 completed days. Pending Amazon reports persist their request IDs and schedule another collection; completed rows become client-scoped profit evidence. In the bootstrap Pathway workspace, exact source entities can also hand off to the existing Brain workflow. Secondary-client credentials stay outside the dataset-scoped Brain while still serving the client-scoped Profit control workspace. A connection credential is forced read-only even if the server's legacy write switch is enabled.

See [the complete Amazon Ads contract](AMAZON_API.md). Amazon's official overview says Ads API access requires application and approval; SP-API onboarding separately covers selling operations such as orders, inventory, reports, and finances. [Amazon Ads API](https://advertising.amazon.com/about-api), [SP-API onboarding](https://developer-docs.amazon.com/sp-api/docs/onboarding-overview), [SP-API authorization](https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api).

## PBS HQ and SP-API boundary

The PBS connector consumes the publisher-scoped HTTP contract already implemented in PBS HQ rather than copying its private database or Amazon credentials. It reads the title list for ISBN/format, current Pathway and at-vendor availability, sold/returned units, cash and earned sales; an incremental sync refreshes the newest three statement bundles. An operator can queue a dated backfill to collect historical bundles, bounded to 120 statements per job. Existing statements remain authoritative and are not deleted by an incremental sync.

An ISBN exact-match can refresh `supplyReady` on an existing Orbit book record and records when PBS verified it. PBS-derived readiness expires closed after 72 hours without a refresh. It cannot invent an ASIN, format mapping, unit manufacturing cost, contracted per-unit net receipt, profit reserve, loss allowance, or ad budget. Unmatched PBS ISBNs stay visible as mapping work. Period net sales are not divided by units and written into book economics because the PBS figures blend channel timing, returns, and settlement semantics.

PBS HQ's SP-API workers remain the source for Amazon vendor inventory and retail analytics. SP-API Reports can cover inventory, orders, returns, and seller/vendor operations, while the Finances API covers seller financial events; neither grants Ads API campaign access. [SP-API Reports guide](https://developer-docs.amazon.com/sp-api/docs/reports-api-v2021-06-30-use-case-guide), [Finances API](https://developer-docs.amazon.com/sp-api/docs/finances-api).

## Pilot evidence checklist

For each real source:

1. authorize the narrow account/store/publisher scope and record who approved it;
2. compare discovered identity, currency, timezone, and row counts with the source console;
3. force pagination, throttling, expired authorization, empty pages, and one delayed correction;
4. prove replay does not duplicate products, order lines, insights, settlements, or spend;
5. resolve every SKU, campaign, ISBN, format, and ASIN mapping used by the pilot;
6. compare source totals with one independent console export for the same dates and attribution definition;
7. leave Amazon and Meta in observation mode for at least one complete attribution window;
8. keep scaling blocked while costs, availability, refunds/returns, chargebacks, or settlements are missing.

Automated tests use synthetic provider responses and no real tokens. Passing tests prove contract and safety behavior, not that a live credential has the required access or that any book/product will be profitable.
