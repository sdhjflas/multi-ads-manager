# The brain

The brain is the connected, decision-making layer of Orbit. It synchronizes an advertising account, measures every campaign, keyword, and shopper search term against the campaign's verified unit economics, proposes exact platform changes, and executes them under an explicit operating policy with read-back confirmation. An optional AI provider reviews search-term relevance and explains proposals; it never decides, authorizes, or executes.

Open **The brain** in the sidebar. The demo workspace ships with a simulated Amazon Ads account linked to the three sample book campaigns, so every step below can be tried without credentials.

## The cycle

```text
sync → evaluate → (AI relevance review) → propose → authorize → reserve → revalidate → send → read back
```

1. **Sync** pulls campaigns, ad groups, keywords, and negative keywords, then the daily campaign, keyword, and search-term reports for the trailing window. The first sync covers 56 days; later syncs re-pull the attribution window plus two days so late conversions replace provisional values. Missing keyword or term days inside the window become explicit zero rows only where the parent campaign reported that day. Health records `ok`, `partial`, `stale`, `throttled`, or `error`, with coverage counts and a watermark date.
2. **Evaluate** applies the same posterior screen used for campaigns (`Beta(1 + purchases, 19 + non-converting clicks)` against `observed CPC / affordable CPC`) to every keyword cell and search term. Recent cohorts inside the attribution window and today are excluded.
3. **Propose** turns evidence into one of seven action classes, each with an expected prior platform state, a maximum additional daily commitment, an evidence digest, an idempotency key, and a 72-hour expiry.
4. **Authorize** by an operator, or by a bounded policy for allowed classes that do not need review.
5. **Execute** reserves commitment inside the daily envelope, re-reads the platform state and re-runs the evaluation, writes an outbox row, sends the change, and reads it back. A lost response becomes `uncertain` and is reconciled from platform state before anything is retried.

## Action classes

| Class         | Trigger                                                                                                      | Change                                          | Commitment          |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------- |
| `negative`    | Search term with ≥ 20 mature clicks, zero purchases, P(profitable) ≤ 0.10, spend ≥ one acquisition allowance | Ad-group negative exact keyword                 | 0                   |
| `harvest`     | Search term with ≥ 15 mature clicks, ≥ 2 purchases, P(profitable) ≥ 0.60, no exact keyword yet               | New exact keyword, bid ≤ affordable CPC and cap | Term's daily spend  |
| `bid-up`      | Keyword with ≥ 50 mature clicks, campaign screen says scale, affordable CPC above the bid                    | Bid up to +20 % and the affordable CPC          | Δbid × daily clicks |
| `bid-down`    | Keyword screen says reduce, or P(profitable) < 0.30 with the bid above the affordable CPC                    | Bid down to −20 % or the affordable CPC         | 0                   |
| `pause`       | Keyword with zero mature purchases and spend ≥ three acquisition allowances                                  | Keyword paused                                  | 0                   |
| `budget-up`   | Campaign screen says scale                                                                                   | Daily budget up to +20 % and the policy maximum | Δbudget             |
| `budget-down` | Campaign screen says reduce wasted spend                                                                     | Daily budget −20 %                              | 0                   |

Thresholds are policy fields and can be changed per account. All classes require verified economics, a current report, complete daily coverage, a linked and synchronized platform campaign, and no open measurement wave on the campaign. Search terms that already have an exact keyword or a negative are never proposed twice, and a target with an open proposal or an applied change inside the cooldown is skipped. At most `maxActionsPerRun` proposals are saved per run, most defensive classes first.

## Operating modes and the envelope

| Mode         | Authority                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `observe`    | Sync and evaluate only; nothing can be authorized                                                 |
| `recommend`  | Proposals are saved for review; nothing executes                                                  |
| `supervised` | An operator authorizes a proposal, then presses Execute; the exact reviewed change is sent        |
| `bounded`    | Each run authorizes and executes the allowed classes that do not need review, within the envelope |

Envelope fields: maximum bid, bid step, maximum daily budget, budget step, daily commitment envelope (sum of commitments reserved or applied that UTC day), cooldown hours per target, actions per run, and maximum evidence age. Saving the policy creates a new version; authorizations record the version they were granted under.

The **kill switch** cancels every authorized or reserved proposal and blocks execution until released. It cannot recall a request the platform has already accepted, and delayed reporting means no software monitor can promise zero overshoot.

Bounded mode on a live Amazon account additionally requires `AMAZON_ADS_WRITES_ENABLED=true` on the server. The simulated account executes writes without that flag so the loop can be rehearsed.

## Harvest and negatives need relevance

A harvest is flagged **needs review** until a relevance review exists and is not `low` or `irrelevant`; a negative is flagged when the term was judged `high` relevance. Flagged proposals are never authorized by a bounded policy. With `AI review` enabled and a provider configured, each run asks the model to classify candidate terms against the campaign's **item description** (set in campaign setup). The model sees the item description and the terms only, never performance numbers. Reviews are cached by content hash, so repeated runs do not spend requests, and every AI call counts against `AI_DAILY_REQUEST_LIMIT`.

**Explain with AI** summarizes selected proposals from one campaign with risks and pre-authorization checks. **Review relevance with AI** classifies the visible terms for the selected campaign.

## Measurement

The scorecard shows, per campaign and for the selected period: spend, attributed sales, ROAS, ACOS beside the target ACOS `(unit contribution − profit reserve) / retail price` and the break-even ACOS, modeled contribution, keyword and search-term counts, the current screening decision, and open proposals.

**Ledger contribution** appears when a business ledger exists: `net receipts − units × variable cost − refunds − ad spend` over the period. Import a ledger (`date,units,net_receipts_cents,refunds_cents`) from the scorecard footer in Your workspace. Ledger receipts are reconciled facts and are kept separate from platform attribution; the two are shown side by side, never added.

## Connecting a real account

1. Obtain Amazon Ads API access and a Login with Amazon application; authorize the advertiser and keep the refresh token.
2. Set `AMAZON_ADS_CLIENT_ID`, `AMAZON_ADS_CLIENT_SECRET`, `AMAZON_ADS_REFRESH_TOKEN`, and `AMAZON_ADS_REGION` in the server `.env`. Leave `AMAZON_ADS_WRITES_ENABLED=false`.
3. Select **Your workspace**, open **The brain**, choose **Connect account → Amazon Ads profile**, and enter the profile ID. The account starts in `observe` mode.
4. Press **Sync now**, then **Link campaign** for each local campaign (its click window must match the account's attribution window). Sync again to collect performance.
5. Review proposals in `recommend` mode for at least one full attribution window. Compare them with your console decisions.
6. Enable writes on the server, switch to `supervised`, and execute individual changes while watching read-back. Only then consider a narrow `bounded` policy (negatives and bid reductions first).

Report column names follow Amazon's documented v3 report types (`spCampaigns`, `spTargeting`, `spSearchTerm`) and the request shapes follow Amazon's published Postman collection. Confirm them against the account's approved API version during onboarding; the adapter fails closed with a classified error if the response does not match.

## Background cycle

`BRAIN_SYNC_INTERVAL_MINUTES` (default 60) runs the full cycle for every workspace account with **automatic sync** enabled and the kill switch off. Set it to `0` to disable. The demo account is evaluated once at startup and never calls an AI provider during seeding.

## Storage

SQLite schema version 5 adds `accounts`, `account_links`, `platform_snapshots`, `sandbox_state`, `search_terms`, `search_term_observations`, `proposals` (unique idempotency key), `execution_attempts`, `sync_runs`, `ledger_entries`, and `ai_reviews`. Keyword performance reuses the existing target tables, so the Target explorer and test waves see synchronized keywords as ordinary measured cells.

## Boundaries

- Proposals are observational screening signals. Applying one does not establish causal lift; confirm important changes in a registered test wave.
- The daily commitment envelope bounds additional exposure from Orbit's own changes. It is not a cash lock: Amazon can spend above an average daily budget, and pauses are not instantaneous.
- Only Sponsored Products keyword campaigns are supported. Product targets, automatic targeting expressions, placements, and Sponsored Brands are read but not acted on.
- One set of Amazon credentials per server. Multi-tenant authorization, encrypted credential storage, and hosted deployment remain future work.
