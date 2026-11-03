import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import discoveryRoutes from '../src/routes/discovery.routes.js';
import { errorHandler } from '../src/middlewares/error.middleware.js';
import { Publication, Researcher } from '../src/models/index.js';
import { buildTextFilter, parseDiscoveryQuery } from '../src/services/discovery.service.js';

function queryResult(records) {
  return { select() { return this; }, maxTimeMS(ms) { assert.equal(ms, 5000); return this; },
    limit(n) { assert.equal(n, 10001); return this; }, async lean() { return records; } };
}
function aggregateResult(records) {
  return { async option(options) { assert.equal(options.maxTimeMS, 5000); return records; } };
}

test('discovery rejects malformed filters and unbounded pagination', () => {
  for (const input of [
    { kind: 'users' }, { sort: '__proto__' }, { page: '0' }, { page: '1.5' }, { page: '1e2' }, { limit: '0x10' },
    { limit: '25' }, { limit: '-1' }, { page: String(Number.MAX_SAFE_INTEGER), limit: '24' },
    { q: { $ne: '' } }, { q: ['one', 'two'] }, { department: ['Physics', 'Geology'] },
    { q: 'a'.repeat(161) }, { researcher: 'not-an-id' }, { year: 'NaN' }, { year: '2020.5' }, { type: 'unknown' },
    { match: 'sometimes' }, { yearFrom: '2026', yearTo: '2000' }, { yearFrom: '999' },
    { year: '2020', yearTo: '2022' }, { yearTo: ['2020'] }, { q: '"open quote' }, { q: '""' },
    { q: '"a"b' }, { q: 'one two three four five six seven eight nine' },
  ]) assert.throws(() => parseDiscoveryQuery(input), (error) => error.status === 400, JSON.stringify(input));
});

test('query defaults, whitespace, match modes and legacy year remain compatible', () => {
  assert.equal(parseDiscoveryQuery({ kind: 'publications' }).sort, 'newest');
  assert.equal(parseDiscoveryQuery({}).sort, 'name');
  const options = parseDiscoveryQuery({ q: '  machine   learning \n', match: 'any' });
  assert.equal(options.q, 'machine learning');
  assert.equal(options.sort, 'relevance');
  assert.equal(options.match, 'any');
  assert.equal(parseDiscoveryQuery({ q: 'machine', sort: 'name' }).sort, 'name');
  assert.equal(parseDiscoveryQuery({ year: '2020' }).year, 2020);
  assert.equal(parseDiscoveryQuery({}).match, 'all');
});

test('search metacharacters stay literal; AND/OR are controlled by match, not user operators', () => {
  const filter = buildTextFilter('C++ .*', 'researchers');
  assert.equal(filter.$and.length, 2);
  const cpp = new RegExp(filter.$and[0].$or[0].name.$regex, 'iu');
  assert.ok(cpp.test('C++ programming')); assert.ok(!cpp.test('CCCC'));
  const literal = new RegExp(filter.$and[1].$or[0].name.$regex, 'iu');
  assert.ok(literal.test('literal .*')); assert.ok(!literal.test('everything'));
  assert.equal(buildTextFilter('one two', 'publications', 'any').$or.length, 2);
  assert.deepEqual(buildTextFilter('', 'researchers'), {});
});

test('read-only discovery HTTP endpoints', async (t) => {
  const app = express(); app.use('/api/discovery', discoveryRoutes); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/discovery`;
  const researcherId = new mongoose.Types.ObjectId();
  const paperId = new mongoose.Types.ObjectId();

  await t.test('invalid input is rejected before touching database, with safe actionable errors', async (t) => {
    t.mock.method(Researcher, 'find', () => { throw new Error('Should not run'); });
    for (const query of ['limit=99999', 'q=a&q=b', 'kind=users', 'researcher=bad-id']) {
      assert.equal((await fetch(`${url}?${query}`)).status, 400);
    }
    const response = await fetch(`${url}?match=invalid`);
    assert.match((await response.json()).error.message, /match must be all or any/);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
  });

  await t.test('researcher results rank the complete match set before pagination and attach page-only stats', async (t) => {
    let appliedFilter;
    const people = Array.from({ length: 7 }, (_, i) => ({ _id: i === 6 ? researcherId : new mongoose.Types.ObjectId(), name: `Person ${i}`, biography: 'quantum' }));
    t.mock.method(Researcher, 'find', (filter) => { appliedFilter = filter; return queryResult(people); });
    t.mock.method(Publication, 'find', () => queryResult([]));
    t.mock.method(Publication, 'aggregate', (pipeline) => {
      assert.deepEqual(pipeline[0].$match['authors.researcherId'].$in, [researcherId]);
      return aggregateResult([{ _id: researcherId, count: 3, latest: { _id: paperId, title: 'Example paper', year: 2025 } }]);
    });
    const response = await fetch(`${url}?q=quantum&department=Physics&page=2&limit=6`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 7); assert.equal(result.pages, 2); assert.equal(result.data.length, 1);
    assert.equal(result.data[0].publicationCount, 3);
    assert.equal(result.data[0].latestPublication._id, String(paperId));
    assert.equal(appliedFilter.affiliations.$elemMatch.department, 'Physics');
    assert.deepEqual(appliedFilter.affiliations.$elemMatch.isCurrent, { $ne: false });
  });

  await t.test('publication department and researcher constraints intersect before matching', async (t) => {
    t.mock.method(Researcher, 'find', (filter) => {
      assert.equal(String(filter._id), String(researcherId));
      assert.equal(filter.affiliations.$elemMatch.department, 'Biochemistry');
      return queryResult([{ _id: researcherId }]);
    });
    let appliedFilter;
    t.mock.method(Publication, 'find', (filter) => { appliedFilter = filter; return queryResult([]); });
    const response = await fetch(`${url}?kind=publications&q=genomics&department=Biochemistry&researcher=${researcherId}&year=2025&type=journal-article`);
    assert.equal(response.status, 200);
    assert.equal(appliedFilter.$and.length, 1);
    assert.equal(appliedFilter.year, 2025); assert.equal(appliedFilter.type, 'journal-article');
    assert.deepEqual(appliedFilter['authors.researcherId'].$in, [researcherId]);
    assert.deepEqual((await response.json()).data, []);
  });

  await t.test('too many candidates produce a clear error, never a truncated total', async (t) => {
    t.mock.method(Publication, 'find', () => queryResult(Array(10001).fill({})));
    const response = await fetch(`${url}?kind=publications`);
    assert.equal(response.status, 422);
    assert.match((await response.json()).error.message, /narrow/);
  });

  await t.test('MongoDB query timeout is mapped to a safe retryable response', async (t) => {
    t.mock.method(Researcher, 'find', () => { throw Object.assign(new Error('private-db-host'), { code: 50 }); });
    const response = await fetch(url);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /timed out/);
  });

  await t.test('unexpected database errors do not leak details', async (t) => {
    t.mock.method(Researcher, 'find', () => { throw new Error('private-db-host'); });
    const response = await fetch(url);
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('private-db-host'));
  });
});
