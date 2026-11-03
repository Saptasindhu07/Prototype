import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { Publication } from '../src/models/publication.model.js';
import {
  normaliseDoi,
  canonicalOpenAlexId,
  reconstructAbstract,
  mapPublication,
} from '../scripts/otago-normalize.mjs';
import { crossrefAbstractText, enrichFromCrossref } from '../scripts/otago-enrich.mjs';
import { readOtagoScope, publicationWithinScope } from '../scripts/otago-scope.mjs';

test('import scope retains legacy start by default and uses Auckland collection day', () => {
  assert.deepEqual(readOtagoScope({}, new Date('2026-10-23T18:00:00Z')),
    { fromDate: '2015-01-01', cutoff: '2026-10-24', target: 8000 });
  assert.deepEqual(readOtagoScope({ OTAGO_FROM_DATE: '2010-01-01', OTAGO_TARGET: '7500' }, new Date('2026-10-23T18:00:00Z')),
    { fromDate: '2010-01-01', cutoff: '2026-10-24', target: 7500 });
});

test('scope refuses malformed, impossible, reversed and future dates or invalid targets', () => {
  const now = new Date('2026-10-23T18:00:00Z');
  for (const settings of [
    { OTAGO_FROM_DATE: '2010' }, { OTAGO_FROM_DATE: '2010-02-30' },
    { OTAGO_FROM_DATE: '1899-12-31' }, { OTAGO_FROM_DATE: '2026-10-25' },
    { OTAGO_CUTOFF: '2026-10-25' }, { OTAGO_CUTOFF: '2014-12-31' },
    { OTAGO_TARGET: '0' }, { OTAGO_TARGET: '8001' }, { OTAGO_TARGET: '7000.5' },
  ]) assert.throws(() => readOtagoScope(settings, now));
});

test('expanded publication scope checks exact date boundaries as well as years', () => {
  const scope = { fromDate: '2010-01-01', cutoff: '2026-10-24' };
  assert.ok(publicationWithinScope({ year: 2010, publicationDate: new Date('2010-01-01') }, scope));
  assert.ok(publicationWithinScope({ year: 2026, publicationDate: new Date('2026-10-24') }, scope));
  assert.ok(!publicationWithinScope({ year: 2009 }, scope));
  assert.ok(!publicationWithinScope({ year: 2026, publicationDate: new Date('2026-10-25') }, scope));
  assert.ok(!publicationWithinScope({ year: 2010, publicationDate: new Date('2009-12-31') }, scope));
  assert.ok(!publicationWithinScope(null, scope));
});

const researcherId = new mongoose.Types.ObjectId().toString();
const researcherMap = new Map([['A123', researcherId]]);

function work(overrides = {}) {
  return {
    id: 'https://openalex.org/W456',
    doi: 'https://doi.org/10.1234/ABC',
    title: 'A sourced publication',
    type: 'article',
    is_retracted: false,
    publication_year: 2021,
    publication_date: '2021-03-17',
    abstract_inverted_index: { Research: [0], methods: [1], work: [2] },
    authorships: [
      { author: { id: 'https://openalex.org/A999', display_name: 'First Author' } },
      { author: { id: 'https://openalex.org/A123', display_name: 'Cohort Author' } },
      { author: { id: 'https://openalex.org/A888', display_name: 'Last Author' } },
    ],
    primary_location: {
      landing_page_url: 'https://doi.org/10.1234/ABC',
      source: {
        display_name: 'Example Journal',
        type: 'journal',
        host_organization: 'https://openalex.org/P123',
        host_organization_name: 'Example Publisher',
      },
    },
    keywords: [{ display_name: 'Bayesian inference' }, { display_name: 'Genomics' }],
    ...overrides,
  };
}

test('DOIs are lower-case bare identifiers; missing IDs stay absent', () => {
  assert.equal(normaliseDoi(' https://doi.org/10.1234/ABC '), '10.1234/abc');
  assert.equal(normaliseDoi('10.1234/ABC'), '10.1234/abc');
  for (const missing of [null, undefined, '', '   ']) {
    assert.ok(!normaliseDoi(missing));
  }
});

test('OpenAlex IDs are canonical and cannot cross author/work namespaces', () => {
  assert.equal(canonicalOpenAlexId('https://openalex.org/A123', 'A'), 'A123');
  assert.equal(canonicalOpenAlexId('W456', 'W'), 'W456');
  for (const invalid of ['W123', 'https://example.com/A123', 'A', 'A123oops']) {
    assert.ok(!canonicalOpenAlexId(invalid, 'A'));
  }
});

test('abstract token order follows integer positions, including repeated words', () => {
  assert.equal(reconstructAbstract({ methods: [1, 3], Research: [0], and: [2] }),
    'Research methods and methods');
  assert.equal(reconstructAbstract(null), '');
  assert.equal(reconstructAbstract({}), '');
});

test('invalid abstract positions do not allocate unsafe arrays or invent text', () => {
  for (const index of [
    { bad: [-1] },
    { bad: [1.5] },
    { bad: [Number.MAX_SAFE_INTEGER + 1] },
    { bad: [1_000_000_000] },
    { missing: [1] },
    { first: [0], conflicting: [0] },
  ]) {
    assert.equal(reconstructAbstract(index), '');
  }
});

test('partial or impossible source dates never become fabricated calendar dates', () => {
  for (const publication_date of ['2021', '2021-03', '2021-02-30', 'invalid']) {
    const mapped = mapPublication(work({ publication_date }), researcherMap);
    assert.ok(mapped.publicationDate == null, publication_date);
    assert.equal(mapped.year, 2021);
  }
});

test('publication preserves every author in source order, with exact ID linkage', async () => {
  const mapped = mapPublication(work(), researcherMap);
  assert.ok(mapped);
  assert.deepEqual(mapped.authors.map((author) => author.name),
    ['First Author', 'Cohort Author', 'Last Author']);
  assert.deepEqual(mapped.authors.map((author) => author.researcherId ?? null),
    [null, researcherId, null]);
  assert.equal(mapped.externalIds.doi, '10.1234/abc');
  assert.equal(mapped.externalIds.openAlex, 'W456');
  assert.equal(mapped.abstract, 'Research methods work');
  assert.equal(mapped.year, 2021);
  assert.equal(new Date(mapped.publicationDate).toISOString(), '2021-03-17T00:00:00.000Z');
  assert.equal(mapped.venue.name, 'Example Journal');
  assert.equal(mapped.venue.publisher, 'Example Publisher');
  assert.deepEqual(mapped.keywords, ['Bayesian inference', 'Genomics']);
  await new Publication(mapped).validate();
});

test('a same-name author without the exact source ID does not acquire a cohort link', () => {
  const mapped = mapPublication(work({ authorships: [
    { author: { id: 'https://openalex.org/A123', display_name: 'Cohort Author' } },
    { author: { id: 'https://openalex.org/A555', display_name: 'Cohort Author' } },
  ] }), researcherMap);
  assert.equal(String(mapped.authors[0].researcherId), researcherId);
  assert.equal(mapped.authors[1].researcherId ?? null, null);
});

test('missing metadata stays absent instead of becoming fabricated defaults', () => {
  const mapped = mapPublication(work({
    doi: null,
    publication_date: null,
    abstract_inverted_index: null,
    keywords: [],
    primary_location: { source: { type: 'journal', display_name: 'Known Journal' } },
  }), researcherMap);
  assert.ok(mapped);
  assert.equal(mapped.year, 2021);
  assert.ok(mapped.publicationDate == null);
  assert.ok(!mapped.externalIds.doi);
  assert.equal(mapped.abstract, '');
  assert.deepEqual(mapped.keywords, []);
  assert.ok(!mapped.venue.publisher);
});

test('institution hosting a source is not mislabelled as its publisher', () => {
  const mapped = mapPublication(work({ primary_location: {
    source: {
      type: 'journal',
      display_name: 'University Repository',
      host_organization: 'https://openalex.org/I123',
      host_organization_name: 'University of Otago',
    },
  } }), researcherMap);
  assert.ok(!mapped.venue.publisher);
});

test('supported source types map to existing schema enums', () => {
  for (const [sourceType, expected] of [
    ['article', 'journal-article'],
    ['review', 'journal-article'],
    ['proceedings-article', 'conference-paper'],
    ['preprint', 'preprint'],
    ['book-chapter', 'book-chapter'],
  ]) {
    assert.equal(mapPublication(work({ type: sourceType }), researcherMap)?.type, expected);
  }
});

test('reject unsupported output types, retractions, missing titles and truncated authors', () => {
  for (const changes of [
    { type: 'dissertation' },
    { type: 'poster' },
    { type: 'paratext' },
    { is_retracted: true },
    { title: '' },
    { title: '   ' },
    { is_authors_truncated: true },
    { authorships: [{ author: { id: 'https://openalex.org/A123', display_name: '' } }] },
    { primary_location: { source: { type: 'repository' } } },
  ]) {
    assert.equal(mapPublication(work(changes), researcherMap), null,
      `should reject ${JSON.stringify(changes)}`);
  }
});

test('Crossref JATS conversion preserves inline text and scientific entities without executing markup', () => {
  assert.equal(crossrefAbstractText('<jats:p>Bio<jats:italic>informatics</jats:italic> &amp; ML.</jats:p><jats:p>a&lt;b &amp; c&gt;d, &#945;.</jats:p>'),
    'Bioinformatics & ML. a<b & c>d, α.');
  assert.equal(crossrefAbstractText('<p>Text<script>alert(1)</script>.</p>'), 'Text.');
  assert.equal(crossrefAbstractText('<p>Unknown &undefined;</p>'), '');
  assert.equal(crossrefAbstractText('<mml:math><mml:mi>x</mml:mi></mml:math>'), '');
});

test('Crossref fetches only useful missing fields and preserves existing sourced values', async () => {
  const original = mapPublication(work(), researcherMap);
  let fetches = 0;
  const complete = await enrichFromCrossref(original, async () => { fetches++; });
  assert.equal(fetches, 0);
  assert.equal(complete.skippedReason, 'no-missing-fields');

  const input = { ...original, abstract: '', venue: { name: original.venue.name } };
  const result = await enrichFromCrossref(input, async (url) => {
    fetches++;
    assert.equal(url, 'https://api.crossref.org/works/10.1234%2Fabc');
    return { message: {
      DOI: '10.1234/ABC', type: 'journal-article',
      abstract: '<jats:p>Exact-source abstract.</jats:p>', publisher: 'Registered Publisher',
      published: { 'date-parts': [[2022, 10, 12]] },
    } };
  });
  assert.equal(fetches, 1);
  assert.deepEqual(result.changedFields, ['abstract', 'venue.publisher']);
  assert.equal(result.publication.abstract, 'Exact-source abstract.');
  assert.equal(result.publication.venue.name, original.venue.name);
  assert.equal(result.publication.venue.publisher, 'Registered Publisher');
  assert.equal(result.publication.publicationDate, original.publicationDate);
  assert.equal(input.abstract, '');
  assert.equal(input.venue.publisher, undefined);
});

test('Crossref refuses DOI/type mismatches and partial or conflicting publication dates', async () => {
  const input = mapPublication(work({ publication_date: null, abstract_inverted_index: null }), researcherMap);
  for (const [record, reason] of [
    [{ DOI: '10.5555/different', abstract: 'Wrong paper' }, 'doi-mismatch'],
    [{ DOI: '10.1234/abc', type: 'book', abstract: 'Wrong type' }, 'type-conflict'],
  ]) {
    const result = await enrichFromCrossref(input, async () => ({ message: record }));
    assert.equal(result.skippedReason, reason);
    assert.deepEqual(result.changedFields, []);
  }
  for (const parts of [[2021], [2021, 3], [2021, 2, 30], [2022, 3, 17]]) {
    const result = await enrichFromCrossref(input, async () => ({ message: {
      DOI: '10.1234/abc', type: 'journal-article', published: { 'date-parts': [parts] },
      created: { 'date-parts': [[2021, 3, 17]] },
    } }));
    assert.ok(result.publication.publicationDate == null);
  }
  const full = await enrichFromCrossref(input, async () => ({ message: {
    DOI: '10.1234/abc', type: 'journal-article', published: { 'date-parts': [[2021, 3, 17]] },
  } }));
  assert.equal(full.publication.publicationDate.toISOString(), '2021-03-17T00:00:00.000Z');
  assert.deepEqual(full.changedFields, ['publicationDate']);
});

test('Crossref missing DOI or remote failure never corrupts the source publication', async () => {
  const input = mapPublication(work(), researcherMap);
  const missing = { ...input, abstract: '', externalIds: { openAlex: 'W456' } };
  let calls = 0;
  const skipped = await enrichFromCrossref(missing, async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(skipped.publication, missing);
  assert.equal(skipped.skippedReason, 'missing-doi');
  const unavailable = await enrichFromCrossref({ ...input, abstract: '' }, async () => {
    throw new Error('Network unavailable');
  });
  assert.equal(unavailable.skippedReason, 'fetch-failed');
  assert.equal(unavailable.publication.abstract, '');
});
