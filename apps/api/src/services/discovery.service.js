import mongoose from 'mongoose';
import { Publication, Researcher } from '../models/index.js';
import { compileSearch, groupPublications, invalid, publicationUrl, scoreRecord, textFilter } from '@research-atlas/search';

const MODELS = { Publication, Researcher };
const QUERY_TIMEOUT_MS = 5000;
const MAX_CANDIDATES = 10000;
const RESEARCHER_FIELDS = 'name biography affiliations researchInterests profileUrl externalIds lastSyncedAt createdAt';
const PUBLICATION_FIELDS = 'title abstract authors year publicationDate type venue keywords sourceUrl externalIds createdAt';
const TYPES = ['journal-article', 'conference-paper', 'preprint', 'book-chapter', 'thesis', 'other'];
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function text(query, name, max = 160) {
  const value = query[name] ?? '';
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} must be text of at most ${max} characters.`);
  return value.trim();
}

function integer(query, name, fallback, min, max) {
  const value = text(query, name);
  if (!value) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw invalid(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function parseDiscoveryQuery(query) {
  const kind = text(query, 'kind') || 'researchers';
  if (!['researchers', 'publications'].includes(kind)) throw invalid('Invalid record kind.');
  const q = text(query, 'q').replace(/\s+/gu, ' ');
  const match = text(query, 'match') || 'all';
  compileSearch(q, match); // Validate quotes, identifiers and clause count before any database query.
  const sort = text(query, 'sort') || (q ? 'relevance' : kind === 'publications' ? 'newest' : 'name');
  const allowedSorts = kind === 'researchers' ? ['relevance', 'name', 'recent'] : ['relevance', 'newest', 'oldest', 'title'];
  if (!allowedSorts.includes(sort)) throw invalid('Invalid sort option.');
  const page = integer(query, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = integer(query, 'limit', 12, 1, 24);
  if (!Number.isSafeInteger(page * limit)) throw invalid('Pagination exceeds the safe integer range.');
  const department = text(query, 'department');
  const researcher = text(query, 'researcher');
  if (researcher && !mongoose.isObjectIdOrHexString(researcher)) throw invalid('Invalid researcher ID.');
  const year = integer(query, 'year', null, 1000, 9999);
  const yearFrom = integer(query, 'yearFrom', null, 1000, 9999);
  const yearTo = integer(query, 'yearTo', null, 1000, 9999);
  if (year !== null && (yearFrom !== null || yearTo !== null)) throw invalid('Use year OR yearFrom/yearTo, not both.');
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) throw invalid('yearFrom cannot exceed yearTo.');
  const type = text(query, 'type');
  if (type && !TYPES.includes(type)) throw invalid('Invalid publication type.');
  return { kind, sort, page, limit, q, match, department, researcher, year, yearFrom, yearTo, type };
}

export function buildTextFilter(q, kind, match = 'all') {
  return textFilter(compileSearch(q, match), kind);
}

function researcherFilter({ department, researcher }) {
  const filter = {};
  if (department) filter.affiliations = { $elemMatch: { department, isCurrent: { $ne: false } } };
  if (researcher) filter._id = new mongoose.Types.ObjectId(researcher);
  return filter;
}

function publicationFilter({ year, yearFrom, yearTo, type }) {
  const filter = {};
  if (year != null) filter.year = year;
  else if (yearFrom != null || yearTo != null) {
    filter.year = { ...(yearFrom != null ? { $gte: yearFrom } : {}), ...(yearTo != null ? { $lte: yearTo } : {}) };
  }
  if (type) filter.type = type;
  return filter;
}

async function readCandidates(Model, filter, fields) {
  const records = await Model.find(filter).select(fields).maxTimeMS(QUERY_TIMEOUT_MS).limit(MAX_CANDIDATES + 1).lean();
  if (records.length > MAX_CANDIDATES) {
    const message = 'Search is too broad; narrow the query or filters.';
    throw Object.assign(new Error(message), { status: 422, publicMessage: message });
  }
  return records;
}

function compareNullable(a, b, direction = 1) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return (a < b ? -1 : a > b ? 1 : 0) * direction;
}

function compareRows(a, b, sort, kind) {
  if (sort === 'relevance') {
    const relevance = b.match.tier - a.match.tier || b.match.score - a.match.score;
    if (relevance) return relevance;
    sort = kind === 'researchers' ? 'name' : 'newest';
  }
  const left = a.record; const right = b.record;
  let order = 0;
  if (sort === 'name' || sort === 'title') order = collator.compare(left[sort] || '', right[sort] || '');
  else if (sort === 'recent') order = compareNullable(left.createdAt?.getTime(), right.createdAt?.getTime(), -1);
  else {
    const direction = sort === 'oldest' ? 1 : -1;
    order = compareNullable(left.year, right.year, direction)
      || compareNullable(left.publicationDate?.getTime(), right.publicationDate?.getTime(), direction);
  }
  return order || String(left._id).localeCompare(String(right._id));
}

function publicMatch(match) {
  const { score, matchedFields, matchedTerms, exactMatch } = match;
  return { score, matchedFields, matchedTerms, exactMatch };
}

function publicPaper(row) {
  const { abstract: _abstract, createdAt: _createdAt, ...record } = row.record;
  return { ...record, publicationUrl: publicationUrl(record), searchMatch: publicMatch(row.match),
    duplicateRecordIds: row.members.filter((member) => String(member._id) !== String(record._id)).map((member) => member._id) };
}

function publicationRows(records, search, topicOnly = false) {
  const matches = new Map(records.map((record) => [String(record._id), scoreRecord(record, search, 'publications', topicOnly)]));
  const rows = [];
  for (const group of groupPublications(records.filter((record) => matches.get(String(record._id)).matched))) {
    rows.push({ record: group.record, match: matches.get(String(group.record._id)), members: group.members });
  }
  return rows;
}

async function discoverPublications(options, search, models) {
  const filter = { ...publicationFilter(options), ...textFilter(search, 'publications') };
  if (options.department) {
    const people = await readCandidates(models.Researcher, researcherFilter(options), '_id');
    filter['authors.researcherId'] = { $in: people.map((person) => person._id) };
  } else if (options.researcher) filter['authors.researcherId'] = new mongoose.Types.ObjectId(options.researcher);
  const records = await readCandidates(models.Publication, filter, PUBLICATION_FIELDS);
  const rows = publicationRows(records, search);
  return { rows, matchedRecords: rows.reduce((sum, row) => sum + row.members.length, 0) };
}

async function discoverResearchers(options, search, models) {
  const researcherIdentifier = search.identifier?.kind === 'researchers';
  const people = await readCandidates(models.Researcher, {
    ...researcherFilter(options), ...(researcherIdentifier ? textFilter(search, 'researchers') : {}),
  }, RESEARCHER_FIELDS);
  const hasPaperFilters = options.year != null || options.yearFrom != null || options.yearTo != null || Boolean(options.type);
  const byResearcher = new Map();
  if (people.length && ((search.q && !researcherIdentifier) || hasPaperFilters)) {
    const paperSearch = researcherIdentifier ? compileSearch('') : search;
    const papers = await readCandidates(models.Publication, {
      ...publicationFilter(options), ...textFilter(paperSearch, 'publications', true),
      'authors.researcherId': { $in: people.map((person) => person._id) },
    }, PUBLICATION_FIELDS);
    for (const row of publicationRows(papers, paperSearch, true)) {
      const ids = new Set(row.members.flatMap((paper) => paper.authors.map((author) => author.researcherId && String(author.researcherId))).filter(Boolean));
      for (const id of ids) {
        if (!byResearcher.has(id)) byResearcher.set(id, []);
        byResearcher.get(id).push(row);
      }
    }
  }
  const rows = [];
  for (const record of people) {
    const direct = scoreRecord(record, search, 'researchers');
    const evidence = (byResearcher.get(String(record._id)) || []).sort((a, b) => compareRows(a, b, 'relevance', 'publications'));
    if (hasPaperFilters ? !evidence.length : !direct.matched && !evidence.length) continue;
    const best = evidence.slice(0, 3);
    const paperScore = search.q ? best.reduce((sum, paper) => sum + Math.min(paper.match.score, 20) * 0.5, 0) : 0;
    rows.push({ record, match: { ...direct, matched: true, score: direct.score + paperScore },
      matchedPublicationCount: evidence.length, matchingPublications: best.map(publicPaper) });
  }
  return { rows, matchedRecords: rows.length };
}

async function attachPublicationStats(records, models) {
  if (!records.length) return;
  const ids = records.map((record) => record._id);
  const publications = await models.Publication.aggregate([
    { $match: { 'authors.researcherId': { $in: ids } } },
    { $project: { title: 1, year: 1, sourceUrl: 1, externalIds: 1, researcherIds: { $setUnion: ['$authors.researcherId', []] } } },
    { $unwind: '$researcherIds' },
    { $match: { researcherIds: { $in: ids } } },
    { $sort: { year: -1, _id: -1 } },
    { $group: { _id: '$researcherIds', count: { $sum: 1 }, latest: { $first: {
      _id: '$_id', title: '$title', year: '$year', sourceUrl: '$sourceUrl', externalIds: '$externalIds',
    } } } },
  ]).option({ maxTimeMS: QUERY_TIMEOUT_MS });
  const byResearcher = new Map(publications.map((record) => [String(record._id), record]));
  for (const record of records) {
    const stats = byResearcher.get(String(record._id));
    record.publicationCount = stats?.count || 0;
    record.latestPublication = stats?.latest ? { ...stats.latest, publicationUrl: publicationUrl(stats.latest) } : null;
  }
}

export async function discover(options, models = MODELS) {
  const search = compileSearch(options.q, options.match);
  try {
    const { rows, matchedRecords } = options.kind === 'publications'
      ? await discoverPublications(options, search, models) : await discoverResearchers(options, search, models);
    rows.sort((a, b) => compareRows(a, b, options.sort, options.kind));
    const total = rows.length;
    const selected = rows.slice((options.page - 1) * options.limit, options.page * options.limit);
    const data = options.kind === 'publications' ? selected.map(publicPaper) : selected.map((row) => {
      const { createdAt: _createdAt, ...record } = row.record;
      return { ...record, searchMatch: publicMatch(row.match), matchedPublicationCount: row.matchedPublicationCount,
        matchingPublications: row.matchingPublications };
    });
    if (options.kind === 'researchers') await attachPublicationStats(data, models);
    return { data, total, page: options.page, limit: options.limit, pages: Math.ceil(total / options.limit),
      search: { query: search.q, match: search.match, sort: options.sort, engine: 'literal-v1',
        matchedRecords, duplicatesCollapsed: matchedRecords - total } };
  } catch (error) {
    if (error.code === 50 || error.codeName === 'MaxTimeMSExpired') {
      const message = 'Search timed out; narrow the query or retry.';
      throw Object.assign(new Error(message), { status: 503, publicMessage: message });
    }
    throw error; // Express 5 forwards this rejection to the existing error middleware.
  }
}

export async function discoverySummary(models = MODELS) {
  const [researchers, publications, departments, years] = await Promise.all([
    models.Researcher.countDocuments().maxTimeMS(QUERY_TIMEOUT_MS),
    models.Publication.countDocuments().maxTimeMS(QUERY_TIMEOUT_MS),
    models.Researcher.aggregate([
      { $unwind: '$affiliations' },
      { $match: { 'affiliations.isCurrent': { $ne: false }, 'affiliations.department': { $type: 'string', $ne: '' } } },
      { $group: { _id: '$affiliations.department', researchers: { $addToSet: '$_id' } } },
      { $project: { _id: 0, name: '$_id', count: { $size: '$researchers' } } },
      { $sort: { name: 1 } },
    ]).option({ maxTimeMS: QUERY_TIMEOUT_MS }),
    models.Publication.distinct('year').maxTimeMS(QUERY_TIMEOUT_MS),
  ]);
  return { researchers, publications, departments, years: years.filter(Number.isInteger).sort((a, b) => b - a) };
}
