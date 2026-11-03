export function normaliseDoi(value) {
  if (typeof value !== 'string') return undefined;
  const doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

export function canonicalOpenAlexId(value, prefix) {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().replace(/^https?:\/\/openalex\.org\//i, '');
  return new RegExp(`^${prefix}[0-9]+$`).test(id) ? id : undefined;
}

export function reconstructAbstract(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return '';
  const words = new Map();
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) return '';
    for (const position of positions) {
      if (!Number.isSafeInteger(position) || position < 0 || position > 100000 || words.has(position)) return '';
      words.set(position, word);
    }
  }
  if (!words.size || Math.max(...words.keys()) !== words.size - 1) return '';
  return Array.from({ length: words.size }, (_, i) => words.get(i)).join(' ');
}

export function mapPublication(work, researcherMap = new Map()) {
  const source = work.primary_location?.source;
  let type;
  if (['article', 'review'].includes(work.type) && source?.type === 'journal') type = 'journal-article';
  else if (work.type === 'article' && source?.type === 'conference') type = 'conference-paper';
  else if (work.type === 'proceedings-article') type = 'conference-paper';
  else if (work.type === 'preprint') type = 'preprint';
  else if (work.type === 'book-chapter') type = 'book-chapter';
  else return null;
  const title = (work.title || work.display_name || '').trim();
  const openAlex = canonicalOpenAlexId(work.id, 'W');
  if (!title || !openAlex || work.is_retracted || work.is_authors_truncated || !work.authorships?.length
      || work.authors_count > work.authorships.length) return null;
  if (work.authorships.some(a => !a.author?.display_name?.trim())) return null;
  const externalIds = { openAlex };
  const doi = normaliseDoi(work.doi);
  if (doi) externalIds.doi = doi;
  const result = {
    title,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    externalIds,
    authors: work.authorships.map(a => ({
      name: a.author.display_name.trim(),
      researcherId: researcherMap.get(canonicalOpenAlexId(a.author.id, 'A')) || null,
    })),
    type,
    venue: {},
    keywords: [...new Set((work.keywords || []).map(k => k.display_name).filter(v => typeof v === 'string' && v.trim()))],
    sourceUrl: doi ? `https://doi.org/${doi}` : work.primary_location?.landing_page_url || `https://openalex.org/${openAlex}`,
    lastSyncedAt: new Date(),
  };
  if (Number.isInteger(work.publication_year) && work.publication_year >= 1000) result.year = work.publication_year;
  if (/^\d{4}-\d{2}-\d{2}$/.test(work.publication_date || '')) {
    const date = new Date(work.publication_date);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === work.publication_date) result.publicationDate = date;
  }
  if (source?.display_name) result.venue.name = source.display_name;
  if (/^https:\/\/openalex\.org\/P\d+$/.test(source?.host_organization || '') && source.host_organization_name) {
    result.venue.publisher = source.host_organization_name;
  }
  return result;
}
