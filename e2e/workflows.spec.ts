import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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
    'Pathway currently uses the advertising console',
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
