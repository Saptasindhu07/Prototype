import assert from 'node:assert/strict';
import test from 'node:test';
import { clearedFilters, discoveryParams, explorerSearch, nextExplorerLocation, readExplorerLocation } from '../src/services/explorer-state.js';
import { getDiscovery, publicationLink } from '../src/services/research-api.js';
import { savedSnapshot } from '../src/hooks/use-saved-records.js';
import { sampleDiscovery, samplePublications, sampleResearchers } from '../src/services/sample-data.js';

test('query-aware defaults and explicit relevance/name/date sorts round-trip', () => {
  assert.equal(readExplorerLocation('').sort, 'name');
  assert.equal(readExplorerLocation('?kind=publications').sort, 'newest');
  for (const kind of ['researchers', 'publications']) {
    assert.equal(readExplorerLocation(`?kind=${kind}&q=quantum`).sort, 'relevance');
    assert.equal(readExplorerLocation(`?kind=${kind}&q=quantum&sort=relevance`).sort, 'relevance');
  }
  assert.equal(readExplorerLocation('?q=quantum&sort=name').sort, 'name');
  assert.equal(readExplorerLocation('?kind=publications&q=quantum&sort=newest').sort, 'newest');
});

test('new queries and type switches reset sort/page; filters and pages preserve explicit sorting', () => {
  const initial = readExplorerLocation('?kind=publications&q=quantum&sort=oldest&page=3');
  const changed = nextExplorerLocation(initial, { q: '  machine   learning  ' });
  assert.equal(changed.q, 'machine learning'); assert.equal(changed.sort, 'relevance'); assert.equal(changed.page, 1);
  assert.equal(nextExplorerLocation(initial, { yearFrom: '2020' }).sort, 'oldest');
  assert.equal(nextExplorerLocation(initial, { page: 2 }).sort, 'oldest');
  assert.equal(nextExplorerLocation(initial, { q: 'quantum' }).sort, 'oldest');
  assert.equal(nextExplorerLocation(initial, { q: '' }).sort, 'newest');
  assert.equal(nextExplorerLocation(initial, { kind: 'researchers' }).sort, 'relevance');
});

test('match, ranges, researcher scope and pagination survive URL reload/back', () => {
  const state = readExplorerLocation('?section=publications&q=%22machine%20learning%22&match=any&yearFrom=2005&yearTo=2024&type=preprint&department=Physics&researcher=123456789012345678901234&sort=relevance&page=2');
  assert.deepEqual(readExplorerLocation(explorerSearch(state)), state);
  const params = discoveryParams(state, 6);
  assert.equal(params.match, 'any'); assert.equal(params.yearFrom, '2005'); assert.equal(params.yearTo, '2024');
  assert.equal(params.researcher, '123456789012345678901234'); assert.equal(params.limit, 6);
  const researcherParams = discoveryParams({ ...state, kind: 'researchers' }, 6);
  assert.equal(researcherParams.type, 'preprint'); assert.equal(researcherParams.yearTo, '2024');
  assert.ok(!('section' in params)); assert.ok(!('demo' in params));
});

test('legacy year links remain exclusive and malformed enum/ID values normalize safely', () => {
  const state = readExplorerLocation('?year=2020&yearFrom=2000&yearTo=2026&sort=bogus&match=bogus&type=bogus&researcher=bad&page=-1');
  assert.equal(state.year, '2020'); assert.equal(state.yearFrom, ''); assert.equal(state.yearTo, '');
  assert.equal(state.match, 'all'); assert.equal(state.type, ''); assert.equal(state.researcher, ''); assert.equal(state.page, 1);
  assert.equal(readExplorerLocation('?year=0999').year, '');
});

test('clear filters clears new range/match/identity state as well as the query', () => {
  const state = readExplorerLocation('?q=quantum&match=any&yearFrom=2000&yearTo=2026&type=preprint&department=Physics&page=2');
  const cleared = nextExplorerLocation(state, clearedFilters);
  assert.equal(cleared.q, ''); assert.equal(cleared.match, 'all'); assert.equal(cleared.sort, 'name');
  for (const field of ['year', 'yearFrom', 'yearTo', 'type', 'department', 'researcher']) assert.equal(cleared[field], '');
  assert.equal(cleared.page, 1);
});

test('API forwards the search contract, signal and server ordering without client-side ranking', async (t) => {
  const data = { data: [{ _id: 'z' }, { _id: 'a' }], total: 2, page: 1, limit: 6, pages: 1 };
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const query = new URL(url, 'http://localhost').searchParams;
    assert.equal(query.get('q'), '"machine learning"'); assert.equal(query.get('match'), 'any');
    assert.equal(query.get('yearFrom'), '2020'); assert.equal(query.get('sort'), 'relevance');
    assert.equal(options.signal, signal);
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const result = await getDiscovery({ kind: 'publications', q: '"machine learning"', match: 'any', yearFrom: '2020', sort: 'relevance' }, false, 0, signal);
  assert.deepEqual(result, data);
});

test('safe validation/limit/timeout messages are shown; unexpected server details are hidden', async (t) => {
  for (const status of [400, 422, 503, 500]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Controlled message' } }), { status }));
    await assert.rejects(getDiscovery({}, false, 0), (error) => error.status === status
      && (status === 500 ? !error.message.includes('Controlled') : error.message === 'Controlled message'));
    mock.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Unavailable</html>', { status: 503 }));
  await assert.rejects(getDiscovery({}, false, 0), /collection could not be reached/);
});

test('paper links prefer validated backend URLs, then DOI, then safe source URL', () => {
  assert.equal(publicationLink({ publicationUrl: 'https://example.org/paper', sourceUrl: 'https://example.org/old' }), 'https://example.org/paper');
  assert.equal(publicationLink({ externalIds: { doi: '10.1234/a:b' } }), 'https://doi.org/10.1234/a%3Ab');
  assert.equal(publicationLink({ publicationUrl: 'javascript:alert(1)', sourceUrl: 'https://example.org/paper#section' }), 'https://example.org/paper#section');
  assert.equal(publicationLink({ sourceUrl: 'javascript:alert(1)' }), null);
  assert.equal(publicationLink(null), null);
});

test('saving drops request-specific scores/evidence without mutating results', () => {
  const record = { _id: 'x', title: 'Paper', abstract: 'Large text', publicationUrl: 'https://example.org/paper', searchMatch: { score: 50 },
    matchingPublications: [{}], matchedPublicationCount: 1, duplicateRecordIds: ['y'] };
  assert.deepEqual(savedSnapshot(record), { _id: 'x', title: 'Paper', publicationUrl: 'https://example.org/paper' });
  assert.equal(record.searchMatch.score, 50);
});

test('sample mode supports literal phrases, all/any, evidence and query-aware relevance', () => {
  const before = JSON.stringify([sampleResearchers, samplePublications]);
  assert.equal(sampleDiscovery({ q: 'genomics', limit: 24 }).total, 2);
  assert.equal(sampleDiscovery({ q: 'genomics quantum', match: 'all' }).total, 0);
  assert.equal(sampleDiscovery({ q: 'genomics quantum', match: 'any' }).total, 3);
  const result = sampleDiscovery({ q: '"software testing"' });
  assert.equal(result.total, 1); assert.equal(result.data[0].name, 'Alex Morgan');
  assert.equal(result.search.sort, 'relevance'); assert.equal(result.data[0].matchingPublications.length, 1);
  assert.equal(JSON.stringify([sampleResearchers, samplePublications]), before);
});

test('sample year/type filters require qualifying papers in both result kinds', () => {
  assert.equal(sampleDiscovery({ kind: 'publications', yearFrom: '2023', yearTo: '2023' }).total, 2);
  assert.equal(sampleDiscovery({ kind: 'researchers', year: '2023' }).total, 2);
  assert.equal(sampleDiscovery({ kind: 'publications', year: '2023', type: 'conference-paper' }).total, 0);
  assert.throws(() => sampleDiscovery({ yearFrom: '2025', yearTo: '2023' }), (error) => error.status === 400);
});
