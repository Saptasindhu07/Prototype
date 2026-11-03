import { Publication, Researcher } from '../models/index.js';
import { invalid, publicationUrl } from '@research-atlas/search';

const idPattern = /^[a-f0-9]{24}$/i;
const types = new Set(['journal-article', 'conference-paper', 'preprint', 'book-chapter', 'thesis', 'other']);
const filterNames = new Set(['department', 'researcher', 'year', 'yearFrom', 'yearTo', 'type']);
export const unavailable = (message = 'AI recommendations are temporarily unavailable. Your search results are still available.') => Object.assign(new Error(message), { status: 503, publicMessage: message });

export function parseRecommendationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['query', 'filters'].includes(key))) throw invalid('Use a query and optional filters.');
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 160) throw invalid('Enter a research topic of 1–160 characters.');
  const supplied = body.filters ?? {};
  if (typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(key => !filterNames.has(key))) throw invalid('Invalid recommendation filters.');
  const filters = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (value === '' || value == null) continue;
    if (['year', 'yearFrom', 'yearTo'].includes(key)) {
      if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{4}$/.test(String(value)) || Number(value) < 1000 || Number(value) > 9999) throw invalid(`${key} must be a four-digit year.`);
      filters[key] = Number(value);
    } else {
      if (typeof value !== 'string' || value.length > 160 || !value.trim()) throw invalid(`Invalid ${key}.`);
      filters[key] = value.trim();
    }
  }
  if (filters.researcher && !idPattern.test(filters.researcher)) throw invalid('Invalid researcher ID.');
  if (filters.researcher) filters.researcher = filters.researcher.toLowerCase();
  if (filters.type && !types.has(filters.type)) throw invalid('Invalid publication type.');
  if (filters.year && (filters.yearFrom || filters.yearTo)) throw invalid('Use year OR yearFrom/yearTo.');
  if (filters.yearFrom && filters.yearTo && filters.yearFrom > filters.yearTo) throw invalid('yearFrom cannot exceed yearTo.');
  return { query: body.query.trim().replace(/\s+/gu, ' '), filters };
}

export function validateInferenceResult(result) {
  if (!result || !Array.isArray(result.hits) || result.hits.length > 100
    || typeof result.modelVersion !== 'string' || !/^[a-f0-9]{16}$/.test(result.modelVersion)
    || typeof result.corpusFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.corpusFingerprint)
    || !Number.isSafeInteger(result.eligiblePaperCount) || result.eligiblePaperCount < result.hits.length
    || !Number.isSafeInteger(result.indexedPaperCount) || result.indexedPaperCount < result.eligiblePaperCount) throw unavailable();
  const seenIds = new Set(); const seenMongoIds = new Set();
  for (const hit of result.hits) {
    if (typeof hit.id !== 'string' || !/^publication:[a-f0-9]{24}$/i.test(hit.id) || seenIds.has(hit.id)
      || typeof hit.score !== 'number' || !Number.isFinite(hit.score) || hit.score < -1 || hit.score > 1
      || !Array.isArray(hit.mongoIds) || !hit.mongoIds.length || hit.mongoIds.length > 20) throw unavailable();
    seenIds.add(hit.id);
    for (const id of hit.mongoIds) {
      if (typeof id !== 'string' || !idPattern.test(id) || seenMongoIds.has(id.toLowerCase())) throw unavailable();
      seenMongoIds.add(id.toLowerCase());
    }
  }
  if (seenMongoIds.size > 1000) throw unavailable();
  return result;
}

function matchesPaper(paper, filters) {
  if (filters.year && paper.year !== filters.year) return false;
  if (filters.yearFrom && (paper.year == null || paper.year < filters.yearFrom)) return false;
  if (filters.yearTo && (paper.year == null || paper.year > filters.yearTo)) return false;
  return !filters.type || paper.type === filters.type;
}

export function rankResearchers(hits, publications, researchers, filters = {}) {
  const papersById = new Map(publications.map(paper => [String(paper._id), paper]));
  const people = new Map(researchers.filter(person => (!filters.researcher || String(person._id) === filters.researcher)
    && (!filters.department || person.affiliations?.some(a => a.department === filters.department && a.isCurrent !== false)))
    .map(person => [String(person._id), person]));
  const evidence = new Map();
  for (const hit of hits) {
    const records = hit.mongoIds.map(id => papersById.get(id)).filter(paper => paper && matchesPaper(paper, filters));
    if (!records.length) continue;
    const paper = records[0];
    const authorIds = new Set(records.flatMap(record => (record.authors || []).map(author => String(author.researcherId || '')).filter(id => people.has(id))));
    for (const researcherId of authorIds) {
      if (!evidence.has(researcherId)) evidence.set(researcherId, new Map());
      evidence.get(researcherId).set(hit.id, {
        _id: String(paper._id), title: paper.title, year: paper.year ?? null, type: paper.type,
        abstract: paper.abstract || '', keywords: paper.keywords || [], authors: paper.authors || [],
        venue: paper.venue, publicationUrl: publicationUrl(paper), externalIds: paper.externalIds,
        similarity: hit.score,
      });
    }
  }
  const ranked = [];
  for (const [id, items] of evidence) {
    const papers = [...items.values()].sort((a, b) => b.similarity - a.similarity || a._id.localeCompare(b._id)).slice(0, 3);
    const person = people.get(id);
    ranked.push({ researcher: { _id: id, name: person.name, affiliations: person.affiliations || [],
      researchInterests: person.researchInterests || [], profileUrl: person.profileUrl || null },
    rankingScore: papers.reduce((sum, paper) => sum + paper.similarity, 0) / papers.length,
    reason: `Related work includes “${papers[0].title}”.`, papers });
  }
  return ranked.sort((a, b) => b.rankingScore - a.rankingScore || a.researcher._id.localeCompare(b.researcher._id)).slice(0, 3);
}

export async function recommendResearchers(options, { inferenceUrl, fetchImpl = globalThis.fetch, models = { Publication, Researcher } }) {
  let inference;
  try {
    const response = await fetchImpl(new URL('/search', inferenceUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...options, limit: 100 }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw unavailable();
    inference = validateInferenceResult(await response.json());
  } catch { throw unavailable(); }
  const ids = inference.hits.flatMap(hit => hit.mongoIds);
  let recommendations = [];
  if (ids.length) {
    const publications = await models.Publication.find({ _id: { $in: ids } })
      .select('title abstract authors year type keywords venue sourceUrl externalIds').maxTimeMS(5000).lean();
    const authorIds = [...new Set(publications.flatMap(paper => (paper.authors || [])
      .map(author => String(author.researcherId || '')).filter(id => idPattern.test(id))))];
    const people = authorIds.length ? await models.Researcher.find({ _id: { $in: authorIds } })
      .select('name affiliations researchInterests profileUrl').maxTimeMS(5000).lean() : [];
    recommendations = rankResearchers(inference.hits, publications, people, options.filters);
  }
  return { data: { query: options.query, recommendations }, meta: {
    engine: 'bge-researcher-evidence-v1', modelVersion: inference.modelVersion,
    corpusFingerprint: inference.corpusFingerprint, indexedPaperCount: inference.indexedPaperCount,
    eligiblePaperCount: inference.eligiblePaperCount, candidatePaperCount: inference.hits.length,
    ranking: 'mean of up to three highest-scoring distinct retrieved publications',
    supervisionAvailabilityVerified: false,
  } };
}
