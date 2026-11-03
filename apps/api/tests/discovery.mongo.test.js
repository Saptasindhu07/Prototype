import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import mongoose from 'mongoose';
import { Researcher, Publication } from '../src/models/index.js';
import { discover, discoverySummary, parseDiscoveryQuery } from '../src/services/discovery.service.js';
import { compileSearch, scoreRecord } from '@research-atlas/search';

test('discovery against a real MongoDB in an isolated disposable database', async (t) => {
  const dbName = `discovery_test_${randomUUID().replaceAll('-', '')}`;
  const connection = await mongoose.createConnection('mongodb://127.0.0.1:27017', {
    dbName, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 3000,
  }).asPromise();
  t.after(async () => {
    try {
      assert.match(dbName, /^discovery_test_[a-f0-9]{32}$/);
      assert.equal(connection.db.databaseName, dbName);
      await connection.dropDatabase();
    } finally { await connection.close(); }
  });
  const models = {
    Researcher: connection.model('Researcher', Researcher.schema.clone()),
    Publication: connection.model('Publication', Publication.schema.clone()),
  };
  const affiliation = (department, isCurrent = true) => ({ institution: 'Test University', department, isCurrent });
  const names = ['Alice', 'Bob', 'Carol', 'Dana', 'No papers', 'Quantum learning', 'Prolific'];
  const people = names.map((name, i) => ({ _id: new mongoose.Types.ObjectId(), name, createdAt: new Date(`${2010 + i}-01-01`),
    affiliations: [affiliation(i === 0 || i === 5 ? 'Physics' : 'Computing')] }));
  people[0].externalIds = { orcid: '0000-0002-1825-0097' };
  people[2].affiliations = [affiliation('Physics', false), affiliation('Chemistry')];
  people[3].affiliations = [affiliation('Physics', false), affiliation('Computing')];
  await models.Researcher.insertMany(people);
  const author = (i) => ({ name: names[i], researcherId: people[i]._id });
  const paper = (title, person, extra = {}) => ({ _id: new mongoose.Types.ObjectId(), title,
    authors: [author(person)], year: 2024, type: 'journal-article', ...extra });
  const papers = [
    paper('Quantum learning', 1, { year: 2020, externalIds: { doi: '10.1234/exact' } }),
    paper('Applied quantum learning', 0),
    paper('Quantum models', 0, { abstract: 'A learning experiment', year: 2025 }),
    paper('Marine field work', 0, { authors: [author(0), { name: 'Quantum Learning' }], venue: { name: 'Quantum learning journal' } }),
    paper('Quantum systems', 2),
    paper('Learning systems', 2),
    paper('Unrelated subject', 3),
    paper('Quantum learning undated', 1, { year: undefined }),
    paper('Duplication probe', 0, { type: 'preprint', year: 2026, externalIds: { doi: '10.48550/arxiv.2603.05839' } }),
    paper('Duplication probe', 0, { type: 'preprint', year: 2026, sourceUrl: 'https://arxiv.org/abs/2603.05839' }),
    ...Array.from({ length: 4 }, (_, i) => paper(`Applied quantum learning experiment ${i}`, 6)),
    paper('Study of C++ and IL-6', 0, { authors: [author(0), author(0)] }),
    paper('Study of catalysis', 0),
    paper('Study of cat populations', 0),
    paper('Literal .* expression', 0),
    paper('Machine \n learning and β-catenin', 0),
  ];
  await models.Publication.insertMany(papers);
  const before = JSON.stringify(await models.Publication.find().sort({ _id: 1 }).lean());
  const search = (query = {}) => discover(parseDiscoveryQuery({ limit: '24', ...query }), models);

  await t.test('all vs any, phrase boundaries, literal symbols and Mongo/JS predicate agreement', async () => {
    const stored = await models.Publication.find().lean();
    for (const [q, match] of [['quantum learning', 'all'], ['quantum learning', 'any'], ['"quantum learning"', 'all'],
      ['C++', 'all'], ['IL-6', 'all'], ['cat', 'all'], ['.*', 'all'], ['"machine learning"', 'all'], ['β-catenin', 'all']]) {
      const result = await search({ kind: 'publications', q, match });
      const expected = stored.filter((record) => scoreRecord(record, compileSearch(q, match), 'publications').matched).map((p) => String(p._id)).sort();
      assert.deepEqual(result.data.map((p) => String(p._id)).sort(), expected, `${q}/${match}`);
    }
  });

  await t.test('exact identifier, title and phrase relevance rank before lower-weight fields', async () => {
    const result = await search({ kind: 'publications', q: 'quantum learning' });
    assert.equal(String(result.data[0]._id), String(papers[0]._id));
    assert.equal(result.data[0].searchMatch.exactMatch, 'title');
    const doi = await search({ kind: 'publications', q: 'https://doi.org/10.1234/EXACT' });
    assert.equal(doi.total, 1); assert.equal(doi.data[0].searchMatch.exactMatch, 'identifier');
    assert.equal(doi.data[0].publicationUrl, 'https://doi.org/10.1234/exact');
    const orcid = await search({ q: 'https://orcid.org/0000-0002-1825-0097' });
    assert.equal(orcid.total, 1); assert.equal(orcid.data[0].name, 'Alice');
    assert.equal((await search({ q: '0000-0002-1825-0097', year: '2024' })).total, 1);
    assert.equal((await search({ q: '0000-0002-1825-0097', year: '1995' })).total, 0);
  });

  await t.test('researcher union includes profile and topic evidence, never combines separate papers or author names', async () => {
    const result = await search({ q: 'quantum learning' });
    assert.deepEqual(result.data.map((p) => p.name).sort(), ['Alice', 'Bob', 'Prolific', 'Quantum learning'].sort());
    assert.equal(result.data[0].name, 'Quantum learning');
    const alice = result.data.find((p) => p.name === 'Alice');
    assert.equal(alice.matchedPublicationCount, 2);
    assert.ok(alice.matchingPublications.every((p) => !p.searchMatch.matchedFields.includes('authors.name')));
    const prolific = result.data.find((p) => p.name === 'Prolific');
    assert.equal(prolific.matchedPublicationCount, 4);
    assert.equal(prolific.matchingPublications.length, 3);
    assert.equal(prolific.searchMatch.score, 30); // At most three papers, at most ten points each.
    const byDoi = await search({ q: '10.1234/exact' });
    assert.deepEqual(byDoi.data.map((p) => p.name), ['Bob']);
  });

  await t.test('current-department elemMatch and department/researcher intersection do not leak results', async () => {
    const result = await search({ department: 'Physics' });
    assert.deepEqual(result.data.map((p) => p.name), ['Alice', 'Quantum learning']);
    const mismatch = await search({ kind: 'publications', department: 'Physics', researcher: String(people[1]._id) });
    assert.equal(mismatch.total, 0);
    const filtered = await search({ kind: 'publications', department: 'Physics', q: 'quantum learning' });
    assert.ok(filtered.data.every((p) => p.authors.some((a) => String(a.researcherId) === String(people[0]._id))));
  });

  await t.test('year/type filters apply to publications and required researcher topic evidence', async () => {
    const pubs = await search({ kind: 'publications', q: 'quantum learning', yearFrom: '2020', yearTo: '2020', type: 'journal-article' });
    assert.equal(pubs.total, 1); assert.equal(pubs.data[0].year, 2020);
    const peopleInRange = await search({ q: 'quantum learning', year: '2020' });
    assert.deepEqual(peopleInRange.data.map((p) => p.name), ['Bob']);
    const nobody = await search({ q: 'quantum learning', year: '1995' });
    assert.equal(nobody.total, 0);
    const unqueried = await search({ year: '2020' });
    assert.deepEqual(unqueried.data.map((p) => p.name), ['Bob']);
  });

  await t.test('known duplicate representations collapse only in results/evidence, with unchanged stored IDs', async () => {
    const pubs = await search({ kind: 'publications', q: 'duplication probe' });
    assert.equal(pubs.search.matchedRecords, 2); assert.equal(pubs.total, 1);
    assert.equal(pubs.search.duplicatesCollapsed, 1);
    assert.equal(String(pubs.data[0]._id), String(papers[8]._id));
    assert.deepEqual(pubs.data[0].duplicateRecordIds.map(String), [String(papers[9]._id)]);
    const peopleResult = await search({ q: 'duplication probe' });
    assert.equal(peopleResult.data[0].matchedPublicationCount, 1);
    assert.equal(peopleResult.data[0].matchingPublications.length, 1);
  });

  await t.test('stable global ordering, missing years last, complete pagination and out-of-range pages', async () => {
    const full = await search({ kind: 'publications', sort: 'newest' });
    const ids = [];
    for (let page = 1; page <= Math.ceil(full.total / 3); page++) {
      const part = await search({ kind: 'publications', sort: 'newest', limit: '3', page: String(page) });
      assert.equal(part.total, full.total); ids.push(...part.data.map((p) => String(p._id)));
    }
    assert.deepEqual(ids, full.data.map((p) => String(p._id)));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(full.data.at(-1).year, undefined);
    assert.equal((await search({ kind: 'publications', sort: 'oldest' })).data.at(-1).year, undefined);
    const beyond = await search({ kind: 'publications', page: '99' });
    assert.equal(beyond.total, full.total); assert.deepEqual(beyond.data, []);
    assert.equal((await search({ sort: 'recent' })).data[0].name, 'Prolific');
    const ranked = await search({ kind: 'publications', q: 'quantum learning' });
    const second = await search({ kind: 'publications', q: 'quantum learning', page: '2', limit: '2' });
    assert.deepEqual(second.data.map((p) => String(p._id)), ranked.data.slice(2, 4).map((p) => String(p._id)));
  });

  await t.test('summary and lifetime counts remain record counts; repeated author IDs count once per paper', async () => {
    const summary = await discoverySummary(models);
    assert.equal(summary.publications, papers.length); assert.equal(summary.researchers, people.length);
    assert.equal(summary.departments.find((d) => d.name === 'Physics').count, 2);
    const result = await search({ researcher: String(people[0]._id) });
    assert.equal(result.data[0].publicationCount, papers.filter((p) => p.authors.some((a) => String(a.researcherId) === String(people[0]._id))).length);
    assert.equal(JSON.stringify(await models.Publication.find().sort({ _id: 1 }).lean()), before);
  });
});
