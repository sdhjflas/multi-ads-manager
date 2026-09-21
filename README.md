# Orbit · Multi Ads Manager

A working local foundation for a profit-aware advertising manager, with equal emphasis on **product advertising** and **Amazon book advertising**.

The application combines a dashboard, persistent campaign workspaces, validated performance imports, unit economics, measured experiment waves, and a searchable learning library. Optional OpenAI integration creates structured experiment ideas informed by recorded findings. The long-term architecture is in [the blueprint](docs/ARCHITECTURE.md), and the project/platform investigation is in [the research](docs/RESEARCH.md).

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

| Capability                      | This release                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product and book dashboards     | Channel filters, date ranges, search, contribution estimates, ROAS, break-even economics, CSV export                                                |
| Separate demo and business data | Synthetic demo seeded automatically; **Your workspace** starts empty                                                                                |
| Campaign setup                  | Book/product identity, channel, click window, net receipts, variable costs, profit reserve, planning limits, readiness attestations                 |
| Performance ingestion           | Normalized daily CSV and a documented English Amazon campaign-export profile; atomic upserts, freshness and contract validation                     |
| Experiment lab                  | Up to 300 distinct template candidates, optional AI ideas, bounded shortlist waves, persistence, candidate CSV export                               |
| Test waves                      | Frozen candidate/report mappings, baseline comparisons, maturity gates, local budget reservations, loss boundaries, and console setup sheets        |
| Learning library                | Immutable findings, correction-aware revisions, searchable notes, and evidence-linked follow-up drafts                                              |
| Evidence review                 | Deterministic economic gates and a documented Bayesian conversion model; recommendations and saved operator decisions                               |
| Target explorer                 | Normalized keyword, product-target, and creative-cell imports, parent-report reconciliation, economic signals, and source-linked experiment seeds   |
| Optional AI                     | Server-side Responses API with structured outputs, up to 24 ideas/request, bounded output, daily request reservations, no tools or platform actions |
| Audit journal                   | Imports, setup revisions, experiment changes, and decisions                                                                                         |
| Integration preparation         | Setup guides for Amazon Ads, Meta, TikTok, Shopify, PBS HQ, and OpenAI                                                                              |

**Not implemented:** Ads OAuth, automatic platform synchronization, live bids/budgets/pauses, creative media production, native target/search-term report adapters, causal experiment execution, order reconciliation, production multi-tenancy, autonomous allocation, or hosted deployment. The connection cards state their actual readiness. A saved proposal does not execute anything. The structured planner is a template generator; it is not presented as an LLM.

## First real workflow

1. Select **Your workspace** in the sidebar.
2. Add a campaign. For an Amazon import, use the exact exported campaign name. Use one title/format or product with stable per-purchase economics.
3. Verify the reporting contract and costs. Unverified items can be saved, but do not receive scaling recommendations.
4. Import complete daily reports. Include explicit zero rows for no-delivery days and refresh the trailing attribution window. See [the import contract](docs/IMPORTS.md).
5. Inspect a campaign's unit economics and mature evidence. Recommendations are observational screening signals, not verified business profit.
6. Build an experiment, shortlist a small wave, and export the candidate library for review.
7. Record the recommendation decision. Manage actual advertising in the platform console until a separately tested execution integration exists.

To look inside a campaign, open **Target explorer** and import the normalized target/creative template. Target facts remain separate from campaign totals. Inspect a measured cell, then use it as a seed for an experiment; the saved draft retains its source target.

For the complete candidate → measured wave → recorded finding → follow-up workflow, see [Test waves and the learning loop](docs/EXPERIMENTS.md). Open **Test waves** in the demo for a book comparison ready to review and **Learning library** for an already recorded product finding. Local reservations and cancellations do not control platform delivery or bank funds.

## Optional AI configuration

Copy `.env.example` to `.env`, set `OPENAI_API_KEY`, and set `OPENAI_MODEL` to a structured-output model available to your account. Restart the API. Keys stay on the server and are never returned to the browser.

Select **OpenAI** in the experiment form. The default allowance is five requests per UTC day. Each has a 4,000 output-token limit and accepts at most 24 ideas. A reservation is retained after a timeout or uncertain failure, and there are no automatic paid retries. This is a request allowance, **not a dollar cap**. No model, API key, live ad token, or customer data is bundled with the repository. Live provider behavior requires your configured account; automated tests mock that boundary.

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
server/store.ts       Transactional local persistence and AI request reservations
server/planner.ts     Distinct candidate generation and experiment plans
server/waves.ts       Frozen plans, conditional comparisons, and learning revisions
server/ai.ts          Optional structured AI ideas; no action tools
tests/                Economic, import, API, and AI-boundary tests
e2e/                  Browser journeys
docs/RESEARCH.md       Local project findings and primary-source research
docs/ARCHITECTURE.md   Production architecture, optimizer design, and data boundaries
docs/ROADMAP.md        Equal-track delivery plan and measurable gates
docs/IMPORTS.md        Supported report contract and limitations
docs/EXPERIMENTS.md    Measurement workflow, budget accounting, and evidence boundaries
```

The repository is public. Use synthetic fixtures only; do not commit client reports, financial exports, credentials, or copies of private source project data.
