import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const output = process.env.QA_OUTPUT_DIR;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const button = (name) => page.getByRole('button', { name, exact: true });
const cards = page.locator('.results-list > .research-card');
const ready = () => page.waitForFunction(() => document.querySelector('.results-list')?.getAttribute('aria-busy') === 'false');

try {
  await page.goto(origin); await ready();
  assert.ok(await cards.count() > 0, 'Live collection is connected');
  assert.equal(await page.getByLabel('Academic unit', { exact: true }).locator('option').count(), 9);
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'homepage-desktop.png'), animations: 'disabled' }); }
  const liveName = await cards.first().locator('h2').innerText();
  await cards.first().getByRole('button', { name: 'View profile', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: liveName, exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('heading', { name: /Publications in this collection/ }).waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.ok(await cards.first().getByRole('button', { name: 'View profile', exact: true }).evaluate((element) => element === document.activeElement), 'Closing details restores keyboard focus');
  await page.getByLabel('Academic unit', { exact: true }).selectOption('School of Computing'); await ready();
  assert.ok((await cards.locator('.affiliation').allTextContents()).every((text) => text === 'School of Computing'));

  await page.goto(`${origin}/?demo=1`); await ready();
  assert.equal(await cards.count(), 6);
  await page.getByRole('navigation', { name: 'Results pages' }).getByRole('button', { name: 'Next', exact: true }).click(); await ready();
  assert.equal(await cards.count(), 2);
  await page.goBack(); await ready(); assert.equal(await cards.count(), 6);
  await button('Save Alex Morgan').click(); await page.reload(); await ready();
  assert.equal(await button('Unsave Alex Morgan').count(), 1, 'Save survives refresh');
  await button('Compare Alex Morgan').click(); assert.ok(await button('Compare selected').isDisabled());
  await button('Compare Avery Wilson').click(); await button('Compare selected').click();
  assert.equal(await page.getByRole('dialog').locator('.comparison-person').count(), 2);
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' }); await button('Clear').click();

  await page.getByRole('searchbox').fill('genomics'); await button('Search').click(); await ready();
  assert.equal(await cards.count(), 2);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'genomics');
  await page.reload(); await ready(); assert.equal(await cards.count(), 2);
  await button('Clear all').click(); await ready();
  await page.getByLabel('Academic unit', { exact: true }).selectOption('Biochemistry'); await ready();
  assert.equal(await cards.count(), 1); assert.match(await cards.first().innerText(), /Sam Taylor/);
  await cards.first().getByRole('button', { name: 'View profile', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Read publication', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Read publication', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Abstract', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Publications', exact: true }).click(); await ready();
  await page.getByLabel('Year', { exact: true }).selectOption('2023'); await ready();
  assert.equal(await cards.count(), 2);
  await page.getByLabel('Publication type', { exact: true }).selectOption('conference-paper'); await ready();
  assert.equal(await cards.count(), 0); assert.equal(await page.getByRole('heading', { name: 'No results for these filters.' }).count(), 1);
  await button('Clear filters').click(); await ready();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /Saved/ }).click();
  assert.equal(await cards.count(), 1); assert.match(await cards.first().innerText(), /Alex Morgan/);
  await button('View live collection').click();
  await page.getByRole('heading', { name: 'Make room for your next idea.' }).waitFor();

  await page.goto(origin); await ready();
  await page.route('**/api/discovery?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await button('Refresh collection').click(); await page.getByRole('heading', { name: 'Let’s reconnect to the collection.' }).waitFor();
  await page.unroute('**/api/discovery?*'); await button('Try again').click(); await ready();
  assert.ok(await cards.count() > 0, 'Retry restores live records');

  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}px`);
    if (output && width === 390) await page.screenshot({ path: path.join(output, 'homepage-mobile.png'), fullPage: true, animations: 'disabled' });
  }
  await cards.first().getByRole('button', { name: 'View profile', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: liveName, exact: true }).waitFor();
  assert.ok(await page.getByRole('dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), 'Mobile dialog fits');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await cards.first().getByRole('button', { name: 'View profile', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: liveName, exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').evaluate((dialog) => getComputedStyle(dialog).animationName), 'none');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Reduced motion closes without an exit delay');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('Passed: live data, 8 departments, profile/publication dialogs, pagination, Back/refresh, saved persistence, comparison, keyword/year/type filters, no-results and retry states, and 320–1440px layouts.');
} finally { await browser.close(); }
