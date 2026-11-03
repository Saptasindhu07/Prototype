export const FIELD_WEIGHTS = {
  researchers: { name: 12, researchInterests: 8, biography: 2,
    'affiliations.department': 1, 'affiliations.institution': 1 },
  publications: { title: 10, keywords: 6, 'authors.name': 4, abstract: 2, 'venue.name': 1 },
};
export const TOPIC_FIELDS = ['title', 'keywords', 'abstract'];
export const invalid = (message) => Object.assign(new Error(message), { status: 400, publicMessage: message });
const normalize = (value) => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : '';
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pattern(term) {
  return `(?<![\\p{L}\\p{N}_])${term.split(' ').map(escapeRegex).join('\\s+')}(?![\\p{L}\\p{N}_])`;
}

export function normalizeDoi(value) {
  let doi = normalize(value).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(normalize(value))) {
    try { doi = decodeURIComponent(doi); } catch {}
  }
  return doi.toLowerCase();
}

function identifier(q) {
  const doi = normalizeDoi(q);
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return { field: 'doi', value: doi, kind: 'publications' };
  const orcid = q.match(/^(?:https?:\/\/orcid\.org\/|orcid:\s*)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i);
  if (orcid) return { field: 'orcid', value: orcid[1].toLowerCase(), kind: 'researchers' };
  const openAlex = q.match(/^(?:https?:\/\/openalex\.org\/)?([AW]\d+)$/i);
  if (openAlex) return { field: 'openAlex', value: openAlex[1].toLowerCase(),
    kind: openAlex[1][0].toUpperCase() === 'A' ? 'researchers' : 'publications' };
  return null;
}

export function compileSearch(q = '', match = 'all') {
  if (typeof q !== 'string' || q.length > 160) throw invalid('q must be text of at most 160 characters.');
  if (!['all', 'any'].includes(match)) throw invalid('match must be all or any.');
  q = q.trim().replace(/\s+/gu, ' ');
  const id = identifier(q);
  if (id) return { q, match, identifier: id, terms: [], plain: q };
  const terms = [];
  let rest = q;
  while (rest) {
    const token = rest.match(/^(?:"([^"]+)"|([^\s"]+))(?:\s+|$)/u);
    if (!token) throw invalid('Use balanced, non-empty double quotes separated by spaces.');
    const value = normalize(token[1] ?? token[2]);
    if (!value) throw invalid('A quoted phrase cannot be empty.');
    if (!terms.some((term) => term.value === value)) terms.push({ value, pattern: pattern(value), regex: new RegExp(pattern(value), 'iu') });
    rest = rest.slice(token[0].length);
  }
  if (terms.length > 8) throw invalid('Use at most 8 distinct words or quoted phrases.');
  const plain = normalize(q.replaceAll('"', ''));
  return { q, match, identifier: null, terms, plain, phrase: new RegExp(pattern(plain), 'iu') };
}

function identifierPattern(id) {
  const prefix = { doi: '(?:https?://(?:dx\\.)?doi\\.org/|doi:\\s*)?',
    orcid: '(?:https?://orcid\\.org/|orcid:\\s*)?', openAlex: '(?:https?://openalex\\.org/)?' }[id.field];
  return `^${prefix}${escapeRegex(id.value)}$`;
}

export function textFilter(search, kind, topicOnly = false) {
  if (!search.q) return {};
  if (search.identifier) {
    return search.identifier.kind === kind
      ? { [`externalIds.${search.identifier.field}`]: { $regex: identifierPattern(search.identifier), $options: 'i' } }
      : { _id: { $in: [] } };
  }
  const fields = topicOnly ? TOPIC_FIELDS : Object.keys(FIELD_WEIGHTS[kind]);
  return { [search.match === 'all' ? '$and' : '$or']: search.terms.map((term) => ({
    $or: fields.map((field) => ({ [field]: { $regex: term.pattern, $options: 'i' } })),
  })) };
}

function valuesAt(record, path) {
  return path.split('.').reduce((values, key) => values.flatMap((value) => {
    const next = value?.[key];
    return Array.isArray(next) ? next : next == null ? [] : [next];
  }), [record]).filter((value) => typeof value === 'string');
}

export function scoreRecord(record, search, kind, topicOnly = false) {
  const result = { matched: !search.q, tier: 0, score: 0, matchedFields: [], matchedTerms: [], exactMatch: null };
  if (!search.q) return result;
  if (search.identifier) {
    const id = search.identifier;
    result.matched = id.kind === kind && new RegExp(identifierPattern(id), 'i').test(record.externalIds?.[id.field] ?? '');
    if (result.matched) Object.assign(result, { tier: 3, score: 100,
      matchedFields: [`externalIds.${id.field}`], matchedTerms: [id.value], exactMatch: 'identifier' });
    return result;
  }
  const fields = topicOnly ? TOPIC_FIELDS : Object.keys(FIELD_WEIGHTS[kind]);
  const matchedTerms = new Set();
  for (const field of fields) {
    const values = valuesAt(record, field);
    let fieldMatched = false;
    for (const term of search.terms) {
      if (!values.some((value) => term.regex.test(value))) continue;
      matchedTerms.add(term.value);
      fieldMatched = true;
      result.score += FIELD_WEIGHTS[kind][field];
    }
    if (fieldMatched) result.matchedFields.push(field);
  }
  result.matchedTerms = [...matchedTerms];
  result.matched = search.match === 'all' ? matchedTerms.size === search.terms.length : matchedTerms.size > 0;
  if (!result.matched) return { ...result, score: 0, matchedFields: [], matchedTerms: [] };
  const primary = kind === 'researchers' ? 'name' : 'title';
  if (normalize(record[primary]) === search.plain) {
    result.tier = 2;
    result.exactMatch = primary;
  } else if (search.plain.includes(' ') && [primary, kind === 'researchers' ? 'researchInterests' : 'keywords']
    .some((field) => valuesAt(record, field).some((value) => search.phrase.test(value)))) {
    result.tier = 1;
  }
  return result;
}

function arxivId(record) {
  const doi = normalizeDoi(record.externalIds?.doi);
  if (doi.startsWith('10.48550/arxiv.')) return doi.slice('10.48550/arxiv.'.length).replace(/v\d+$/, '');
  if (doi) return null;
  try {
    const url = new URL(record.sourceUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) return null;
    return url.pathname.match(/^\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?\/?$/i)?.[1].toLowerCase() ?? null;
  } catch { return null; }
}

export function publicationIdentity(record) {
  const arxiv = arxivId(record);
  if (arxiv && record.title && record.authors?.length && Number.isInteger(record.year) && record.type) {
    return `arxiv:${arxiv}:${JSON.stringify([normalize(record.title), record.year, record.type, record.authors.map((a) => normalize(a.name))])}`;
  }
  const doi = normalizeDoi(record.externalIds?.doi);
  if (doi) return `doi:${doi}`;
  return `record:${record._id}`;
}

export function groupPublications(records) {
  const groups = new Map();
  for (const record of records) {
    const key = publicationIdentity(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map((members) => {
    members.sort((a, b) => Number(Boolean(b.externalIds?.doi)) - Number(Boolean(a.externalIds?.doi))
      || String(a._id).localeCompare(String(b._id)));
    return { record: members[0], members };
  });
}

export function publicationUrl(record) {
  const doi = normalizeDoi(record.externalIds?.doi);
  if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const url = new URL(record.sourceUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
