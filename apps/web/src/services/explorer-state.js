const TYPES = ['journal-article', 'conference-paper', 'preprint', 'book-chapter', 'thesis', 'other'];
const cleanQuery = (q) => q.trim().replace(/\s+/gu, ' ');
const yearValue = (value) => /^[1-9]\d{3}$/.test(value || '') ? value : '';
export const defaultSort = (kind, q) => q ? 'relevance' : kind === 'publications' ? 'newest' : 'name';

export function readExplorerLocation(search) {
  const p = new URLSearchParams(search);
  const section = ['explore', 'researchers', 'publications', 'departments', 'saved'].includes(p.get('section')) ? p.get('section') : 'explore';
  const kind = section === 'publications' ? 'publications' : section === 'researchers' ? 'researchers' : p.get('kind') === 'publications' ? 'publications' : 'researchers';
  const sorts = kind === 'researchers' ? ['relevance', 'name', 'recent'] : ['relevance', 'newest', 'oldest', 'title'];
  const q = cleanQuery((p.get('q') || '').slice(0, 160));
  const year = yearValue(p.get('year'));
  const page = Number(p.get('page'));
  return {
    section, kind, q, department: (p.get('department') || '').slice(0, 160),
    match: p.get('match') === 'any' ? 'any' : 'all',
    researcher: /^[a-f0-9]{24}$/i.test(p.get('researcher') || '') ? p.get('researcher') : '',
    year, yearFrom: year ? '' : yearValue(p.get('yearFrom')), yearTo: year ? '' : yearValue(p.get('yearTo')),
    type: TYPES.includes(p.get('type')) ? p.get('type') : '',
    sort: sorts.includes(p.get('sort')) ? p.get('sort') : defaultSort(kind, q),
    page: Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(page * 24) ? page : 1,
    demo: p.get('demo') === '1',
  };
}

export function nextExplorerLocation(location, patch) {
  const next = { ...location, page: 1, ...patch };
  if ('q' in patch) next.q = cleanQuery(next.q);
  if (!('sort' in patch) && (next.q !== location.q || next.kind !== location.kind)) next.sort = defaultSort(next.kind, next.q);
  return next;
}

export function explorerSearch(location) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(location)) {
    if (key === 'demo') { if (value) params.set(key, '1'); }
    else if (value !== '' && !(key === 'page' && value === 1) && !(key === 'section' && value === 'explore')) params.set(key, value);
  }
  return params.toString();
}

export function discoveryParams(location, limit) {
  const { kind, q, match, department, researcher, year, yearFrom, yearTo, type, sort, page } = location;
  return { kind, q, match, department, researcher, year, yearFrom, yearTo, type, sort, page, limit };
}

export const clearedFilters = { q: '', match: 'all', department: '', researcher: '', year: '', yearFrom: '', yearTo: '', type: '', page: 1 };
