import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createRecommendationRouter } from '../src/routes/recommendation.routes.js';
import { parseRecommendationBody, rankResearchers, validateInferenceResult, recommendResearchers } from '../src/services/recommendation.service.js';
import { errorHandler } from '../src/middlewares/error.middleware.js';

const id = number => number.toString(16).padStart(24, '0');
const hit = (number, score, ids = [id(number)]) => ({ id: `publication:${id(number)}`, score, mongoIds: ids });
const inference = hits => ({ hits, modelVersion: '1234567890abcdef', corpusFingerprint: 'a'.repeat(64), eligiblePaperCount: hits.length, indexedPaperCount: 20 });

test('recommendation input is bounded and rejects unknown or unsafe filters', () => {
  for (const value of [null, [], {}, { query: '' }, { query: 'a'.repeat(161) }, { query: ['MRI'] },
    { query: 'MRI', filters: [] }, { query: 'MRI', filters: { $where: 'x' } },
    { query: 'MRI', filters: { year: true } }, { query: 'MRI', filters: { yearFrom: '2026', yearTo: '2020' } },
    { query: 'MRI', filters: { year: '2020', yearFrom: '2010' } }, { query: 'MRI', filters: { researcher: 'sample-id' } },
    { query: 'MRI', filters: { type: 'unknown' } }, { query: 'MRI', url: 'http://external.example' }]) {
    assert.throws(() => parseRecommendationBody(value), error => error.status === 400);
  }
  assert.deepEqual(parseRecommendationBody({ query: ' brain   MRI ', filters: { yearFrom: '2020', department: '' } }), { query: 'brain MRI', filters: { yearFrom: 2020 } });
});

test('upstream inference must have coherent finite scores and unique publication mapping', () => {
  assert.equal(validateInferenceResult(inference([hit(1, .7)])).hits.length, 1);
  for (const value of [inference([hit(1, NaN)]), inference([hit(1, 1.1)]), inference([hit(1, .7), hit(1, .6)]),
    inference([hit(1, .7), hit(2, .6, [id(1)])]), { ...inference([]), modelVersion: 'untrusted' }]) {
    assert.throws(() => validateInferenceResult(value), error => error.status === 503);
  }
});

test('ranking uses verified author IDs, deduplicates evidence and respects live filters', () => {
  const people = [1, 2, 3].map(n => ({ _id: id(100 + n), name: `Person ${n}`, affiliations: [{ department: n === 3 ? 'Physics' : 'Computing', isCurrent: true }] }));
  const papers = [
    { _id: id(1), title: 'MRI paper', year: 2025, type: 'journal-article', authors: [{ researcherId: id(101) }, { name: 'Person 2', researcherId: null }] },
    { _id: id(2), title: 'Other copy', year: 2025, type: 'journal-article', authors: [{ researcherId: id(101) }, { researcherId: id(103) }] },
    { _id: id(3), title: 'Older work', year: 2010, type: 'journal-article', authors: [{ researcherId: id(102) }] },
  ];
  const result = rankResearchers([hit(1, .8, [id(1), id(2)]), hit(3, .9)], papers, people, { department: 'Computing', yearFrom: 2020 });
  assert.equal(result.length, 1);
  assert.equal(result[0].researcher._id, id(101));
  assert.equal(result[0].papers.length, 1);
  assert.equal(result[0].rankingScore, .8);
});

test('adding low-scoring publications does not create an unlimited volume bonus', () => {
  const people = [{ _id: id(101), name: 'A' }, { _id: id(102), name: 'B' }];
  const papers = Array.from({ length: 12 }, (_, i) => ({ _id: id(i + 1), title: `P${i}`, authors: [{ researcherId: id(i === 0 ? 101 : 102) }] }));
  const results = rankResearchers(papers.map((_, i) => hit(i + 1, i === 0 ? .9 : .6)), papers, people);
  assert.equal(results[0].researcher._id, id(101));
  assert.equal(results[1].papers.length, 3);
  assert.ok(Math.abs(results[1].rankingScore - .6) < 1e-10);
});

test('inference failures are sanitized before database access', async () => {
  await assert.rejects(recommendResearchers({ query: 'MRI', filters: {} }, {
    inferenceUrl: 'http://127.0.0.1:8100', fetchImpl: async () => { throw new Error('secret implementation detail'); },
    models: { Publication: { find() { throw Error('Must not query'); } } },
  }), error => error.status === 503 && !error.message.includes('secret'));
});

test('adapter hydrates model hits through read-only verified Mongo links', async () => {
  const reads = [];
  const source = (kind, records) => ({ find(filter) {
    reads.push({ kind, filter });
    return { select() { return this; }, maxTimeMS() { return this; }, async lean() { return records; } };
  } });
  const options = { query: 'MRI', filters: { department: 'Computing', yearFrom: 2020 } };
  const result = await recommendResearchers(options, {
    inferenceUrl: 'http://127.0.0.1:8100',
    fetchImpl: async (url, request) => {
      assert.equal(String(url), 'http://127.0.0.1:8100/search');
      assert.deepEqual(JSON.parse(request.body), { ...options, limit: 100 });
      return { ok: true, json: async () => inference([hit(1, .8)]) };
    },
    models: {
      Publication: source('papers', [{ _id: id(1), title: 'MRI segmentation', year: 2025, authors: [{ researcherId: id(101) }] }]),
      Researcher: source('people', [{ _id: id(101), name: 'Researcher A', affiliations: [{ department: 'Computing', isCurrent: true }] }]),
    },
  });
  assert.deepEqual(reads, [{ kind: 'papers', filter: { _id: { $in: [id(1)] } } }, { kind: 'people', filter: { _id: { $in: [id(101)] } } }]);
  assert.equal(result.data.recommendations[0].papers[0].title, 'MRI segmentation');
  assert.equal(result.meta.supervisionAvailabilityVerified, false);
});

test('HTTP recommendation route is disabled by default, opt-in when ready, and validates requests', async t => {
  let calls = 0;
  const app = express(); app.use(express.json());
  app.use('/off', createRecommendationRouter({ recommend: async () => { calls++; return {}; } }));
  app.use('/on', createRecommendationRouter({ enabled: true, recommend: async options => { calls++; return { data: { query: options.query, recommendations: [] } }; } }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send('/off', { query: 'MRI' })).status, 503);
  assert.equal(calls, 0);
  assert.equal((await send('/on', { query: '' })).status, 400);
  assert.equal(calls, 0);
  const response = await send('/on', { query: ' MRI ' });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.query, 'MRI');
  assert.equal(calls, 1);
  assert.deepEqual((await (await fetch(base + '/off/status')).json()).data, { enabled: false, state: 'not-connected' });
});
