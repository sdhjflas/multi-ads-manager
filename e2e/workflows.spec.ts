import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { bookHeaders } from '../server/books';

test('navigates both portfolios, searches campaigns, and exports a summary', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Your campaign portfolio')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Amazon books' }).click();
  await expect(page.getByRole('heading', { name: 'Book campaigns', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('navigation').getByRole('button', { name: 'Product ads' }).click();
  await expect(page.getByRole('heading', { name: 'Product campaigns', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByLabel('Search campaigns and experiments').fill('sequential');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Reporting period').selectOption('7');
  const download = page.waitForEvent('download');
  await page.getByLabel('Export campaign summary').click();
  expect((await download).suggestedFilename()).toBe('orbit-demo-7days.csv');
  expect(errors).toEqual([]);
});

test('creates and imports a real workspace campaign, retains data, and reviews a proposal', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Data workspace').selectOption('workspace');
  await expect(page.locator('.workspace-notice')).toContainText('Your workspace.');
  await page.getByRole('button', { name: 'Add campaign', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Amazon books', exact: true }).click();
  await dialog.getByLabel('Campaign name', { exact: true }).fill('Workflow book');
  await dialog.getByLabel('Book title / format').fill('Workflow book · paperback');
  await dialog.getByLabel('Client / account').fill('Synthetic test client');
  await dialog.getByLabel('Retail book price').fill('20');
  await dialog.getByLabel('Publisher net receipts').fill('10');
  await dialog.getByLabel('Print + other variable costs').fill('4');
  await dialog.getByLabel('Profit reserve per purchase').fill('1');
  await dialog.getByLabel('Daily planning budget').fill('30');
  await dialog.getByLabel('Total learning allowance').fill('5000');
  await dialog.getByRole('checkbox').nth(0).check();
  await dialog.getByRole('checkbox').nth(1).check();
  await dialog.getByRole('checkbox').nth(2).check();
  await dialog.getByRole('button', { name: 'Create workspace' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Import data', exact: true }).click();
  const now = new Date();
  const csv = [
    'date,impressions,clicks,orders,spend_cents,sales_cents,refunds_cents',
    ...Array.from(
      { length: 40 },
      (_, i) =>
        `${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i - 1)).toISOString().slice(0, 10)},1000,100,15,2500,30000,0`,
    ),
  ].join('\n');
  await dialog.getByLabel('Or paste the CSV').fill(csv);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Import report', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('tbody')).toContainText('Scale candidate');
  await page.reload();
  await page.getByLabel('Data workspace').selectOption('workspace');
  await expect(page.locator('tbody')).toContainText('Workflow book');
  await page.getByRole('button', { name: 'View Workflow book', exact: true }).click();
  await expect(dialog).toContainText('Break-even ACOS');
  await expect(dialog).toContainText('30.0%');
  await dialog.getByRole('button', { name: 'Save proposal', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Activity log' }).click();
  await expect(
    page.getByText('Proposal saved for execution review', { exact: true }),
  ).toBeVisible();
});

test('builds a distinct candidate library, enforces wave selection, and preserves it on reload', async ({
  page,
}) => {
  await page.goto('/#books');
  await page.getByRole('button', { name: 'New experiment', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Experiment name', { exact: true })
    .fill('Browser-tested reader discovery');
  await dialog
    .getByLabel('Your hypothesis')
    .fill('Relevant nature writing terms will improve contribution per click.');
  await dialog
    .getByLabel('Relevant topics / reader interests')
    .fill('nature writing, outdoor essays, wildlife');
  await dialog.getByLabel(/^Up to/).fill('72');
  await dialog.getByLabel(/^Learning budget/).fill('300');
  await dialog.getByRole('button', { name: 'Build experiment' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Experiment lab' }).click();
  await page.getByRole('button', { name: /Browser-tested reader discovery/ }).click();
  await expect(dialog).toContainText('72');
  for (let i = 0; i < 3; i++) {
    await dialog.getByRole('button', { name: 'Shortlist', exact: true }).first().click();
    await expect(dialog.getByRole('button', { name: 'Selected', exact: true })).toHaveCount(i + 1);
  }
  await expect(dialog.getByRole('button', { name: 'Selected', exact: true })).toHaveCount(3);
  await expect(
    dialog.getByRole('button', { name: 'Shortlist', exact: true }).first(),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: /Browser-tested reader discovery/ }).click();
  await expect(dialog.getByRole('button', { name: 'Selected', exact: true })).toHaveCount(3);
  await dialog.getByLabel('Search candidates').fill('outdoor');
  await expect(dialog.locator('.candidate')).not.toHaveCount(0);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^orbit-experiment-/);
});

test('mobile layout contains overflow and offers usable navigation and setup guides', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('Your campaign portfolio')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByLabel('Open navigation').click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Connections', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Bring the right signals together.' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Amazon Ads', exact: true }) })
    .getByRole('button', { name: 'View setup guide' })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    'A simulated account is available without credentials',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('connects measured targets to the next experiment and passes overview accessibility checks', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Your campaign portfolio')).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole('navigation').getByRole('button', { name: 'Target explorer' }).click();
  await expect(
    page.getByRole('heading', { name: 'The signals inside each campaign' }),
  ).toBeVisible();
  await expect(page.locator('.target-table tbody tr')).toHaveCount(18);
  await page.getByLabel('Filter target kind').selectOption('keyword');
  await expect(page.locator('.target-table tbody tr')).toHaveCount(9);
  await page.locator('.target-table tbody tr').first().getByRole('button').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('TARGET-LEVEL EVIDENCE');
  await dialog.getByRole('button', { name: 'Use as a test seed' }).click();
  await expect(dialog.getByLabel('Experiment name', { exact: true })).toHaveValue(/confirmation/);
  await expect(dialog.getByLabel('Your hypothesis')).toHaveValue(/observed candidate/);
});

test('registers a prospective measurement wave with immutable reporting mappings and exports its setup', async ({
  page,
}) => {
  const headers = { 'X-Orbit-Request': '1' };
  const created = await page.request.post('/api/experiments', {
    headers,
    data: {
      dataset: 'demo',
      campaignId: 'demo-home',
      name: 'Browser measurement workflow',
      hypothesis: 'Focused reader terms may improve contribution relative to the baseline.',
      variable: 'keyword',
      seedTerms: ['outdoor essays'],
      count: 12,
      maxConcurrent: 2,
      budgetCents: 30000,
      provider: 'structured-planner',
    },
  });
  expect(created.ok()).toBeTruthy();
  const experiment = await created.json();
  for (const v of experiment.variants.slice(0, 2))
    await page.request.patch(`/api/experiments/${experiment.id}/variants/${v.id}`, {
      headers,
      data: { dataset: 'demo', state: 'shortlisted' },
    });
  await page.goto('/#experiments');
  await page.getByRole('button', { name: /Browser measurement workflow/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Register measurement wave' }).click();
  await dialog.getByLabel('Wave name', { exact: true }).fill('A registered reader test');
  await dialog.getByLabel('Baseline reporting ID', { exact: true }).fill('browser-baseline');
  await dialog.getByLabel('Baseline report label', { exact: true }).fill('Existing reader target');
  for (let i = 1; i <= 2; i++)
    await dialog
      .getByLabel(`Challenger ${i} reporting ID`, { exact: true })
      .fill(`browser-challenger-${i}`);
  await dialog
    .getByLabel('I checked that each reporting ID represents its assigned baseline or candidate.')
    .check();
  await dialog.getByRole('button', { name: 'Register test wave' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Give every test a clear question.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /A registered reader test/ }).click();
  await expect(dialog).toContainText('Plan registered; waiting for reporting days');
  await expect(dialog.getByRole('button', { name: 'Save learning' })).toBeDisabled();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download setup sheet' }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^orbit-wave-.+-setup.csv$/);
  await page.reload();
  await page.getByRole('button', { name: /A registered reader test/ }).click();
  await dialog.getByRole('button', { name: 'Cancel local wave', exact: true }).click();
  await dialog
    .getByLabel('Why are you ending this local wave?')
    .fill('This browser fixture was never launched on an advertising platform.');
  await dialog.getByRole('button', { name: 'Cancel local plan' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: /A registered reader test/ })).toContainText(
    'Cancelled',
  );
});

test('records a mature book finding and carries its evidence into a follow-up experiment', async ({
  page,
}) => {
  await page.goto('/#waves');
  await page.getByRole('button', { name: /Reader intent discovery/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('A candidate is ready for confirmation');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await dialog
    .getByLabel('What did we learn, and what should change next?')
    .fill(
      'Focused reader intent looks promising. Confirm it with controlled delivery and stable book economics.',
    );
  await dialog.getByRole('button', { name: 'Save learning' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Learning library' }).click();
  const card = page
    .locator('.learning-card')
    .filter({ has: page.getByRole('heading', { name: 'Reader intent discovery', exact: true }) });
  await expect(card).toContainText('Focused reader intent looks promising.');
  await card.getByRole('button', { name: 'Plan a follow-up' }).click();
  await expect(dialog).toContainText('Building on: Reader intent discovery');
  await expect(dialog.getByLabel('Relevant topics / reader interests')).not.toBeEmpty();
  await dialog.getByLabel(/^Learning budget/).fill('300');
  await dialog.getByRole('button', { name: 'Build experiment' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Experiment lab' }).click();
  await expect(
    page.getByRole('button', { name: /Reader intent discovery · follow-up/ }),
  ).toBeVisible();
});

test('test and learning pages remain accessible and fit a mobile viewport', async ({ page }) => {
  await page.goto('/#waves');
  await expect(page.getByRole('heading', { name: 'From hypothesis to evidence' })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/#learning');
  await expect(page.getByRole('heading', { name: 'A memory for the next decision' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('maps a portfolio source, previews and applies corrections, and retains its audit history', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ids: string[] = [];
  for (const name of ['Report book One', 'Report book Two']) {
    const created = await page.request.post('/api/campaigns', {
      headers: { 'X-Orbit-Request': '1' },
      data: {
        dataset: 'workspace',
        name,
        vertical: 'books',
        channel: 'amazon',
        entityName: `${name} paperback`,
        accountName: 'Synthetic reporting client',
        retailPriceCents: 2000,
        netReceiptCents: 1000,
        variableCostCents: 400,
        targetProfitCents: 100,
        dailyBudgetCents: 3000,
        totalLearningBudgetCents: 500000,
        attributionDays: 14,
        economicsVerified: true,
        trackingVerified: true,
        supplyReady: true,
      },
    });
    expect(created.ok()).toBeTruthy();
    ids.push((await created.json()).id);
  }
  await page.goto('/#reporting');
  await page.getByRole('button', { name: 'Open your reporting workspace' }).click();
  await page.getByRole('button', { name: 'Add report source', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Source name', { exact: true }).fill('Publisher daily reporting');
  await dialog.getByLabel('Account reference', { exact: true }).fill('browser-books');
  for (const name of ['Report book One', 'Report book Two'])
    await dialog.getByRole('checkbox', { name, exact: true }).check();
  await dialog.getByRole('checkbox', { name: /^I verified the account/ }).check();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Save report source', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Publisher daily reporting', exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download template' }).click();
  expect((await download).suggestedFilename()).toBe('orbit-amazon-campaigns-template.csv');
  await dialog.getByRole('button', { name: 'Stage a report', exact: true }).click();
  const now = new Date();
  const day = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
  const local = (time: number) =>
    new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const report = `Date,Campaign Name,Impressions,Clicks,Spend,14 Day Total Orders (#),14 Day Total Sales\n${day},Report book One,1000,100,3.00,5,100.00\n${day},Report book Two,2000,200,6.00,10,200.00`;
  await dialog.getByLabel('Report label', { exact: true }).fill('publisher-daily.csv');
  await dialog.getByLabel('Or paste the report CSV').fill(report);
  await dialog
    .getByLabel('Actual export time (your local time)')
    .fill(local(now.getTime() - 600000));
  await dialog.getByRole('checkbox', { name: /^I checked the actual export/ }).check();
  await dialog.getByRole('button', { name: 'Preview report', exact: true }).click();
  await expect(dialog).toContainText('Proposed row changes');
  await expect(dialog.locator('.revision-list details')).toHaveCount(2);
  let dashboard = await (await page.request.get('/api/dashboard?dataset=workspace')).json();
  expect(
    dashboard.campaigns
      .filter((c: { id: string }) => ids.includes(c.id))
      .every((c: { metrics: { spendCents: number } }) => c.metrics.spendCents === 0),
  ).toBe(true);
  await dialog.locator('.revision-list summary').first().click();
  await expect(dialog.locator('.revision-values').first()).toContainText('Ad spend');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/report-preview-desktop.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Apply report batch', exact: true }).click();
  await expect(dialog).toContainText('Before and after');
  await expect(
    dialog.getByRole('button', { name: 'Apply report batch', exact: true }),
  ).not.toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .locator('.report-source-card')
    .filter({ hasText: 'Publisher daily reporting' })
    .getByRole('button', { name: 'Stage CSV' })
    .click();
  await dialog.getByLabel('Report label', { exact: true }).fill('publisher-correction.csv');
  await dialog.getByLabel('Or paste the report CSV').fill(report.replace('3.00,5', '3.50,5'));
  await dialog
    .getByLabel('Actual export time (your local time)')
    .fill(local(now.getTime() - 300000));
  await dialog.getByRole('checkbox', { name: /^I checked the actual export/ }).check();
  await dialog.getByRole('button', { name: 'Preview report', exact: true }).click();
  await expect(
    dialog.locator('.report-counts > div').filter({ hasText: 'Corrections' }).locator('strong'),
  ).toHaveText('1');
  await expect(dialog.locator('.revision-list details')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Apply report batch', exact: true }).click();
  await expect(dialog).toContainText('Before and after');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByLabel('Data workspace').selectOption('workspace');
  await expect(page.locator('.report-history tbody tr')).toHaveCount(2);
  await page.screenshot({ path: '.artifacts/reporting-desktop.png', fullPage: true });
  await page
    .getByRole('button', { name: /publisher-correction.csv Publisher daily reporting/ })
    .click();
  await expect(dialog.locator('.revision-list details')).toHaveCount(2);
  await dialog.locator('.revision-list summary').first().click();
  await expect(dialog.locator('.revision-values').first()).toContainText('$3.00 → $3.50');
  dashboard = await (await page.request.get('/api/dashboard?dataset=workspace')).json();
  expect(dashboard.campaigns.find((c: { id: string }) => c.id === ids[0]).metrics.spendCents).toBe(
    350,
  );
  expect(errors).toEqual([]);
});

test('reporting workspace and revision details are accessible on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#reporting');
  await expect(
    page.getByRole('heading', { name: 'Bring the whole portfolio into view.' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'Open your reporting workspace' }).click();
  await expect(page.locator('.report-source-card').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: '.artifacts/reporting-mobile.png', fullPage: true });
  await page
    .getByRole('button', { name: /publisher-correction.csv Publisher daily reporting/ })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.revision-list details')).toHaveCount(2);
  await dialog.locator('.revision-list summary').first().click();
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: '.artifacts/report-revision-mobile.png', fullPage: true });
});

test('runs the brain on the simulated account: authorize, execute, read back, and kill switch', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#brain');
  await expect(
    page.getByRole('heading', { name: 'The brain behind the campaigns.' }),
  ).toBeVisible();
  await expect(page.getByText('Sample publisher · simulated Amazon Ads')).toBeVisible();
  await expect(page.getByText(/active budget ceiling/)).toBeVisible();
  await page.getByRole('button', { name: 'Policy', exact: true }).click();
  await expect(page.getByLabel('Portfolio daily budget ceiling ($)')).toHaveValue('1000');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('table', { name: 'Campaign scorecard' })).toContainText(
    'A Wilder Kind of Home',
  );
  const proposals = page.getByRole('table', { name: 'Proposed changes' });
  await expect(proposals.locator('tbody tr').first()).toBeVisible();
  await expect(page.getByRole('table', { name: 'Search terms' })).toContainText(
    'free nature wallpapers',
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/brain-desktop.png', fullPage: true });
  const row = proposals.locator('tbody tr').filter({ hasText: 'Add negative' }).first();
  await row.getByRole('button', { name: 'Authorize' }).click();
  await expect(page.getByRole('status')).toContainText('Change authorized');
  await row.getByRole('button', { name: 'Execute' }).click();
  await expect(page.getByRole('status')).toContainText('applied');
  await page.getByLabel('Filter proposals by status').selectOption('applied');
  await expect(proposals.locator('tbody tr').first()).toContainText('applied');
  await expect(
    page.getByText('Platform read-back confirms the change.', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Filter proposals by status').selectOption('open');
  await proposals.locator('tbody tr').first().getByRole('button', { name: 'Authorize' }).click();
  await page.getByRole('button', { name: 'Kill switch', exact: true }).click();
  await expect(page.getByText('Kill switch on')).toBeVisible();
  await page.getByLabel('Filter proposals by status').selectOption('cancelled');
  await expect(proposals.locator('tbody tr').first()).toContainText('cancelled');
  await page.getByRole('button', { name: 'Release kill switch' }).click();
  await expect(page.getByText('Kill switch on')).not.toBeVisible();
  await page.getByRole('button', { name: 'Run brain' }).click();
  await expect(page.getByRole('status')).toContainText('Sync ok');
  expect(errors).toEqual([]);
});

test('imports book formats, reviews economics, and keeps the portfolio usable on mobile', async ({
  page,
}) => {
  await page.goto('/#portfolio');
  await expect(
    page.getByRole('heading', { name: 'Give every book a path to profit.' }),
  ).toBeVisible();
  await expect(page.locator('.book-table tbody tr')).toHaveCount(3);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: '.artifacts/books-desktop.png', fullPage: true });

  const account = await page.request.post('/api/brain/accounts', {
    headers: { 'X-Orbit-Request': '1' },
    data: {
      dataset: 'workspace',
      name: 'Catalog test publisher',
      connector: 'sandbox',
      profileId: 'catalog-test',
      marketplace: 'US',
      attributionDays: 14,
    },
  });
  expect(account.status()).toBe(201);
  await page.getByLabel('Data workspace').selectOption('workspace');
  await page.getByRole('button', { name: 'Import catalog', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Advertising account').selectOption((await account.json()).id);
  const csv = [
    bookHeaders.join(','),
    'B000001111,,Workflow catalog paperback,Example,paperback,2000,900,300,100,10000,3000,false,true',
    'B000002222,,Workflow catalog ebook,Example,ebook,1000,650,50,100,5000,2000,true,true',
  ].join('\n');
  await dialog.getByLabel('Or paste catalog CSV').fill(csv);
  await dialog.getByRole('button', { name: 'Import formats', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('2 book formats added');
  await expect(page.locator('.book-table tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Workflow catalog paperback', exact: true }).click();
  await expect(dialog).toContainText('Verify net receipts and costs');
  await dialog.getByRole('button', { name: 'Edit economics' }).click();
  await dialog
    .getByRole('checkbox', { name: 'I verified the net receipts and costs for this format.' })
    .check();
  await dialog.getByLabel('Net receipts / unit ($)', { exact: true }).fill('9.50');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await dialog.getByRole('button', { name: 'Save book', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Book economics saved');
  const search = page.getByLabel('Search campaigns and experiments');
  await search.fill('paperback');
  await expect(search).toHaveValue('paperback');
  await expect(page.locator('.book-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Workflow catalog paperback', exact: true }).click();
  await expect(dialog).toContainText('$9.50');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: '.artifacts/books-mobile.png', fullPage: true });
});
