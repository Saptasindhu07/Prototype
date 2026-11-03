import { compileSearch, publicationUrl, scoreRecord } from '@research-atlas/search';
const entries = [
  ['Alex Morgan', 'School of Computing', ['Software engineering', 'Software testing', 'Developer tools'], 'Studies how software tools and testing practices help people build dependable systems.', 'Testing tools for reliable scientific software'],
  ['Jamie Chen', 'Mathematics and Statistics', ['Statistical modelling', 'Genomics', 'Uncertainty'], 'Develops statistical methods for understanding complex biological data.', 'Understanding uncertainty in genomic data'],
  ['Sam Taylor', 'Biochemistry', ['Genomics', 'Molecular biology', 'Protein structure'], 'Investigates molecular processes and the relationship between structure and function.', 'Exploring variation in protein structures'],
  ['Robin Ellis', 'Physics', ['Quantum optics', 'Light–matter interactions'], 'Explores the behaviour of light and its interactions with matter.', 'Light–matter interactions in optical systems'],
  ['Morgan Reed', 'Chemistry', ['Materials chemistry', 'Spectroscopy'], 'Uses spectroscopy to investigate the properties of new materials.', 'Spectroscopic approaches to functional materials'],
  ['Casey Patel', 'Microbiology and Immunology', ['Microbial genetics', 'Antimicrobial resistance'], 'Investigates microbial adaptation and the mechanisms of antimicrobial resistance.', 'Genetic variation in microbial communities'],
  ['Jordan Lee', 'Geology', ['Geophysics', 'Earthquakes', 'Climate history'], 'Studies geological processes and the evidence preserved in the landscape.', 'Reading environmental change in geological records'],
  ['Avery Wilson', 'Zoology', ['Ecology', 'Conservation', 'Population genetics'], 'Studies population change and the conservation of biodiversity.', 'Population change in changing ecosystems'],
];

export const sampleResearchers = entries.map(([name, department, researchInterests, biography], index) => ({
  _id: `sample-researcher-${index}`, name, biography, researchInterests,
  affiliations: [{ institution: 'University of Otago', department, isCurrent: true }],
  externalIds: {},
}));

export const samplePublications = entries.map((entry, index) => ({
  _id: `sample-publication-${index}`, title: entry[4],
  abstract: 'This is an illustrative record created for the interface preview. It is not a real publication. The live collection will display source-provided abstracts here when available.',
  authors: [{ researcherId: sampleResearchers[index]._id, name: entry[0] }],
  year: 2025 - index % 3, type: index === 0 ? 'conference-paper' : 'journal-article',
  venue: { name: 'Illustrative publication venue' }, keywords: entry[2], externalIds: {},
}));

sampleResearchers.forEach((person, index) => {
  person.publicationCount = 1;
  person.latestPublication = samplePublications[index];
});

export function sampleSummary() {
  return {
    researchers: sampleResearchers.length, publications: samplePublications.length,
    departments: entries.map((entry) => ({ name: entry[1], count: 1 })).sort((a, b) => a.name.localeCompare(b.name)),
    years: [2025, 2024, 2023],
  };
}

export function sampleRecommendations(params) {
  const people = sampleResearchers.filter(person => (!params.department || person.affiliations.some(a => a.department === params.department))
    && (!params.researcher || person._id === params.researcher));
  const recommendations = people.map(researcher => {
    const papers = samplePublications.filter(paper => paper.authors.some(a => a.researcherId === researcher._id)
      && (!params.year || paper.year === Number(params.year))
      && (!params.yearFrom || paper.year >= Number(params.yearFrom))
      && (!params.yearTo || paper.year <= Number(params.yearTo))
      && (!params.type || paper.type === params.type));
    return { researcher, papers, reason: 'Illustrative profile and linked papers for trying the recommendation layout.' };
  }).filter(item => item.papers.length).slice(0, 3);
  return { data: { query: params.q, recommendations }, meta: { engine: 'sample-layout-only', supervisionAvailabilityVerified: false } };
}

export function sampleDiscovery(params) {
  const kind = params.kind || 'researchers';
  const search = compileSearch(params.q || '', params.match || 'all');
  const sort = params.sort || (search.q ? 'relevance' : kind === 'researchers' ? 'name' : 'newest');
  if (params.yearFrom && params.yearTo && Number(params.yearFrom) > Number(params.yearTo)) {
    throw Object.assign(new Error('yearFrom cannot exceed yearTo.'), { status: 400 });
  }
  const people = sampleResearchers.filter((person) => (!params.researcher || person._id === params.researcher)
    && (!params.department || person.affiliations.some((a) => a.department === params.department && a.isCurrent !== false)));
  const peopleIds = new Set(people.map((person) => person._id));
  const papers = samplePublications.filter((paper) => (!params.year || paper.year === Number(params.year))
    && (!params.yearFrom || paper.year >= Number(params.yearFrom)) && (!params.yearTo || paper.year <= Number(params.yearTo))
    && (!params.type || paper.type === params.type) && paper.authors.some((author) => peopleIds.has(author.researcherId)));
  const publicMatch = ({ score, matchedFields, matchedTerms, exactMatch }) => ({ score, matchedFields, matchedTerms, exactMatch });
  const publicPaper = (row) => ({ ...row.record, publicationUrl: publicationUrl(row.record), searchMatch: publicMatch(row.match), duplicateRecordIds: [] });
  const compare = (a, b, order = sort, recordKind = kind) => {
    if (order === 'relevance') {
      const ranked = b.match.tier - a.match.tier || b.match.score - a.match.score;
      if (ranked) return ranked;
      order = recordKind === 'researchers' ? 'name' : 'newest';
    }
    const left = a.record; const right = b.record;
    const primary = order === 'oldest' ? left.year - right.year : order === 'newest' ? right.year - left.year
      : order === 'recent' ? right._id.localeCompare(left._id)
        : (left.name || left.title).localeCompare(right.name || right.title);
    return primary || left._id.localeCompare(right._id);
  };
  let rows;
  if (kind === 'publications') {
    rows = papers.map((record) => ({ record, match: scoreRecord(record, search, kind) })).filter((row) => row.match.matched);
  } else {
    const hasPaperFilters = Boolean(params.year || params.yearFrom || params.yearTo || params.type);
    const personIdentifier = search.identifier?.kind === 'researchers';
    const paperSearch = personIdentifier ? compileSearch('') : search;
    const evidence = search.q || hasPaperFilters ? papers.map((record) => ({ record, match: scoreRecord(record, paperSearch, 'publications', true) }))
      .filter((row) => row.match.matched).sort((a, b) => compare(a, b, 'relevance', 'publications')) : [];
    rows = [];
    for (const record of people) {
      const direct = scoreRecord(record, search, kind);
      if (personIdentifier && !direct.matched) continue;
      const linked = evidence.filter((row) => row.record.authors.some((author) => author.researcherId === record._id));
      if (hasPaperFilters ? !linked.length : !direct.matched && !linked.length) continue;
      const best = linked.slice(0, 3);
      rows.push({ record, match: { ...direct, score: direct.score + (search.q ? best.reduce((sum, row) => sum + Math.min(row.match.score, 20) * 0.5, 0) : 0) },
        matchedPublicationCount: linked.length, matchingPublications: best.map(publicPaper) });
    }
  }
  rows.sort(compare);
  const page = Number(params.page || 1);
  const limit = Number(params.limit || 12);
  const data = rows.slice((page - 1) * limit, page * limit).map((row) => kind === 'publications' ? publicPaper(row)
    : { ...row.record, searchMatch: publicMatch(row.match), matchedPublicationCount: row.matchedPublicationCount, matchingPublications: row.matchingPublications });
  return { data, total: rows.length, page, limit, pages: Math.ceil(rows.length / limit),
    search: { query: search.q, match: search.match, sort, engine: 'literal-v1-sample', matchedRecords: rows.length, duplicatesCollapsed: 0 } };
}
