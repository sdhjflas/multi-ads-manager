# Product commerce profit and readiness

Orbit v0.8 combines the independent product catalog, readiness contract, inventory controls, and paid-order ledger with a read-only Shopify observer. It does not publish ads, change Shopify, reserve stock, or establish causal lift.

The contract follows the useful controls found in Enthusiast Supply Co. without copying its private operating records: an ad-ready idea is not a sale-ready SKU; supplier paperwork is not stock; platform-attributed purchases are not receipts; and missing economics cannot authorize spend.

## Operator workflow

1. Open **Product portfolio** in **Your workspace** and register a manual store with its IANA timezone and maximum ledger age.
2. Add a SKU in the editor or import the exact catalog CSV template. Unknown amounts stay blank. A product can be staged while incomplete, but it cannot become sale-ready.
3. Record the complete unit cost stack, profit reserve, 56-day learning-loss limit, daily budget ceiling, approvals, inventory mode, and inventory verification.
4. Import aggregate paid-order lines using the exact ledger template. Do not add names, email addresses, street addresses, payment data, or other customer fields.
5. Link one product campaign to the exact SKU. The campaign receives the SKU's current economics and readiness values. A campaign cannot later change to a different SKU; create a new campaign when the product identity changes.
6. Reconcile the campaign again after changing product economics. Current product gates are checked again whenever Orbit displays a recommendation, records a review, exports decisions, registers a test wave, or evaluates a wave.

The demo contains fictional product data. Workspace mutations are deliberately unavailable in the demo dataset.

## Stable identity

The store and exact SKU identify a catalog record. `product_ref` groups variants, while `external_variant_id` is reserved for the future source variant ID. Once populated, the external variant ID cannot change or belong to another SKU in the same store. SKU matching is case-sensitive because Shopify treats SKU values as case-sensitive.

One local campaign maps to at most one SKU. This keeps campaign observations, business receipts, inventory, and economics from silently moving between products. Names are display labels and are never used as joins.

## Economics

All money in the import and persistence contracts uses whole US cents. The current local release supports USD only.

```text
unit variable cost = unit cost
                   + inbound freight
                   + duties and fees
                   + packaging
                   + payment-fee allowance
                   + outbound fulfillment
                   + return allowance
                   + warranty allowance
                   + support allowance

planned contribution before ads = planned net receipts - unit variable cost
affordable acquisition cost     = max(0, planned contribution before ads - profit reserve)

period ledger contribution = paid net receipts
                           - paid units × unit variable cost
                           - spend from linked campaigns
```

`planned_net_receipt_cents` is the amount the business expects to retain from one paid unit before the listed variable costs. It cannot exceed the retail price. Economics can be marked verified only when the retail price, planned receipts, every cost component, profit reserve, loss limit, and daily budget limit are present. A zero or negative acquisition allowance blocks paid media.

Ledger contribution uses all paid receipts for the SKU and all spend from its linked campaigns in the selected period. Organic and cross-channel orders can therefore affect this screen. A positive result means the observed product receipts covered the modeled variable costs and linked ad spend; it does not prove the ads caused the orders.

## Paid-order ledger contract

Download the template from Product portfolio. It has exactly these columns:

```text
order_ref,line_ref,date,sku,units,net_receipts_cents,refunds_cents,chargebacks_cents,observed_at
```

- `order_ref` and `line_ref` are stable source references. The durable key is store + order reference + line reference.
- `date` is the store-accounting date in `YYYY-MM-DD` form.
- `sku` must match a registered SKU exactly, including case.
- `units` contains paid, non-test units and must be positive.
- `net_receipts_cents` is the paid amount retained after discounts, refunds, and chargebacks, excluding sales tax. The refund and chargeback columns are informational subsets already reflected in net receipts; Orbit does not subtract them twice.
- `observed_at` records when the source state was observed. A timestamp more than five minutes in the future is rejected.

The exact header rule rejects accidental person-level columns. This is data minimization, not an anonymization guarantee: use non-secret source references and protect exported business data appropriately.

Imports are atomic. An exact batch replay is rejected. Existing line identity cannot change SKU or accounting date. A changed line needs a newer `observed_at`; older observations and conflicting rows with the same instant are rejected even if their timestamp text uses a different ISO representation. Every accepted insertion or correction stores its before/after revision with the batch. Product portfolio lists the 10 most recent batches and exposes accepted changes in pages of 100 lines.

Freshness is calculated for each exact SKU from that SKU's latest line observation. A current order export for one SKU cannot make another SKU's ledger current. Products with spend and no paid-order rows are marked **No data**; products with spend and an old latest observation are marked **Stale ledger**. This conservative rule means a current zero-order snapshot cannot yet prove freshness for a SKU; the future connector needs explicit per-SKU coverage watermarks.

## Attribution reconciliation and loss control

Platform orders remain separate from business receipts. For each mature reporting date, Orbit uses:

```text
reconciled paid units for the date = min(platform-attributed orders, paid-ledger units)
```

It then sums those daily caps. A platform cannot contribute more recognized units than the independent paid ledger contains on the same date. This is a conservative accounting cap, not an order-level attribution join and not proof of incrementality.

The risk screen always uses a trailing 56-day window:

```text
risk exposure = max(0, linked ad spend - reconciled mature units × affordable acquisition cost)
```

Reaching the product's learning-loss limit blocks an increase. The daily budget check sums every linked campaign currently marked observing and compares that commitment with the SKU ceiling. Local campaign state is planning state until a tested platform connection verifies delivery.

## Readiness and inventory

Media readiness requires all of the following:

- Complete, verified economics with positive acquisition room.
- Commercial rights approval.
- Exact-SKU product evidence approval.
- Claims approval.
- Paid-order tracking and consent verification.

Sale readiness additionally requires fulfillment and return-route readiness, final release approval, a verified inventory route, current inventory verification, safety stock, a reorder point, committed and quarantined quantities, and positive sellable capacity.

Inventory modes are intentionally different:

| Mode            | Sellable capacity                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Stocked         | `max(0, available units - safety stock)`                                                         |
| Supplier direct | `max(0, verified supplier capacity - safety stock)`, only after route verification               |
| Preorder        | `max(0, approved preorder capacity - safety stock)`, only after route and preorder-term approval |

For stocked products, `available_units` must already mean inspected, saleable units after reservations, quarantine, samples, rejected stock, and other holds. Orbit requires committed and quarantined quantities as control evidence but does not subtract them again. A purchase order, tracking number, incoming shipment, or unverified supplier claim is not available stock.

Inventory timestamps in the future are not fresh. Inventory at or below the reorder point receives a low-stock hold even when some saleable units remain.

## Decision enforcement

Product status is derived rather than entered. Blocking states take precedence in this order: unverified economics, no viable acquisition room, media approval gaps, fulfillment/release gaps, stale inventory, no capacity, low stock, missing ledger data, stale ledger, loss limit, and budget limit. Only then can a measured SKU show positive or learning status.

Every commerce recommendation evidence ID includes the current product, inventory, ledger, loss, and linked-budget state. When a campaign has no SKU mapping, stale readiness, low stock, missing or stale paid orders, an exhausted product loss allowance, an exceeded product budget ceiling, or economics that differ from its current SKU, Orbit converts any non-defensive recommendation to **repair**, removes a suggested budget increase, and adds the current blockers. An existing **reduce** recommendation remains defensive while carrying the product blockers. Test-wave registration and evaluation apply the same live gates. Fixing a stale product cannot retroactively change a frozen measured wave; the wave is evaluated against both its registered evidence and current safety constraints.

## Scale and local limits

- 50 stores per workspace.
- 20,000 SKUs per store.
- 2,000 catalog rows per import.
- 20,000 paid-order lines per import.
- 2 MB request body for each CSV workflow.
- 50 products per portfolio page.

The portfolio API performs the calculations in the local application process. The production design should move large ledger aggregation and source coverage checks into indexed database queries and durable workers.

## Shopify connector boundary

The v0.8 observer implements OAuth/custom-token storage, versioned GraphQL requests, product variants, aggregate inventory quantity, recent paid/refunded order lines, raw-body webhook HMAC verification, overlap reconciliation, durable jobs, and exact case-sensitive SKU mapping. Access tokens use the server vault and never return to the browser. Blank/duplicate/unknown SKUs remain source facts and block full reconciliation. New products keep economics and release evidence unverified; a sync cannot overwrite those operator controls.

The adapter requests `read_products`, `read_inventory`, and `read_orders`. Ordinary order access is limited to Shopify's recent window, so the first sync uses sixty days and later syncs overlap seven days. An app with an approved older-order use case can add `read_all_orders`, but a complete historical backfill workflow is not yet implemented.

Still required before a live scale decision:

1. compare variant, inventory, receipt, and refund totals with the authorized store for identical dates;
2. add location-aware inventory-state mapping where the fulfillment model needs `available`, `on_hand`, `incoming`, and `committed` separately;
3. collect or separately reconcile refunded shipping, Shopify Payments disputes, and chargebacks;
4. add explicit successful zero-order coverage per SKU instead of treating absence as a fresh zero;
5. deploy the signed webhook endpoint behind authenticated HTTPS infrastructure; the current server remains loopback-only;
6. complete app review/protected-data assessment without expanding the no-customer-data contract.

See [Connected observation](CONNECTIONS.md) for the shared credential, OAuth, jobs, and health contract.

Primary Shopify references checked for the 2026-07 Admin API contract:

- [Authentication and authorization](https://shopify.dev/docs/apps/build/authentication-authorization)
- [Access scopes and the older-order approval boundary](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes)
- [GraphQL Admin `orders` query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders)
- [Webhook subscriptions](https://shopify.dev/docs/apps/build/webhooks/subscribe)
- [Webhook delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
- [Inventory level quantities](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/inventoryLevel)
- [Inventory item and case-sensitive SKU](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem)
- [Order line item fields](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem)
- [Refund line item fields](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/RefundLineItem)

The adapter must be verified against an authorized development shop and redacted contract fixtures before Orbit relies on it for a live pilot.
