# Client profit control

Profit control is the v0.9 operating surface for products and books across client workspaces. It joins platform-attributed advertising facts to an independent business source while keeping every item, mapping, test, pool, and optimizer run inside one client membership scope.

## Evidence model

Each profit item represents one exact commerce SKU or one book format identified by ISBN and optional ASIN. Economics are versioned rather than overwritten: net receipt, variable cost, required profit reserve, learning-loss limit, and daily budget ceiling. A verified version must leave positive room for acquisition.

An item needs an exact campaign mapping and an independent mapping. Meta and Amazon campaign reports provide attributed spend, sales, and purchases. Shopify paid order lines provide SKU receipts, units, and refunds; PBS statement bundles provide title receipts and units. Platform sales never substitute for independent receipts. Stale, missing, or failed sources block scaling.

The decision engine can return `blocked`, `observe`, `test`, `scale`, or `stop`. It uses conservative screening contribution and a remaining-loss calculation. These are operating gates and portfolio ranking inputs, not causal proof or a promise of profit.

## Experiment queue

An operator registers one hypothesis and one variable. Book items accept keyword or direct product-target tests. Commerce items accept hook, headline, audience, or landing-page tests and require an explicit rights, claims, and evidence attestation. The generator creates 2 to 300 unique candidates with provenance from the supplied seeds.

Approving a draft stages only `maxConcurrent` candidates as active and holds the rest. Activation rechecks current economics, mappings, and source health. It records an audit event but does not create or change an ad. Later platform delivery and outcome advancement remain supervised work.

## Shadow budget allocator

A client budget pool has a daily ceiling, learning ceiling, vertical scope, and reserve percentage. A run includes only currently eligible items, ranks scale evidence before learning tests, obeys each item's daily ceiling, preserves the reserve, and may leave all remaining cash unallocated. Each immutable run stores an evidence fingerprint for review. It performs no platform write.

## Pilot gate and recovery

The pilot gate requires advertising and independent receipt sources, verified economics for every included item, exact mappings with current evidence, and no failed or dead-letter collection jobs. Connection jobs use scheduled exponential retries; exhausted work remains visible for an operator-created retry. Shopify, Meta, and PBS support dated backfills, while Amazon reporting resumes its persisted asynchronous jobs.

Before live use, compare one complete window with both source consoles, resolve every identity, verify economics from current records, and keep all actions in observation or shadow mode for a full attribution window. Automated tests use synthetic provider data and cannot validate a real account's permissions or economics.
