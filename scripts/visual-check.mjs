import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
await mkdir('.artifacts', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5173');
await page.getByText('Your campaign portfolio').waitFor();
await page.screenshot({ path: '.artifacts/overview-desktop.png', fullPage: true });
await page.goto('http://127.0.0.1:5173/#waves');
await page.getByRole('heading', { name: 'From hypothesis to evidence' }).waitFor();
await page.screenshot({ path: '.artifacts/waves-desktop.png', fullPage: true });
await page.getByRole('button', { name: /Reader intent discovery/ }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: '.artifacts/wave-detail-desktop.png', fullPage: true });
await page.keyboard.press('Escape');
await page.goto('http://127.0.0.1:5173/#learning');
await page.getByRole('heading', { name: 'A memory for the next decision' }).waitFor();
await page.screenshot({ path: '.artifacts/learning-desktop.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto('http://127.0.0.1:5173/#waves');
await page.getByRole('heading', { name: 'From hypothesis to evidence' }).waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: '.artifacts/waves-mobile.png', fullPage: true });
await page.goto('http://127.0.0.1:5173/');
await page.getByText('Your campaign portfolio').waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: '.artifacts/overview-mobile.png', fullPage: true });
console.log(
  JSON.stringify({
    errors,
    layout: await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 2)
        .slice(0, 16)
        .map((e) => ({
          tag: e.tagName,
          class: e.className,
          width: e.getBoundingClientRect().width,
          right: e.getBoundingClientRect().right,
        })),
    })),
  }),
);
await browser.close();
