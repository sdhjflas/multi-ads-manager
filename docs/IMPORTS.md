# Performance import contract

The first release supports **one campaign, one item/format, one fixed click-attribution window, USD, UTC, and one row per completed reporting day**. Select **Your workspace** before importing. Demo records cannot receive business reports.

## Normalized CSV

Exact headers, in any order:

```csv
date,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents
2026-09-01,2000,100,8,3200,16000,0
2026-09-02,2100,110,9,3520,18000,1000
```

The dates are examples; use your actual completed reporting dates.

| Field           | Meaning                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `date`          | UTC click/impression-cohort date, `YYYY-MM-DD`; today and future dates are rejected                    |
| `impressions`   | Nonnegative whole count                                                                                |
| `clicks`        | Nonnegative whole count; no more than impressions                                                      |
| `orders`        | Click-attributed purchase events used as converting clicks, **not units sold**; no more than clicks    |
| `spend_cents`   | Advertising cost in integer USD cents                                                                  |
| `sales_cents`   | Attributed retail sales in integer USD cents, not publisher royalties                                  |
| `refunds_cents` | Reduction to the operator's net receipts in integer USD cents, not the consumer's retail refund amount |

All seven fields are required. Blank numeric cells, negative/fractional values, duplicate column names, extra normalized columns, personal-data columns, inconsistent funnels, duplicate dates, and invalid dates are rejected. Explicit zero rows represent no delivery; absent rows represent missing evidence. Per-field counts/money are capped at 100,000,000 units to bound malformed input.

Do not combine placement, keyword, ad group, creative, or format breakdowns into repeated campaign/day rows. Aggregate at the documented grain first. If the platform's conversion counts do not match the one-purchase-per-converting-click model, do not force them into this schema: a suitable model and import adapter are required.

Set the actual **exported at** timestamp in the form. A timestamp over five minutes into the future is rejected. Current reporting recommendations require all relevant mature cohorts to have been refreshed within 48 hours.

## Amazon console CSV profile

Supported: English, comma-separated **daily campaign** reporting with these headers:

```csv
Date,Campaign Name,Impressions,Clicks,Spend,14 Day Total Orders (#),14 Day Total Sales
2026-09-01,Exact campaign name,2000,100,32.00,8,160.00
```

A seven-day campaign uses `7 Day Total Orders (#)` and `7 Day Total Sales` instead. The click window must match campaign setup. Date accepts `YYYY-MM-DD` or unambiguous US `M/D/YYYY`. Campaign names must match exactly. USD accepts up to two decimals and optional dollar signs/thousands separators when CSV quoting is correct.

This is an explicit supported profile, not a claim that every Amazon console export has these headers. New report products and revised metric names may differ. If your export differs, map it deliberately into the normalized template. Account timezone, attribution window, report basis, and purchase definition must actually match; selecting an attestation does not convert the file.

The console profile does not contain publisher net-receipt refund adjustments, so they initialize to zero and an import note records that limitation. Reconcile using the normalized template before interpreting estimated contribution as an economic result. Re-importing an unadjusted console report replaces that day's prior observations, including refund adjustments: keep your reconciliation workflow explicit.

## Updates and source identity

The database key is `(campaign_id, date)`. Importing a refreshed report replaces overlapping rows. It never adds a second copy. The entire import is transactional. If one row would replace a newer export with an older one, the whole import is rejected.

The campaign's item, channel, vertical, and click window cannot change after importing observations. Create a separate campaign for a changed definition. Unit economics are explicit static assumptions for the entire reporting period in this release; editing them recomputes the model and changes the evidence fingerprint. Effective-dated costs and an independently reconciled ledger are planned.

An export can contain at most 2,000 daily rows and 1 MB of CSV, covering the last two years. The API body limit is 2 MB. This local tool stores only aggregates. It is not a place for names, emails, IP addresses, session IDs, or order-level records.

## Interpretation

The chart includes recent provisional results. Recommendation calculations use up to 56 days of observations, excluding the last full attribution window and today's partial cohort. These calculations are independent of the dashboard's visual date filter. The campaign detail shows the mature-through date and mature counts.

No CSV import updates a live ad account. No export file is an Amazon/Meta bulk-upload action file; exports are review artifacts.

## Measured target and creative cells

Open **Target explorer → Import target data** for the normalized target profile:

```csv
date,target_id,target,kind,match_type,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents
2026-09-01,kw-100,nature writing,keyword,broad,1000,50,5,1500,10000,0
2026-09-01,kw-101,outdoor essays,keyword,exact,800,40,3,1200,6000,0
```

For a commerce creative, use `kind=creative` and `match_type=creative`; its `target_id` should map to a stable versioned platform creative/ad cell. Book targeting accepts `keyword` with `exact`, `phrase`, `broad`, or `auto`, and `product-target` with `product`. Product-target values must be independently verified ASIN/target descriptions; this importer does not verify Amazon catalog existence or advertising eligibility.

IDs are scoped to the selected campaign. Reusing an ID with a changed label, kind, or match type is rejected. Use a new identity for a changed definition. Repeated target/day rows and malformed source fields are rejected. Reports support up to 10,000 rows per import, 500 target definitions per campaign, and the same 1 MB CSV limit. The import transaction replaces refreshed observations without changing campaign totals.

Import current parent campaign reports first. The target explorer blocks interpretation when target totals exceed the parent report or when a target date has no parent row. This catches accidental mixed grains or incompatible report refreshes. It does not prove complete target coverage: a selected subset may be smaller than the campaign total. A shortlisting library and a measured target library are deliberately separate.

Include explicit zero rows for complete target-day coverage, preserve the click attribution contract, and refresh mature cohorts. A broad keyword signal can justify investigating its search terms, but cannot invent those terms. Negative-target and bid decisions still require platform-console review. The **Use as a test seed** action records target provenance in a new planning draft; it sends no ad-platform request.
