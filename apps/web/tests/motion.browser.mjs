import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sampleDiscovery, sampleSummary } from '../src/services/sample-data.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const output = process.env.QA_OUTPUT_DIR;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const ready = () => page.waitForFunction(() => document.querySelector('.results-list')?.getAttribute('aria-busy') === 'false');
const settle = () => page.evaluate(async () => {
  await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
});
const snap = async name => { if (output) await page.screenshot({ path: path.join(output, name) }); };
try {
  if (output) await mkdir(output, { recursive: true });
  await page.goto(`${origin}/?demo=1`); await ready(); await settle();
  const backgrounds = await page.locator('.ambient-flow').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationDuration));
  assert.deepEqual(backgrounds, ['44s', '61s']);
  await page.mouse.move(1000, 200);
  await page.waitForFunction(() => document.querySelector('.ambient-pointer').style.opacity === '1');
  await snap('ambient-desktop.png');

  await page.getByRole('button', { name: 'Save Alex Morgan', exact: true }).click();
  await page.locator('.motion-paper').waitFor();
  assert.ok(await page.evaluate(() => localStorage.getItem('research-atlas:saved:sample:v1').includes('Alex Morgan')));
  assert.ok(await page.getByRole('button', { name: 'Unsave Alex Morgan', exact: true }).evaluate(node => document.activeElement === node));
  await snap('save-flight.png'); await settle();

  await page.getByRole('button', { name: 'View profile', exact: true }).first().click();
  await page.locator('.motion-title').waitFor();
  assert.equal(await page.locator('.motion-title').textContent(), 'Alex Morgan');
  await snap('title-unfold.png'); await settle();
  assert.equal(await page.getByRole('dialog').locator('.detail-title').evaluate(node => getComputedStyle(node).opacity), '1');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.locator('.motion-title').waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' }); await settle();
  assert.equal(await page.locator('.motion-layer').count(), 0);
  assert.ok(await page.getByRole('button', { name: 'View profile', exact: true }).first().evaluate(node => document.activeElement === node));

  await page.getByRole('button', { name: 'Compare Alex Morgan', exact: true }).click();
  await page.locator('.motion-avatar').waitFor(); await settle();
  await page.getByRole('button', { name: 'Compare Avery Wilson', exact: true }).click(); await settle();
  assert.equal(await page.locator('.compare-avatar').count(), 2);
  await page.getByRole('button', { name: 'Compare selected', exact: true }).click();
  await page.locator('.motion-avatar').first().waitFor();
  assert.equal(await page.locator('.motion-avatar').count(), 2, 'One flight per selected avatar, including StrictMode remounts');
  assert.equal(await page.getByRole('dialog').locator('.comparison-person').count(), 2);
  await settle(); await snap('comparison-expanded.png');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /Saved/ }).click(); await settle();
  await page.getByRole('button', { name: 'Unsave Alex Morgan', exact: true }).click();
  await page.locator('.motion-card-ghost').waitFor(); await settle();
  assert.ok(await page.getByRole('button', { name: 'Explore research', exact: true }).evaluate(node => document.activeElement === node));

  let release;
  let gate = Promise.resolve();
  await page.route('**/api/discovery/summary', route => route.fulfill({ json: { data: sampleSummary() } }));
  await page.route('**/api/discovery?*', async route => {
    const params = Object.fromEntries(new URL(route.request().url()).searchParams);
    await gate;
    await route.fulfill({ json: sampleDiscovery(params) });
  });
  await page.goto(origin); await ready(); await settle();
  const before = await page.locator('.results-list > .research-card').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey));
  gate = new Promise(resolve => { release = resolve; });
  await page.getByLabel('Academic unit', { exact: true }).selectOption('School of Computing');
  await page.waitForFunction(() => document.querySelector('.motion-list').inert);
  assert.deepEqual(await page.locator('.results-list > .research-card').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey)), before);
  assert.equal(await page.locator('.search-bar').getAttribute('data-loading'), 'true');
  assert.equal(await page.locator('.search-signal > span').evaluate(node => getComputedStyle(node).animationName), 'atlas-search-sweep');
  release(); await ready(); await settle();
  assert.equal(await page.locator('.results-list > .research-card').count(), 1);
  assert.equal(await page.locator('.motion-list').getAttribute('inert'), null);
  assert.equal(await page.locator('.search-bar').getAttribute('data-loading'), 'false');
  await page.getByRole('button', { name: 'Clear all', exact: true }).click(); await ready(); await settle();
  await page.getByLabel('Sort by', { exact: true }).selectOption('Recently added'); await ready();
  assert.ok(await page.locator('.results-list > .research-card').evaluateAll(nodes => nodes.some(node => node.getAnimations().length > 0)));
  await settle(); assert.equal(await page.locator('.motion-layer').count(), 0);

  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.emulateMedia({ colorScheme: 'dark' }); await settle(); await snap('ambient-mobile-dark.png');
  await page.goto(`${origin}/?demo=1`); await ready(); await settle();
  await page.getByRole('button', { name: 'Save Alex Morgan', exact: true }).click();
  await page.locator('.motion-paper').waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelectorAll('.motion-layer').length === 0);
  assert.equal(await page.locator('.ambient-flow').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await page.locator('.ambient-pointer').evaluate(node => getComputedStyle(node).display), 'none');
  await page.getByRole('button', { name: 'Unsave Alex Morgan', exact: true }).click();
  assert.equal(await page.locator('.motion-layer').count(), 0);
  await page.getByRole('button', { name: 'View profile', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Research overview', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length), 0);
  assert.deepEqual(errors, []);
  console.log('Passed: water/pointer light, immediate save and flight, title unfold/return, comparison docking, saved-removal focus, inert pending cards, search sweep, filter/sort reflow, mobile fit, reduced-motion cleanup.');
} finally { await browser.close(); }
