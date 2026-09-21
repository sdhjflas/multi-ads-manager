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
await page.setViewportSize({ width: 390, height: 844 });
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
