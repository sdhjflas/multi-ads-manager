# Amazon Ads API operating contract

Checked against Amazon's official documentation and published Postman collection on September 22, 2026. This is the contract implemented by Orbit's Sponsored Products connector. It is not proof that Pathway's credentials have Amazon Ads API access; the partner still needs to confirm the API product and server configuration. Selling Partner API and Amazon Advantage access do not grant advertising access.

## Connection and identity

Orbit uses Login with Amazon refresh-token authentication and the regional Amazon Ads endpoints:

| Region        | Base URL                                |
| ------------- | --------------------------------------- |
| North America | `https://advertising-api.amazon.com`    |
| Europe        | `https://advertising-api-eu.amazon.com` |
| Far East      | `https://advertising-api-fe.amazon.com` |

The server discovers profiles with `GET /v2/profiles`. That request uses the bearer token and client ID without a profile scope. A selected profile supplies the country, currency, account type, and IANA timezone. Orbit currently accepts USD profiles, records the configured region, and refuses later synchronization if Amazon's profile identity, marketplace, currency, or timezone no longer matches.

Credentials stay in server environment variables. The browser receives profile metadata, never the client secret, refresh token, or access token. One credential set and region are supported per local server. The repository does not implement the advertiser consent flow, token encryption, credential rotation, network authentication, or client tenancy.

Sources: [retrieve profiles](https://advertising.amazon.com/API/docs/en-us/guides/get-started/retrieve-profiles), [regional endpoints](https://advertising.amazon.com/API/docs/en-us/reference/api-overview), [authorization](https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/overview).

## Sponsored Products reads

The connector uses Amazon's v3 media types and paginated list endpoints for campaigns, ad groups, keywords, negative keywords, targeting clauses, and negative targeting clauses. Responses are schema-checked. Unsafe numeric IDs, unknown states or match types, malformed targeting expressions, missing money, repeated pagination tokens, repeated entities, and pagination beyond the local bound reject the entire snapshot. Campaign filters are chunked so a portfolio with hundreds of campaigns does not create an oversized request.

Orbit collects six daily Reporting v3 products:

| Orbit grain                | Report type           | Group        | Purpose                                                |
| -------------------------- | --------------------- | ------------ | ------------------------------------------------------ |
| Campaign                   | `spCampaigns`         | `campaign`   | Parent spend, purchases, and sales                     |
| Keyword                    | `spTargeting`         | `targeting`  | Exact, phrase, and broad keyword performance           |
| Keyword search term        | `spSearchTerm`        | `searchTerm` | Customer-query discovery and keyword waste review      |
| Product target             | `spTargeting`         | `targeting`  | Product and automatic-target expression performance    |
| Product-target search term | `spSearchTerm`        | `searchTerm` | Matched-ASIN discovery and product-target waste review |
| Advertised product         | `spAdvertisedProduct` | `advertiser` | ASIN and same-SKU purchases, units, and sales          |

Keyword reports explicitly filter to `BROAD`, `PHRASE`, and `EXACT`. Product-target reports use the separate `TARGETING_EXPRESSION` and `TARGETING_EXPRESSION_PREDEFINED` filters. This keeps keyword and product evidence in different measured cells. Amazon's `*` search-term placeholder is retained but never harvested or negated.

Orbit preserves every product-target expression for inspection. A single uppercase `ASIN_SAME_AS` value is also recorded as a directly verifiable ASIN. Category, brand, refinement, and automatic expressions are never converted into an ASIN and remain observe-only.

The advertised-product report keeps total attributed purchases and sales separate from same-SKU purchases, units, and sales. Only same-ASIN units feed a book's modeled contribution. Other-SKU sales, Kindle page-read royalties, and series read-through never become title income automatically.

Sources: [Reporting v3 start guide](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/get-started), [campaign reports](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/campaign), [targeting reports](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/targeting), [search-term reports](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/search-term), [advertised-product reports](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/advertised-product), [product targeting guide](https://advertising.amazon.com/help/GB2JECV9CJK6R6AL), [book reporting guide](https://advertising.amazon.com/library/guides/book-advertising-reporting).

## Durable report jobs

Amazon Reporting v3 is asynchronous. Orbit splits each refresh into inclusive windows of at most 31 days and never requests data outside the documented 95-day retention period. A first sync refreshes 56 completed account-calendar days. Later successful generations still refresh at least 56 days so delayed conversion restatements do not leave old cohorts frozen.

Each request is stored before its create call. Its report ID, state, dates, exact configuration, polling time, generation time, row count, and diagnostic message survive process restarts. Pending jobs use bounded polling delays and the background worker checks them every minute. A complete report is accepted only when its retrieved dates, report type, group, columns, filters, time unit, and format match the saved request.

The entity snapshot captured at the start of a report generation is reused while those jobs are pending, avoiding repeated full-account listing calls on every poll. Once all six grains are validated and committed, Orbit keeps compact job metadata and releases the duplicate rolling-window payloads; normalized observations remain durable.

Amazon documents report generation times up to three hours, `425` for a duplicate create request, and `429` throttling. Orbit honors numeric or HTTP-date `Retry-After`. If a duplicate response identifies the prior report UUID, Orbit resumes it. If a create response is lost and no report ID can be recovered, the job becomes `uncertain`; the operator must attach the existing ID or deliberately retry the saved contract. Orbit never silently submits a second job after an ambiguous create.

Downloads accept only direct HTTPS Amazon S3 addresses, reject credentials and nonstandard ports, disable redirects, omit Ads authorization headers, and cap compressed and decompressed sizes. JSON rows are bounded and schema-checked before a transaction changes observations. The report's actual `generatedAt` timestamp becomes evidence freshness; the time Orbit happened to poll it does not.

Sources: [Reporting v3 start guide](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/get-started), [Reporting FAQ](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/faq).

## Attribution and account dates

The connector supports Amazon's documented 1, 7, 14, and 30-day purchase/sales columns. Each account keeps Amazon's IANA timezone, and completed dates, cohort maturity, comparison windows, and report bounds use that calendar. Daily aggregates are not relabeled as UTC.

Amazon notes that click data can take hours to settle and conversions can arrive or be corrected later. A 14-day attribution column can continue changing after the original click cohort. Orbit therefore re-requests a long rolling window, keeps report generation time, and blocks decisions on missing, stale, partial, or internally inconsistent grains. It does not cap purchases, increase impressions, or invent live keyword/search-term zero rows to make data fit the statistical model.

Amazon changed view-attribution behavior for some store ads beginning January 1, 2026; Sponsored Products click attribution is unaffected by that announcement. Orbit requests click-attributed Sponsored Products columns and still requires the connected account's actual reporting definition during pilot validation.

Sources: [Reporting FAQ](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/faq), [2026 view-attribution update](https://advertising.amazon.com/resources/whats-new/view-attribution-updates-for-amazon-store-ads).

## Writes and authority

The adapter can create exact keywords, negative exact keywords, direct-ASIN product targets, and negative direct-ASIN product targets. It can update keyword and direct-ASIN target bids or state, and update Sponsored Products campaign budgets. Product-target payloads are limited to numeric Amazon IDs, uppercase 10-character ASINs, and bounded integer-cent bids before any request reaches the network. Live writes require all of the following:

1. server-level `AMAZON_ADS_WRITES_ENABLED=true`;
2. a supervised or bounded account policy;
3. a complete successful synchronization;
4. current evidence and an unchanged policy version;
5. verified campaign and book economics;
6. a single mapped advertised ASIN whose product rows reconcile with campaign facts;
7. expected platform state, account commitment room, title loss room, title daily-budget room, and room beneath the account portfolio daily-budget ceiling.

The execution outbox is written before the API mutation. Lost responses become uncertain and require read-back. Every accepted mutation is read back from Amazon before Orbit marks it applied. Before a budget increase, Orbit totals all enabled campaign budgets returned by Amazon, including unlinked campaigns, and cancels if the reviewed increase no longer fits the portfolio ceiling. Concurrent increases reserve that room inside the local transaction. Daily budgets and their portfolio sum are not hard cash caps: Amazon can vary daily delivery under its budgeting policy, and a pause is not instantaneous.

Matched ASINs can become a reviewed direct product target after mature profitable evidence, or a reviewed negative product target after mature loss evidence. Both actions always require an operator because the Ads API report does not prove title relevance or retail eligibility. Existing direct-ASIN bid and pause changes can use the normal policy envelope. Orbit does not write category, brand, refinement, or automatic targeting expressions.

Sources: [Sponsored ads daily budgeting policy](https://advertising.amazon.com/resources/whats-new/sponsored-ads-daily-budgeting-policy-and-options), [Amazon Ads advanced tools/Postman repository](https://github.com/amzn/ads-advanced-tools-docs), [Amazon search-term guidance](https://advertising.amazon.com/help/G3HEFZYWZF84NPS9).

## Unified reporting migration watch

Amazon announced unified reporting in June 2026: the unified console experience is generally available, its API is beta, and older console reporting pages are scheduled to sunset December 31, 2026. That notice does not say Reporting v3 itself sunsets on that date. Orbit keeps the stable Reporting v3 adapter and isolates its report contract so a verified Unified API migration can be added without relabeling historical data.

Source: [Amazon unified reporting announcement](https://advertising.amazon.com/resources/whats-new/streamline-campaign-analysis-with-unified-reporting), [Amazon Ads advanced tools/Postman repository](https://github.com/amzn/ads-advanced-tools-docs).

## Pilot validation

Before using recommendations on real books, confirm the configured credentials are for the Amazon Ads API, discover the expected USD profile, and compare one report of each of the six grains with the advertising console. Verify timezone, attribution window, campaign and ad-group identity, target expressions, matched ASINs, advertised-ASIN coverage, same-SKU units, and totals. Run in observe mode for at least one attribution window. Reconcile actual publisher receipts, costs, returns, and availability separately; attributed retail sales are not publisher profit.
