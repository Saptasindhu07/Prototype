import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTITUTION = 'I80281795';
const STOP_WORDS = new Set(('research researcher university otago department school science sciences scientific ' +
  'analysis applications approach approaches based biological biology computational computation data development ' +
  'effect effects experimental general interest interests method methods model models modelling modeling molecular ' +
  'new novel numerical physical physics process processes properties statistical statistics study studies system systems ' +
  'technique techniques theory theoretical using understanding').split(' '));

export function normalizeName(value = '') {
  return (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/^(professor|associate professor|prof|dr|doctor)\.?\s+/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const idOf = (value = '') => (value ?? '').split('/').at(-1);
const orcidOf = (value = '') => value?.match(/\d{4}-\d{4}-\d{4}-[\dX]{4}/i)?.[0].toUpperCase();
const doiOf = (value = '') => (value ?? '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim().toLowerCase();
const words = (value) => new Set(normalizeName(value).split(' ').filter((word) => word.length >= 5 && !STOP_WORDS.has(word)));
const rosterKey = (profile) => `${normalizeName(profile.name)}|${(profile.affiliations ?? []).map((a) => a.department).sort().join('|')}`;
export function sampleEvidenceDois(profile) {
  const dois = [...new Set((profile._provenance?.officialPublicationDois ?? []).map(doiOf).filter(Boolean))];
  const middle = Math.max(0, Math.floor(dois.length / 2) - 1);
  return [...new Set([...dois.slice(0, 3), ...dois.slice(middle, middle + 3), ...dois.slice(-3)])];
}

function hasInstitution(author) {
  return [...(author.last_known_institutions ?? []), ...(author.affiliations ?? []).map((a) => a.institution)]
    .some((institution) => idOf(institution?.id) === INSTITUTION);
}

function topicEvidence(profile, author) {
  const profileWords = words((profile.researchInterests ?? []).join(' '));
  const topicWords = words((author.topics ?? []).map((topic) => topic.display_name).join(' '));
  return [...profileWords].filter((word) => topicWords.has(word));
}
export function classifyCandidates(profile, candidates, doiAuthorIds = new Map()) {
  const requestedOrcid = orcidOf(profile.externalIds?.orcid);
  const profileName = normalizeName(profile.name);
  const considered = candidates.map((author) => {
    const authorId = idOf(author.id);
    const orcid = orcidOf(author.orcid);
    const names = [author.display_name, ...(author.raw_author_names ?? []), ...(author.display_name_alternatives ?? [])];
    const exactName = names.some((name) => normalizeName(name) === profileName);
    const institution = hasInstitution(author);
    const matchingDois = [...doiAuthorIds].filter(([, ids]) => ids.includes(authorId)).map(([doi]) => doi);
    const overlappingTopicWords = topicEvidence(profile, author);
    const exactOrcid = Boolean(requestedOrcid && orcid === requestedOrcid);
    const conflictingOrcid = Boolean(requestedOrcid && orcid && orcid !== requestedOrcid);
    const qualified = !conflictingOrcid && (requestedOrcid ? exactOrcid : (exactName && institution &&
      (matchingDois.length > 0 || overlappingTopicWords.length >= 3)));
    return { authorId, orcid, name: author.display_name, worksCount: author.works_count ?? 0,
      qualified, evidence: { exactOrcid, exactName, institution, matchingDois, overlappingTopicWords } };
  }).filter((candidate) => candidate.qualified || candidate.evidence.exactName || candidate.evidence.exactOrcid);

  const qualified = considered.filter((candidate) => candidate.qualified);
  const groups = new Map();
  for (const candidate of qualified) {
    const key = candidate.orcid || candidate.authorId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  if (groups.size !== 1) return { profileUrl: profile.profileUrl, rosterKey: rosterKey(profile), name: profile.name,
    reason: groups.size ? 'ambiguous-qualified-candidates' : 'insufficient-identity-evidence', candidates: considered };

  const group = [...groups.values()][0].sort((a, b) => b.worksCount - a.worksCount);
  const chosen = group[0];
  return { profileUrl: profile.profileUrl, rosterKey: rosterKey(profile), name: profile.name, authorId: chosen.authorId,
    orcid: chosen.orcid, aliases: group.slice(1).map((candidate) => candidate.authorId),
    evidence: chosen.evidence, candidates: considered,
    method: chosen.evidence.exactOrcid ? (profile._provenance?.identityVerification ? 'verified-orcid-primary-source' : 'official-orcid') :
      chosen.evidence.matchingDois.length ? 'exact-name-institution-official-doi' : 'exact-name-institution-three-topic-terms' };
}

class OpenAlexClient {
  constructor(cacheDirectory, budget) {
    this.cacheDirectory = cacheDirectory;
    this.budget = budget;
    this.spent = 0;
    this.lastRequest = 0;
  }
  async get(endpoint, params = {}) {
    const url = new URL(`https://api.openalex.org/${endpoint}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const cacheKey = createHash('sha256').update(url.href).digest('hex');
    const cacheFile = path.join(this.cacheDirectory, `${cacheKey}.json`);
    try { return JSON.parse(await readFile(cacheFile, 'utf8')).data; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const estimatedCost = params.search ? 0.001 : 0.0001;
    if (this.spent + estimatedCost > this.budget) throw new Error('Local OpenAlex request budget reached; resume using cache later.');

    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - this.lastRequest))));
      this.lastRequest = Date.now();
      const response = await fetch(url, { headers: { 'User-Agent': 'OtagoResearchPrototype/0.1 (metadata identity verification)' }, signal: AbortSignal.timeout(60000) });
      const body = await response.text();
      if (response.status === 429) {
        if (/daily|budget|credit|quota/i.test(body)) throw new Error('OpenAlex daily quota reached; no automatic retry or alternate identity.');
        const seconds = Number(response.headers.get('retry-after')) || 2 ** (attempt + 1);
        if (seconds > 60) throw new Error('OpenAlex requests a long pause; resume later.');
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}: ${body.slice(0, 250)}`);
      const data = JSON.parse(body);
      this.spent += data.meta?.cost_usd ?? estimatedCost;
      await writeFile(cacheFile, JSON.stringify({ sourceUrl: url.href, retrievedAt: new Date().toISOString(), data }));
      return data;
    }
    throw new Error('OpenAlex rate limit persists; stopped after bounded retries.');
  }
}

export async function runAuthorMatching({ profilesFile, outputFile, pages = 30, currentPages = 20, searchLimit = 15, budget = 0.025 }) {
  const input = JSON.parse(await readFile(profilesFile, 'utf8'));
  const profiles = Array.isArray(input) ? input : input.profiles;
  if (!Array.isArray(profiles)) throw new Error('Profiles JSON must be an array or {profiles: []}.');
  const cache = path.join(ROOT, 'work/otago/author-cache');
  await mkdir(cache, { recursive: true });
  await mkdir(path.dirname(outputFile), { recursive: true });
  const client = new OpenAlexClient(cache, budget);
  const candidates = new Map();
  const add = (authors) => authors.forEach((author) => candidates.set(idOf(author.id), author));
  const report = { createdAt: new Date().toISOString(), institution: INSTITUTION,
    profilesFile, matches: [], unmatched: [], status: 'running', spentUsdThisRun: 0 };
  const save = async () => {
    report.updatedAt = new Date().toISOString();
    report.spentUsdThisRun = client.spent;
    await writeFile(outputFile, JSON.stringify(report, null, 2));
  };
  const doiToAuthors = new Map();
  try {
    const orcids = [...new Set(profiles.map((profile) => orcidOf(profile.externalIds?.orcid)).filter(Boolean))];
    for (let index = 0; index < orcids.length; index += 50) {
      const batch = orcids.slice(index, index + 50);
      const result = await client.get('authors', { filter: `orcid:${batch.join('|')}`, per_page: 100 });
      add(result.results);
    }
    for (let page = 1; page <= currentPages; page++) {
      const result = await client.get('authors', { filter: `last_known_institutions.id:${INSTITUTION}`, sort: 'works_count:desc', per_page: 100, page });
      add(result.results);
      if (page % 5 === 0) console.log(`Current author candidates cached: ${candidates.size}`);
      if (result.results.length < 100) break;
    }
    for (let page = 1; page <= pages; page++) {
      const result = await client.get('authors', { filter: `affiliations.institution.id:${INSTITUTION}`, sort: 'works_count:desc', per_page: 100, page });
      add(result.results);
      if (page % 5 === 0) console.log(`Author candidates cached: ${candidates.size}`);
      if (result.results.length < 100) break;
    }

    const allDois = [...new Set(profiles.flatMap(sampleEvidenceDois))];
    const doiCandidateIds = new Set();
    for (let index = 0; index < allDois.length; index += 30) {
      const result = await client.get('works', { filter: `doi:${allDois.slice(index, index + 30).join('|')}`, per_page: 100 });
      for (let work of result.results) {
        if (work.authorships.length >= 100 || work.authors_count > work.authorships.length || work.is_authors_truncated) {
          work = await client.get(`works/${idOf(work.id)}`);
        }
        doiToAuthors.set(doiOf(work.doi), work.authorships.map((authorship) => idOf(authorship.author?.id)).filter(Boolean));
        const relevantNames = new Set(profiles.filter((profile) => (profile._provenance?.officialPublicationDois ?? [])
          .map(doiOf).includes(doiOf(work.doi))).map((profile) => normalizeName(profile.name)));
        for (const authorship of work.authorships) {
          if (idOf(authorship.author?.id) && [authorship.author?.display_name, authorship.raw_author_name].some((name) => relevantNames.has(normalizeName(name)))) {
            doiCandidateIds.add(idOf(authorship.author.id));
          }
        }
      }
    }
    const missingCandidates = [...doiCandidateIds].filter((authorId) => !candidates.has(authorId));
    for (let index = 0; index < missingCandidates.length; index += 50) {
      const result = await client.get('authors', { filter: `openalex:${missingCandidates.slice(index, index + 50).join('|')}`, per_page: 100 });
      add(result.results);
    }

    let searches = 0;
    for (const profile of profiles) {
      const officialDois = new Set((profile._provenance?.officialPublicationDois ?? []).map(doiOf));
      const evidenceDois = new Map([...doiToAuthors].filter(([doi]) => officialDois.has(doi)));
      let match = classifyCandidates(profile, [...candidates.values()], evidenceDois);
      if (!match.authorId && searches < searchLimit) {
        searches++;
        const result = await client.get('authors', { search: profile.name,
          filter: `affiliations.institution.id:${INSTITUTION}`, per_page: 25 });
        add(result.results);
        match = classifyCandidates(profile, [...candidates.values()], evidenceDois);
      }
      if (match.authorId) report.matches.push(match);
      else report.unmatched.push(match);
      console.log(`${match.authorId ? 'Matched' : 'Review'}: ${profile.name}${match.authorId ? ` -> ${match.authorId}` : ''}`);
      await save();
    }
    const claimed = new Map();
    for (const match of report.matches) {
      for (const authorId of [match.authorId, ...match.aliases]) {
        if (!claimed.has(authorId)) claimed.set(authorId, []);
        claimed.get(authorId).push(match.profileUrl || match.rosterKey);
      }
    }
    const conflicts = new Set([...claimed].filter(([, urls]) => new Set(urls).size > 1).flatMap(([, urls]) => urls));
    report.unmatched.push(...report.matches.filter((match) => conflicts.has(match.profileUrl || match.rosterKey))
      .map((match) => ({ ...match, authorId: undefined, reason: 'identity-claimed-by-multiple-profiles' })));
    report.matches = report.matches.filter((match) => !conflicts.has(match.profileUrl || match.rosterKey));
    report.status = 'complete';
  } catch (error) {
    report.status = 'stopped';
    report.error = error.message;
    throw error;
  } finally {
    await save();
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const pages = Number(option('--pages', 30));
  const currentPages = Number(option('--current-pages', 20));
  const searchLimit = Number(option('--search-limit', 15));
  const budget = Number(option('--budget', 0.025));
  if (!Number.isInteger(pages) || pages < 0 || pages > 100 || !Number.isInteger(currentPages) || currentPages < 0 || currentPages > 100 || !Number.isInteger(searchLimit) || searchLimit < 0 || !Number.isFinite(budget) || budget <= 0) {
    throw new Error('Invalid pages, search-limit, or budget.');
  }
  runAuthorMatching({ profilesFile: path.resolve(option('--profiles', path.join(ROOT, 'work/otago/profiles.json'))),
    outputFile: path.resolve(option('--output', path.join(ROOT, 'work/otago/author-matches.json'))), pages, currentPages, searchLimit, budget })
    .then((report) => console.log(`Done: ${report.matches.length} matched, ${report.unmatched.length} need review.`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
