# Orbit · Multi Ads Manager

A working local foundation for a profit-aware advertising manager, with equal emphasis on **product advertising** and **Amazon book advertising**.

The application combines a dashboard, persistent campaign workspaces, validated performance imports, a bulk book portfolio with format-level economics, measured experiment waves, a searchable learning library, and **the brain**: durable account synchronization, keyword/direct-ASIN/search-term economics, exact change proposals, and policy-governed execution with read-back. An optional AI provider (Claude preferred, OpenAI supported) reviews keyword relevance, explains proposals, and drafts experiment ideas. The long-term architecture is in [the blueprint](docs/ARCHITECTURE.md), and the project/platform investigation is in [the research](docs/RESEARCH.md).

## Run it

Requires **Node.js 24.x** and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on port 4311. The app is deliberately bound to loopback; this release has no network authentication or tenant authorization.

For a compiled local build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:4311**. Stop the development API first because both use port 4311.

Data is stored in `.data/orbit.sqlite` using Node's built-in SQLite module. This folder, secrets, generated builds, and test artifacts are ignored by Git. Node may print an experimental-module warning for SQLite. Back up the entire `.data` directory while the app is stopped.

The demo is evaluated at its labeled sample snapshot date so it remains useful when reopened later. Your workspace always uses the current clock and checks report freshness.

## What works today

| Capability                      | This release                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product and book dashboards     | Channel filters, date ranges, search, contribution estimates, ROAS, break-even economics, CSV export                                                                                                                                                                                                                                                   |
| Separate demo and business data | Synthetic demo seeded automatically; **Your workspace** starts empty                                                                                                                                                                                                                                                                                   |
| Campaign setup                  | Book/product identity, channel, click window, net receipts, variable costs, profit reserve, planning limits, readiness attestations                                                                                                                                                                                                                    |
| Performance ingestion           | Normalized daily CSV and a documented English Amazon campaign-export profile; atomic upserts, freshness and contract validation                                                                                                                                                                                                                        |
| Reporting hub                   | Saved account mappings, portfolio batch previews, row comparisons, duplicate protection, atomic application, and before/after correction history                                                                                                                                                                                                       |
| Experiment lab                  | Up to 300 distinct template candidates, optional AI ideas, bounded shortlist waves, persistence, candidate CSV export                                                                                                                                                                                                                                  |
| Test waves                      | Frozen candidate/report mappings, baseline comparisons, maturity gates, local budget reservations, loss boundaries, and console setup sheets                                                                                                                                                                                                           |
| Learning library                | Immutable findings, correction-aware revisions, searchable notes, and evidence-linked follow-up drafts                                                                                                                                                                                                                                                 |
| Evidence review                 | Deterministic economic gates and a documented Bayesian conversion model; recommendations and saved operator decisions                                                                                                                                                                                                                                  |
| Target explorer                 | Normalized keyword, product-target, and creative-cell imports, parent-report reconciliation, economic signals, and source-linked experiment seeds                                                                                                                                                                                                      |
| The brain                       | Sandbox and Amazon Ads connectors, sync with health and watermarks, keyword and product-target search-term ingestion, direct-ASIN harvest/exclusion, bid/budget/pause proposals, account-wide proposal ranking, active-budget portfolio ceiling, commitment envelope, outbox execution with read-back and reconciliation, kill switch, business ledger |
| Book portfolio                  | Bulk and individual format setup, same-ASIN unit economics, 56-day loss allowances, daily budget ceilings, campaign reconciliation, and 50-row pagination                                                                                                                                                                                              |
| Amazon reporting                | Verified profile discovery, account timezones, durable report jobs, restart-safe polling, and validated campaign, keyword, product-target, source-specific search-term, and advertised-product facts                                                                                                                                                   |
| Optional AI                     | Claude (default) or OpenAI structured outputs: search-term relevance review, proposal explanations, up to 24 ideas/request, cached by content, daily request reservations, no tools or platform actions                                                                                                                                                |
| Audit journal                   | Imports, setup revisions, experiment changes, and decisions                                                                                                                                                                                                                                                                                            |
| Integration preparation         | Setup guides for Amazon Ads, Meta, TikTok, Shopify, PBS HQ, and OpenAI                                                                                                                                                                                                                                                                                 |

**Not implemented:** the Login with Amazon authorization flow itself (place the refresh token in the server environment), Meta/TikTok/Shopify connectors, creative media production, category/brand/automatic-target and placement actions, causal experiment execution, automatic order/royalty reconciliation, production multi-tenancy, and hosted deployment. Execution against a live account requires `AMAZON_ADS_WRITES_ENABLED=true`, a supervised or bounded policy, complete reconciled reports, and verified book economics; see [The brain](docs/BRAIN.md) and [Amazon API contract](docs/AMAZON_API.md).

## First real workflow

1. Select **Your workspace** in the sidebar.
2. For books, open **Book portfolio** and add or bulk-import one row per ASIN/format with its own net receipts, costs, profit reserve, 56-day loss allowance, and daily budget ceiling. Products continue to use campaign setup.
3. Verify the reporting contract and costs. Unverified items can be saved, but do not receive scaling recommendations.
4. Use **Reporting hub** for reviewed CSV workflows, or connect a verified Amazon Ads profile in **The brain** for durable API report jobs. A local campaign has one reporting identity; file and API sources cannot be mixed. See [the reporting workflow](docs/REPORTING.md), [the import contract](docs/IMPORTS.md), and [the Amazon API contract](docs/AMAZON_API.md).
5. Inspect a campaign's unit economics and mature evidence. Recommendations are observational screening signals, not verified business profit.
6. Build an experiment, shortlist a small wave, and export the candidate library for review.
7. Record the recommendation decision. Manage actual advertising in the platform console until a separately tested execution integration exists.

To look inside a campaign, open **Target explorer** and import the normalized target/creative template. Target facts remain separate from campaign totals. Inspect a measured cell, then use it as a seed for an experiment; the saved draft retains its source target.

For the complete candidate → measured wave → recorded finding → follow-up workflow, see [Test waves and the learning loop](docs/EXPERIMENTS.md). Open **Test waves** in the demo for a book comparison ready to review and **Learning library** for an already recorded product finding. Local reservations and cancellations do not control platform delivery or bank funds.

## The brain

Open **The brain** in the demo: a simulated Amazon Ads account is already linked to the three sample book campaigns, and **Book portfolio** shows their fictional format economics. Press **Run brain** to synchronize, evaluate every keyword, direct-ASIN product target, and source-specific search term, and generate proposals. In Your workspace, connect a sandbox account or discover a verified Amazon Ads profile from server credentials, link campaigns, map them to book formats, and choose an operating mode. The full cycle is documented in [docs/BRAIN.md](docs/BRAIN.md).

## Optional AI configuration

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` (model defaults to `claude-opus-5`; override with `ANTHROPIC_MODEL`). OpenAI remains supported through `OPENAI_API_KEY` and `OPENAI_MODEL`; Claude is used when both are configured. Restart the API. Keys stay on the server and are never returned to the browser.

Select the AI provider in the experiment form, enable **AI review** in an account policy, or use **Explain with AI** on proposals. The default allowance is five requests per UTC day across all tasks; relevance reviews and explanations are cached by content so repeated runs do not spend again. Each has a 4,000 output-token limit and accepts at most 24 ideas. A reservation is retained after a timeout or uncertain failure, and there are no automatic paid retries. This is a request allowance, **not a dollar cap**. No model, API key, live ad token, or customer data is bundled with the repository. Live provider behavior requires your configured account; automated tests mock that boundary.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Install the browser once if needed: `npx playwright install chromium`. End-to-end tests run against an isolated database and a separate compiled server on port 4312. Screenshots stay under ignored test directories.

GitHub Actions runs the unit/API suite, type checks, production build, and browser journeys for pushes and pull requests. CI uses synthetic data and no AI or advertising credentials.

## Project map

```text
src/                  React dashboard and operator workflows
shared/               Typed browser/server contracts
server/engine.ts      Unit economics, attribution maturity, bounded posterior calculation
server/importer.ts    Explicit normalized and Amazon report mappings
server/reports.ts     Saved source contracts, reviewed batches, and observation revisions
server/store.ts       Transactional local persistence and AI request reservations
server/planner.ts     Distinct candidate generation and experiment plans
server/waves.ts       Frozen plans, conditional comparisons, and learning revisions
server/ai/            Provider boundary (Claude, OpenAI) and structured tasks; no action tools
server/connectors/    Connector contract, simulated account, Amazon Ads v3 adapter
server/brain/         Accounts and policy, sync, proposals, execution outbox, view, routes
server/books.ts       Book catalog, advertised-product facts, title economics, loss gates
tests/                Economic, import, API, brain, connector, and AI-boundary tests
e2e/                  Browser journeys
docs/RESEARCH.md       Local project findings and primary-source research
docs/ARCHITECTURE.md   Production architecture, optimizer design, and data boundaries
docs/ROADMAP.md        Equal-track delivery plan and measurable gates
docs/IMPORTS.md        Supported report contract and limitations
docs/REPORTING.md      Portfolio batch workflow, source contracts, and correction history
docs/EXPERIMENTS.md    Measurement workflow, budget accounting, and evidence boundaries
docs/BRAIN.md          Sync, proposals, operating modes, execution, and AI review
docs/AMAZON_API.md     Implemented Ads API/reporting contract and pilot checks
```

The repository is public. Use synthetic fixtures only; do not commit client reports, financial exports, credentials, or copies of private source project data.
