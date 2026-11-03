import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecommendations } from '../src/services/research-api.js';

test('AI query uses a cancellable POST and sends filters separately', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/recommendations');
    assert.equal(options.method, 'POST');
    assert.equal(options.signal, controller.signal);
    assert.deepEqual(JSON.parse(options.body), { query: 'brain MRI', filters: { department: 'Computing', yearFrom: '2020' } });
    return new Response(JSON.stringify({ data: { recommendations: [] } }), { status: 200 });
  });
  const result = await getRecommendations({ q: 'brain MRI', department: 'Computing', yearFrom: '2020' }, false, 0, controller.signal);
  assert.deepEqual(result.data.recommendations, []);
});

test('sample recommendations stay local and use explicitly fictional linked records', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('No network in sample mode'); });
  const result = await getRecommendations({ q: 'research' }, true, 0);
  assert.equal(result.meta.engine, 'sample-layout-only');
  assert.equal(result.data.recommendations.length, 3);
  for (const item of result.data.recommendations) {
    assert.ok(item.researcher._id.startsWith('sample-'));
    assert.ok(item.papers.every(p => p.authors.some(a => a.researcherId === item.researcher._id)));
  }
});

test('unavailable connection returns a safe message for the floating panel', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'AI recommendations are being prepared.' } }), { status: 503 }));
  await assert.rejects(getRecommendations({ q: 'MRI' }, false, 0), error => error.status === 503 && error.message.includes('being prepared'));
});
