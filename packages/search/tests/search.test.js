import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSearch, groupPublications, publicationIdentity, publicationUrl, scoreRecord, textFilter } from '@research-atlas/search';

const score = (record, q, match = 'all', kind = 'publications', topicOnly = false) => scoreRecord(record, compileSearch(q, match), kind, topicOnly);

test('all terms may span fields of ONE document; any requires at least one', () => {
  assert.ok(score({ title: 'Machine', abstract: 'learning algorithms' }, 'machine learning').matched);
  assert.ok(!score({ title: 'Machine' }, 'machine learning').matched);
  assert.ok(score({ title: 'Machine' }, 'machine learning', 'any').matched);
  assert.ok(!score({}, 'machine', 'any').matched);
});

test('phrases remain contiguous in one field value, with whitespace and case normalization', () => {
  assert.ok(score({ title: 'Machine \n learning' }, '"machine learning"').matched);
  assert.ok(!score({ title: 'Machine', abstract: 'learning' }, '"machine learning"').matched);
  assert.ok(!score({ keywords: ['machine', 'learning'] }, '"machine learning"').matched);
  assert.ok(!score({ title: 'machine models learning' }, '"machine learning"').matched);
  assert.equal(compileSearch('"machine learning" genetics').terms.length, 2);
});

test('literal technical terms, boundaries, unicode and operator characters', () => {
  for (const term of ['C++', 'IL-6', 'p53', '.*', '(a+)+$', 'β-catenin']) {
    assert.ok(score({ title: `Study of ${term} today` }, term).matched, term);
  }
  assert.ok(!score({ title: 'Catalysis' }, 'cat').matched);
  assert.ok(!score({ title: 'αcatβ' }, 'cat').matched);
  assert.ok(!score({ title: 'CCCC' }, 'C++').matched);
  assert.ok(!score({ title: 'arbitrary' }, '.*').matched);
  assert.equal(textFilter(compileSearch('"a b" c', 'any'), 'publications').$or.length, 2);
});

test('repeated input or keyword stuffing does not increase field scores', () => {
  assert.equal(score({ title: 'quantum quantum quantum' }, 'quantum quantum').score, 10);
  assert.equal(score({ keywords: ['quantum', 'quantum'] }, 'quantum').score, 6);
  assert.equal(score({ title: 'Quantum', abstract: 'quantum', keywords: ['quantum'] }, 'quantum').score, 18);
});

test('exact names/titles and strong phrases have explicit priority tiers', () => {
  assert.equal(score({ title: 'Machine Learning' }, 'machine learning').tier, 2);
  assert.equal(score({ title: 'Applied machine learning' }, 'machine learning').tier, 1);
  assert.equal(score({ title: 'Machine models', abstract: 'learning' }, 'machine learning').tier, 0);
  assert.equal(score({ name: 'Jane Doe' }, 'jane doe', 'all', 'researchers').exactMatch, 'name');
});

test('DOI, ORCID and OpenAlex searches use exact normalized identifiers, not title mentions', () => {
  for (const q of ['10.1234/ABC', 'https://doi.org/10.1234/ABC', 'doi: 10.1234/ABC']) {
    assert.equal(score({ externalIds: { doi: '10.1234/abc' } }, q).tier, 3);
    assert.ok(!score({ title: q }, q).matched);
    assert.ok(!score({ externalIds: { doi: '10.1234/abc-extra' } }, q).matched);
  }
  assert.equal(score({ externalIds: { orcid: 'https://orcid.org/0000-0002-1825-0097' } }, '0000-0002-1825-0097', 'all', 'researchers').tier, 3);
  assert.equal(score({ externalIds: { openAlex: 'https://openalex.org/W123' } }, 'W123').tier, 3);
  assert.ok(!score({ externalIds: { openAlex: 'A123' } }, 'A123').matched);
  assert.equal(score({ externalIds: { doi: '10.1234/test:one' } }, 'https://doi.org/10.1234/test%3Aone').tier, 3);
});

test('author and venue matches never become topic evidence for another researcher', () => {
  const paper = { title: 'Unrelated subject', authors: [{ name: 'Machine Learning' }], venue: { name: 'Machine Learning Journal' } };
  assert.ok(score(paper, 'machine learning').matched);
  assert.ok(!score(paper, 'machine learning', 'all', 'publications', true).matched);
  const filter = JSON.stringify(textFilter(compileSearch('machine'), 'publications', true));
  assert.ok(!filter.includes('authors.name')); assert.ok(!filter.includes('venue.name'));
});

test('conservative arXiv grouping preserves source versions, author order, and stored documents', () => {
  const base = { _id: 'one', title: 'Same paper', year: 2026, type: 'preprint', authors: [{ name: 'A' }, { name: 'B' }],
    externalIds: { doi: '10.48550/arxiv.2603.05839' } };
  const other = { ...base, _id: 'two', externalIds: {}, sourceUrl: 'https://arxiv.org/abs/2603.05839v2' };
  const before = JSON.stringify([base, other]);
  const groups = groupPublications([other, base]);
  assert.equal(groups.length, 1); assert.equal(groups[0].record._id, 'one');
  assert.equal(JSON.stringify([base, other]), before);
  assert.notEqual(publicationIdentity(base), publicationIdentity({ ...other, authors: [...other.authors].reverse() }));
  assert.notEqual(publicationIdentity(base), publicationIdentity({ ...other, externalIds: { doi: '10.1234/journal' }, type: 'journal-article' }));
  assert.notEqual(publicationIdentity(base), publicationIdentity({ ...other, year: 2025 }));
});

test('same titles or shared URL bases/fragments do not imply duplicate works', () => {
  const a = { _id: 'one', title: 'Example', sourceUrl: 'https://dblp.org/example#First' };
  const b = { _id: 'two', title: 'Example', sourceUrl: 'https://dblp.org/example#Second' };
  assert.equal(groupPublications([a, b]).length, 2);
});

test('links prefer DOI and preserve HTTP source fragments; unsafe links are not exposed as publicationUrl', () => {
  assert.equal(publicationUrl({ externalIds: { doi: '10.1234/ABC' } }), 'https://doi.org/10.1234/abc');
  assert.equal(publicationUrl({ sourceUrl: 'https://dblp.org/example#Paper' }), 'https://dblp.org/example#Paper');
  assert.equal(publicationUrl({ sourceUrl: 'javascript:alert(1)' }), null);
  assert.equal(publicationUrl({}), null);
});
