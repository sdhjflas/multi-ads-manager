# Reporting hub

The Reporting hub provides the reviewed CSV ingestion workflow for product ads and Amazon book ads. Amazon Ads API collection is a separate path in **The brain**; a campaign cannot mix the two reporting identities.

Open **Reporting hub → Your workspace**. Create local campaigns with verified reporting definitions and unit economics, then register a source, stage a report, inspect its differences, and apply the batch.

## Saved source contract

A source pins the platform, account reference, profile, USD currency, UTC reporting dates, fixed 1–30 day click window, and explicit external-to-local campaign mappings. Normalized profiles use stable external campaign IDs. The supported Amazon console profile uses the exact exported campaign name; the local campaign can have a different friendly name.

Each local campaign has at most one campaign source and one target source. Both must use the same account and platform; normalized campaign and target sources must also use the same external campaign ID. Within an account, the same external ID cannot represent two different local campaigns. Console names and normalized IDs are different identity types: an operator must verify their correspondence. This is a local mapping safeguard, not remote account verification or multi-tenant authorization.

Contracts are immutable. An unused source can be removed and recreated. Once any batch has been staged, including a discarded batch, its source and mappings are retained. A changed reporting identity requires a separate campaign/source with its actual changed identity. There is no source migration or mapping-extension workflow yet; map the campaigns you intend to ingest before saving, or register another source for additional campaigns.

Campaign item, channel, vertical, and attribution definitions are fixed once observations, target IDs, or a saved source exist. Economic assumptions can still be edited; they apply to the entire history and trigger evidence review.

## Report profiles

Download the template from the saved source. All profiles inherit the metric, purchase-event, attribution, and date constraints in [the import contract](IMPORTS.md). Dates below are examples.

### Normalized campaign / day

```csv
account_id,campaign_id,date,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents
shop-us,campaign-10,2026-09-01,2000,100,8,3200,16000,0
shop-us,campaign-20,2026-09-01,1200,0,0,500,0,0
```

The second row retains impression-based cost with no clicks. These costs reduce contribution. `orders` still means click-attributed purchase events, no more than clicks; units and view-through outcomes do not fit this conversion model.

Every `account_id` must exactly match the source, and every `campaign_id` must have an explicit mapping. These are Orbit headers, not native Meta or TikTok schemas. Convert the source deliberately without mixing attribution windows, account timezones, reporting bases, or purchase definitions. The same normalized profiles support Amazon data after deliberate conversion. Relabeling daily totals from another timezone does not convert them into UTC cohorts.

### Normalized target / day

```csv
account_id,campaign_id,date,target_id,target,kind,match_type,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents
shop-us,campaign-10,2026-09-01,creative-100-v1,Utility opening,creative,creative,1000,50,5,1600,10000,0
```

Book sources use the same columns with `keyword` or `product-target` definitions described in [IMPORTS.md](IMPORTS.md). A target ID identifies one fixed definition within its campaign. It cannot later represent changed copy, text, kind, or match type. Registered test waves use these same IDs.

Target rows **never add spend to campaign or portfolio totals**. They are a breakdown. Missing parent rows or target totals above parent totals produce reconciliation notes and block affected target/test conclusions. Batches can arrive separately so a corrected parent report can be followed by corrected target data. An inconsistent intermediate state is not treated as evidence to scale.

### Amazon campaign console CSV

```csv
Date,Campaign Name,Impressions,Clicks,Spend,14 Day Total Orders (#),14 Day Total Sales
2026-09-01,Console book campaign A,2000,100,32.00,8,160.00
2026-09-01,Console book campaign B,1000,50,18.00,3,60.00
```

This is the supported English daily campaign profile. Use the saved click window in the orders/sales headers. Extra aggregate columns may be ignored; personal-data columns are rejected and ignored fields are not persisted. A `Currency` column, if present, must match USD. Other schemas require deliberate normalization or a future adapter.

This profile cannot independently prove the source account, timezone, click window, or purchase definition. The operator verifies the account and actual report settings. Exact names are a console-export fallback: do not rename or reuse them during the contract. Neither Amazon Ads API approval nor credentials are needed for CSV uploads.

Console totals omit publisher net-receipt refunds. Existing refund adjustments are carried forward for overlapping campaign/day rows; new days initialize to zero. Use normalized campaign reports or the single-campaign normalized importer to reconcile returns. A console re-export does not establish that zero new refunds occurred. Both batch and single-campaign console importers preserve stored refund adjustments.

## Review and apply

1. **Stage:** select the source, choose/paste the CSV, and enter the actual time the reporting system produced the export. Confirm its definitions. Uploading an old file now does not make it current. Staging saves normalized aggregates and metadata without changing observations or registering measured targets.
2. **Inspect:** the preview separates new rows, corrected metrics, identical metrics with a newer export timestamp, and unchanged rows. It shows campaign spend changes, per-campaign coverage, gaps, reconciliation notes, conflicts, and overlapping recorded findings. Expand **Proposed row changes** to see each metric before and after.
3. **Apply:** the server recomputes the preview inside a SQLite write transaction. Changed stored evidence requires **Refresh preview** and another review. Blocking row conflicts reject the whole batch. Otherwise observations, target definitions, receipt status, revisions, and the activity entry commit together.
4. **Revisit:** the applied receipt retains the reviewed changes. **Before and after** shows original observations and export timestamps in pages of 25 revisions. A corrected export becomes a new batch; an applied receipt cannot be discarded or rewritten.

Older exports cannot overwrite newer observations. Conflicting metrics with the same export instant are blocked, including equivalent timestamp spellings. Use the actual revised export time. The source/file/export-time combination is idempotent: retries and repeat uploads return the original receipt without repeating imports or activity. BOM and CRLF differences do not create another receipt. Other byte changes can create a new batch, but unchanged observations generate no duplicate revision history.

A discarded preview retains its identity and changes no observations. Re-uploading the same file/export returns the discarded receipt. Use a fresh or corrected report for a new review.

Absent campaigns and dates are retained, never deleted or fabricated as zero delivery. Gap counts describe missing internal days within supplied cells, not complete account coverage. Include explicit zero rows when they represent verified no delivery. A recent source upload does not prove every mapped campaign or mature cohort is current.

Corrections refresh current economics and test evaluations. Frozen findings remain intact; the Learning library flags changed evidence. Freshness-only updates do not invalidate findings when the facts are identical. Overlap notes identify findings to review, not a promise that every finding's outcome will change.

## Storage and boundaries

- Workspace limits: 2,000 campaigns, 100 sources, 500 batches; 200 mappings per source.
- Batch limits: 1 MB CSV, 10,000 rows total, 500 saved target definitions per campaign, last two years of completed dates. The campaign parser also caps each campaign at 2,000 daily rows.
- JSON body limit: 2 MB. Only aggregates are accepted; do not include personal or order-level records.
- SQLite schema version 8 retains source contracts, bindings, normalized payloads, receipts, observation revisions, encrypted connection metadata, durable connection jobs, and client-scoped audit events alongside the brain and portfolio tables.
- Raw CSV is not retained. SHA-256 content and contract hashes identify receipts. These are local integrity references, not a signed or tamper-proof archive.
- Single-campaign importers remain available. Batch previews detect their observation changes and require review. Single imports have activity entries but do not create batch revision receipts.
- CSV sources remain local advisory work. v0.8 adds encrypted Amazon consent, Meta Insights, Shopify, and PBS observation adapters with durable local jobs. TikTok, hosted identity/queue infrastructure, and live-account reconciliation evidence remain future work. See [Connected observation](CONNECTIONS.md).

The API starts at `/api/reporting`, with `/sources` and `/batches` below it. Source templates and batch refresh, commit, discard, and paginated revisions use their respective IDs. Reads and writes are dataset-scoped, creation accepts only `workspace`, and mutations require the existing same-origin local request header. This supports the local browser workflow; it is not hosted authentication.
