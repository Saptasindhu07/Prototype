import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const output = process.env.QA_OUTPUT_DIR;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const cards = page.locator('.results-list > .research-card');
const button = (name) => page.getByRole('button', { name, exact: true });
const ready = () => page.waitForFunction(() => document.querySelector('.results-list')?.getAttribute('aria-busy') === 'false');
async function queryAction(action, expected) {
  const pending = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/discovery' && Object.entries(expected).every(([key, value]) => (url.searchParams.get(key) || '') === String(value));
  });
  await action();
  const response = await pending;
  const result = await response.json();
  await ready();
  assert.equal(response.status(), 200);
  assert.deepEqual(await cards.evaluateAll((nodes) => nodes.map((node) => node.dataset.recordKey.split('-').slice(1).join('-'))), result.data.map((record) => record._id), 'UI preserves the exact backend ordering');
  return result;
}
async function search(q, kind = 'researchers') {
  await page.getByRole('searchbox').fill(q);
  return queryAction(() => button('Search').click(), { kind, q, sort: 'relevance' });
}
try {
  if (output) await mkdir(output, { recursive: true });
  await page.goto(origin); await ready();
  assert.equal(await page.getByLabel('Sort by', { exact: true }).inputValue(), 'name');
  const researchers = await search('machine learning');
  assert.ok(researchers.total > 0);
  assert.equal(await page.getByLabel('Sort by', { exact: true }).inputValue(), 'relevance');
  assert.ok(await cards.first().getByText('Top matching publication', { exact: false }).count());
  assert.match(await cards.first().innerText(), /matching publications?\./);
  await cards.first().getByRole('button', { name: 'View profile', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Why this matched', exact: true }).waitFor();
  const evidence = dialog.locator('.detail-section').filter({ has: page.getByRole('heading', { name: 'Why this matched', exact: true }) });
  assert.ok(await evidence.locator('.paper-link').count() > 0);
  assert.ok(await evidence.locator('.paper-link').count() <= 3);
  await evidence.locator('.paper-link').first().click();
  await dialog.getByRole('heading', { name: 'Abstract', exact: true }).waitFor();
  assert.match(await dialog.getByRole('link', { name: 'View source' }).getAttribute('href'), /^https?:\/\//);
  await button('Close details').click(); await dialog.waitFor({ state: 'hidden' });

  await queryAction(() => page.getByLabel('Sort by', { exact: true }).selectOption('name'), { sort: 'name', q: 'machine learning' });
  await queryAction(() => page.getByLabel('Match terms', { exact: true }).selectOption('any'), { match: 'any', sort: 'name' });
  assert.equal(await page.getByLabel('Sort by', { exact: true }).inputValue(), 'name');
  const oldUrl = page.url();
  await search('genomics');
  await page.goBack(); await ready();
  assert.equal(page.url(), oldUrl);
  await page.reload(); await ready();
  assert.equal(await page.getByLabel('Match terms', { exact: true }).inputValue(), 'any');
  assert.equal(await page.getByLabel('Sort by', { exact: true }).inputValue(), 'name');

  const filteredResearchers = await queryAction(() => page.getByLabel('Year', { exact: true }).selectOption('2025'), { kind: 'researchers', year: '2025' });
  assert.ok(filteredResearchers.data.length > 0);
  assert.ok(filteredResearchers.data.every((record) => record.matchedPublicationCount > 0 && record.matchingPublications.every((paper) => paper.year === 2025)));

  const firstName = await cards.first().locator('h2').innerText();
  await cards.first().getByRole('button', { name: `Save ${firstName}`, exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('research-atlas:saved:live:v1')));
  assert.ok(!('searchMatch' in saved[0].record)); assert.ok(!('matchingPublications' in saved[0].record));
  await button('Clear all').click(); await ready();
  await page.getByRole('group', { name: 'Result type' }).getByRole('button', { name: /Publications/ }).click(); await ready();
  assert.equal(await page.getByLabel('Sort by', { exact: true }).inputValue(), 'newest');
  const publications = await search('"machine learning"', 'publications');
  assert.ok(publications.total > 0);
  assert.equal(await cards.first().getByRole('link', { name: /Open paper/ }).getAttribute('href'), publications.data[0].publicationUrl);
  assert.match(await cards.first().innerText(), /Matched in|Exact match in/);
  await queryAction(() => page.getByLabel('Year', { exact: true }).selectOption('range'), { kind: 'publications', year: '' });
  await queryAction(() => page.getByLabel('Year from', { exact: true }).selectOption('2020'), { yearFrom: '2020' });
  const ranged = await queryAction(() => page.getByLabel('Year to', { exact: true }).selectOption('2025'), { yearFrom: '2020', yearTo: '2025' });
  assert.ok(ranged.data.every((record) => record.year >= 2020 && record.year <= 2025));
  assert.equal(new URL(page.url()).searchParams.get('year'), null);
  if (ranged.pages > 1) {
    await queryAction(() => page.getByRole('navigation', { name: 'Results pages' }).getByRole('button', { name: 'Next', exact: true }).click(),
      { q: '"machine learning"', yearFrom: '2020', yearTo: '2025', sort: 'relevance', page: '2' });
    await page.reload(); await ready();
    assert.equal(new URL(page.url()).searchParams.get('page'), '2');
  }
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  if (output) await page.screenshot({ path: path.join(output, 'search-desktop.png'), fullPage: true });
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Search filters fit ${width}px`);
    if (output && width === 390) await page.screenshot({ path: path.join(output, 'search-mobile.png'), fullPage: true });
  }
  await button('Clear all').click(); await ready();
  assert.equal(await page.getByLabel('Match terms', { exact: true }).inputValue(), 'all');
  assert.equal(await page.getByLabel('Year from', { exact: true }).count(), 0);
  await page.getByRole('searchbox').fill('"unclosed phrase'); await button('Search').click();
  await page.getByRole('heading', { name: 'Check your search.', exact: true }).waitFor();
  assert.match(await page.locator('.empty-description').innerText(), /balanced/);
  assert.equal(await page.getByRole('heading', { name: 'Let’s reconnect to the collection.', exact: true }).count(), 0);
  await button('Clear filters').click(); await ready();

  await page.route('**/api/discovery?*', (route) => route.fulfill({ status: 422, json: { error: { message: 'Search is too broad; narrow the query or filters.' } } }));
  await button('Refresh collection').click();
  await page.getByRole('heading', { name: 'Check your search.', exact: true }).waitFor();
  assert.match(await page.locator('.empty-description').innerText(), /narrow/);
  await page.unroute('**/api/discovery?*');
  await page.goto(`${origin}/?demo=1&q=genomics%20quantum&match=any`); await ready();
  assert.equal(await cards.count(), 3);
  assert.equal(await page.getByLabel('Sort by', { exact: true }).inputValue(), 'relevance');
  await page.getByLabel('Match terms', { exact: true }).selectOption('all'); await ready();
  assert.equal(await cards.count(), 0);
  assert.deepEqual(errors, []);
  console.log('Passed: live backend ranking/order, evidence dialogs, safe paper links, query-aware sorts, all/any, range pagination, Back/reload, stale-save protection, 320–1440px fit, validation/limit messages and matching sample mode.');
} finally { await browser.close(); }
