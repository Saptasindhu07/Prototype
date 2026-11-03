import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../apps/api/src/config/database.js';
import { Publication, Researcher } from '../apps/api/src/models/index.js';
import { env } from '../apps/api/src/config/env.js';

const readyPath = process.argv[2];
if (!readyPath) throw Error('Pass the completed run ready-model.json path.');
const ready = JSON.parse(await fs.readFile(readyPath, 'utf8'));
const base = `http://${env.host}:${env.port}`;
const observations = [];
async function recommendations(query, filters = {}) {
  const start = performance.now();
  const response = await fetch(`${base}/api/recommendations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, filters }), signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.meta.modelVersion, ready.model_version);
  assert.equal(result.meta.indexedPaperCount, ready.papers_indexed);
  assert.equal(result.meta.supervisionAvailabilityVerified, false);
  assert.ok(result.data.recommendations.length <= 3);
  for (const item of result.data.recommendations) {
    const researcher = await Researcher.findById(item.researcher._id).lean();
    assert.ok(researcher);
    if (filters.department) assert.ok(researcher.affiliations.some(a => a.department === filters.department && a.isCurrent !== false));
    assert.ok(item.papers.length >= 1 && item.papers.length <= 3);
    for (const paper of item.papers) {
      const stored = await Publication.findById(paper._id).lean();
      assert.ok(stored);
      assert.ok(stored.authors.some(author => String(author.researcherId) === item.researcher._id));
      if (filters.yearFrom) assert.ok(stored.year >= filters.yearFrom);
      assert.ok(Number.isFinite(paper.similarity));
    }
  }
  observations.push({ query, filters, milliseconds: Math.round(performance.now() - start),
    researchers: result.data.recommendations.map(item => ({ id: item.researcher._id, name: item.researcher.name, paperIds: item.papers.map(p => p._id) })),
    eligiblePaperCount: result.meta.eligiblePaperCount });
  return result;
}

try {
  await connectDatabase();
  assert.equal((await (await fetch(`${base}/api/recommendations/status`)).json()).data.enabled, true);
  const initial = await recommendations('software testing');
  assert.ok(initial.data.recommendations.length > 0, 'Expected verified researcher evidence for software testing');
  const filtered = await recommendations('protein structure', { department: 'Biochemistry', yearFrom: 2020 });
  assert.ok(filtered.data.recommendations.length > 0, 'Expected current biochemistry evidence');
  assert.equal((await recommendations('research', { yearFrom: 9999 })).data.recommendations.length, 0);
  const invalid = await fetch(`${base}/api/recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '' }) });
  assert.equal(invalid.status, 400);
  const manual = await fetch(`${base}/api/discovery?kind=publications&q=software&limit=6`);
  assert.equal(manual.status, 200);
  const report = { status: 'connected', checkedAt: new Date().toISOString(), api: base,
    modelVersion: ready.model_version, observations,
    checks: ['real-model-response', 'verified-mongo-author-links', 'live-department-year-filters', 'empty-results', 'invalid-input', 'ordinary-search'] };
  await fs.writeFile(path.join(path.dirname(readyPath), 'live-connection.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await disconnectDatabase();
}
