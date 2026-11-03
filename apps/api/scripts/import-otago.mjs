import { readFile, writeFile, mkdir, open, unlink, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Researcher, Publication } from '../src/models/index.js';
import { canonicalOpenAlexId, mapPublication } from './otago-normalize.mjs';
import { readOtagoScope, publicationWithinScope } from './otago-scope.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = `${root}/work/otago`;
const institution = 'I80281795';
const config = readOtagoScope();
const { target, fromDate, cutoff } = config;
const report = { startedAt: new Date(), status: 'starting', target, fromDate, cutoff, insertedResearchers: 0,
  insertedPublications: 0, existingPublications: 0, reviewedWorks: 0, rejectedWorks: 0,
  conflicts: 0, apiRequests: 0, completedAuthors: [], errors: [] };
let lastFetch = 0;
let lockOwned = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = path => readFile(path, 'utf8').then(JSON.parse);
async function saveReport() {
  report.updatedAt = new Date();
  await writeFile(`${directory}/status.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, inserted: report.insertedPublications,
    existing: report.existingPublications, reviewed: report.reviewedWorks, authorsDone: report.completedAuthors.length }));
}
async function audit(event) {
  await appendFile(`${directory}/audit.jsonl`, JSON.stringify({ at: new Date(), ...event }) + '\n');
}

async function cachedFetch(url) {
  const key = createHash('sha256').update(url).digest('hex');
  const path = `${directory}/works-cache/${key}.json`;
  try { return await json(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (let attempt = 0; attempt < 4; attempt++) {
    await pause(Math.max(0, 1100 - (Date.now() - lastFetch)));
    lastFetch = Date.now();
    const response = await fetch(url, { headers: { 'User-Agent': 'OtagoResearchPrototype/0.1 (noncommercial metadata research)' }, signal: AbortSignal.timeout(60000) });
    report.apiRequests++;
    if (response.status === 429) {
      const body = await response.text();
      if (/daily|budget|credit|quota/i.test(body)) throw new Error('OpenAlex daily budget exhausted; resume later or supply own API key.');
      await pause(Math.min(60000, Math.max(5000, Number(response.headers.get('retry-after') || 5) * 1000)));
      continue;
    }
    if (response.status >= 500 && attempt < 3) { await pause(5000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
    const data = await response.json();
    await writeFile(path, JSON.stringify(data));
    return data;
  }
  throw new Error('OpenAlex rate limit persisted; stopping politely.');
}

try {
  await mkdir(`${directory}/works-cache`, { recursive: true });
  const lock = await open(`${directory}/import.lock`, 'wx');
  lockOwned = true;
  await lock.writeFile(String(process.pid)); await lock.close();
  const profileData = await json(`${directory}/profiles.json`);
  const profiles = Array.isArray(profileData) ? profileData : profileData.profiles;
  const matchData = await json(`${directory}/author-matches.json`);
  const matches = matchData.matches;
  if (matchData.status !== 'complete') throw new Error('Author identity audit must finish before import.');
  if (!profiles?.length || !Array.isArray(matches)) throw new Error('Verified profiles and author matches are required.');
  await writeFile(`${directory}/input-snapshot-${Date.now()}.json`, JSON.stringify({ profiles, matchData, config }));
  await connectDatabase();
  await Researcher.createIndexes(); await Publication.createIndexes();
  report.status = 'importing-researchers'; await saveReport();
  const researcherMap = new Map();
  const profileMap = new Map();
  const rosterKey = p => `${p.name}|${(p.affiliations || []).map(a => a.department).sort().join('|')}`;
  let previousAudit = [];
  try { previousAudit = (await readFile(`${directory}/audit.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ownResearcherIds = [...new Set(previousAudit.filter(a => a.kind === 'researcher').map(a => a.researcherId))];
  const ownPublicationIds = new Set(previousAudit.filter(a => a.kind === 'publication').map(a => String(a.publicationId)));
  const ownResearchers = await Researcher.find({ _id: { $in: ownResearcherIds } }).lean();
  for (const profile of profiles) {
    if (!profile.profileUrl) { await audit({ kind: 'profile-deferred', name: profile.name, reason: 'Missing individual official profile URL' }); continue; }
    const match = matches.find(m => m.profileUrl === profile.profileUrl);
    const authorId = canonicalOpenAlexId(match?.authorId, 'A');
    const input = Object.fromEntries(['name', 'biography', 'affiliations', 'researchInterests', 'profileUrl'].filter(k => profile[k] !== undefined).map(k => [k, profile[k]]));
    input.externalIds = { ...profile.externalIds };
    if (authorId) input.externalIds.openAlex = authorId;
    if (match?.orcid) input.externalIds.orcid = match.orcid.replace(/^https?:\/\/orcid.org\//, '');
    input.lastSyncedAt = new Date();
    const clauses = [{ profileUrl: profile.profileUrl }];
    const sameRoster = ownResearchers.filter(p => rosterKey(p) === rosterKey(profile));
    if (sameRoster.length === 1) clauses.push({ _id: sameRoster[0]._id });
    if (authorId) clauses.push({ 'externalIds.openAlex': { $in: [authorId, `https://openalex.org/${authorId}`] } });
    if (input.externalIds.orcid) clauses.push({ 'externalIds.orcid': { $in: [input.externalIds.orcid, `https://orcid.org/${input.externalIds.orcid}`] } });
    const existing = await Researcher.find({ $or: clauses });
    if (existing.length > 1) { report.conflicts++; await audit({ kind: 'researcher-conflict', profileUrl: profile.profileUrl }); continue; }
    let researcher = existing[0];
    if (researcher && ((authorId && researcher.externalIds?.openAlex && canonicalOpenAlexId(researcher.externalIds.openAlex, 'A') !== authorId)
      || (input.externalIds.orcid && researcher.externalIds?.orcid && researcher.externalIds.orcid.replace(/^https?:\/\/orcid.org\//, '') !== input.externalIds.orcid))) {
      report.conflicts++; await audit({ kind: 'researcher-identity-conflict', profileUrl: profile.profileUrl }); continue;
    }
    if (!researcher) { researcher = await Researcher.create(input); report.insertedResearchers++; }
    else {
      const updates = {};
      for (const [key, value] of Object.entries(input.externalIds)) {
        if (value && !researcher.externalIds?.[key]) updates[`externalIds.${key}`] = value;
      }
      if (!researcher.biography?.trim() && input.biography?.trim()) updates.biography = input.biography;
      if (!researcher.researchInterests?.length && input.researchInterests?.length) updates.researchInterests = input.researchInterests;
      if (Object.keys(updates).length) await Researcher.updateOne({ _id: researcher._id }, { $set: updates }, { runValidators: true });
    }
    profileMap.set(String(researcher._id), profile);
    for (const candidate of [authorId, ...(match?.aliases || [])]) {
      const id = canonicalOpenAlexId(candidate, 'A');
      if (!id) continue;
      if (researcherMap.has(id) && String(researcherMap.get(id)) !== String(researcher._id)) {
        throw new Error('Author identity assigned to conflicting local researchers; manual audit required.');
      }
      researcherMap.set(id, researcher._id);
    }
    await audit({ kind: 'researcher', researcherId: researcher._id, profileUrl: profile.profileUrl, authorId, evidence: match?.evidence });
  }
  report.verifiedProfiles = profiles.length;
  report.matchedAuthorIds = researcherMap.size;
  if (!researcherMap.size) throw new Error('No confidently verified OpenAlex authors yet; researcher profiles only.');
  const seen = new Set();
  const previousPublications = await Publication.find({
    _id: { $in: [...ownPublicationIds] },
    'authors.researcherId': { $in: [...researcherMap.values()] },
  }).select('_id year publicationDate').lean();
  const importedIds = new Set(previousPublications
    .filter(publication => publicationWithinScope(publication, config))
    .map(publication => String(publication._id)));
  report.countingMode = 'cumulative-audited-scope';
  report.existingEligibleAtStart = importedIds.size;
  report.uniqueEligiblePublications = importedIds.size;
  report.status = 'importing-publications'; await saveReport();
  const pending = [...researcherMap.keys()].map(authorId => ({ authorId, page: 1 }));
  while (pending.length && importedIds.size < target) {
    const current = pending.shift();
    const params = new URLSearchParams({
      filter: `author.id:${current.authorId},institutions.id:${institution},from_publication_date:${fromDate},to_publication_date:${cutoff}`,
      per_page: '100', page: String(current.page), sort: 'publication_date:desc',
    });
    const url = `https://api.openalex.org/works?${params}`;
    const data = await cachedFetch(url);
    if (!Array.isArray(data.results)) throw new Error('Unexpected OpenAlex response.');
    for (let work of data.results) {
      if (importedIds.size >= target) break;
      if (seen.has(work.id)) continue;
      seen.add(work.id); report.reviewedWorks++;
      if (work.authorships?.length >= 100 || work.authors_count > (work.authorships?.length || 0)) {
        work = await cachedFetch(`https://api.openalex.org/works/${canonicalOpenAlexId(work.id, 'W')}`);
        if (work.authorships?.length >= 5000) work.is_authors_truncated = true;
      }
      const linkedAtOtago = work.authorships?.some(a => researcherMap.has(canonicalOpenAlexId(a.author?.id, 'A'))
        && a.institutions?.some(i => canonicalOpenAlexId(i.id, 'I') === institution));
      const mapped = mapPublication(work, researcherMap);
      if (!linkedAtOtago || !publicationWithinScope(mapped, config)) {
        report.rejectedWorks++; await audit({ kind: 'rejected-work', workId: work.id, reason: !linkedAtOtago ? 'No verified cohort authorship at Otago' : 'Unsupported/incomplete/retracted output' }); continue;
      }
      try {
        await new Publication(mapped).validate();
        const clauses = [{ 'externalIds.openAlex': { $in: [mapped.externalIds.openAlex, work.id] } }];
        if (mapped.externalIds.doi) clauses.push({ 'externalIds.doi': mapped.externalIds.doi });
        const existing = await Publication.find({ $or: clauses }).select('_id authors');
        if (existing.length > 1) { report.conflicts++; await audit({ kind: 'publication-conflict', workId: work.id }); continue; }
        let id;
        if (existing.length) {
          const doc = existing[0];
          if (ownPublicationIds.has(String(doc._id)) && doc.authors.length === mapped.authors.length
              && doc.authors.every((a, i) => a.name === mapped.authors[i].name)) {
            for (let i = 0; i < doc.authors.length; i++) {
              const linked = mapped.authors[i].researcherId;
              if (doc.authors[i].researcherId || !linked) continue;
              const result = await Publication.updateOne({ _id: doc._id,
                [`authors.${i}.researcherId`]: null, [`authors.${i}.name`]: mapped.authors[i].name,
              }, { $set: { [`authors.${i}.researcherId`]: linked } }, { runValidators: true });
              if (result.modifiedCount) doc.authors[i].researcherId = linked;
            }
          }
          if (!existing[0].authors.some(a => [...researcherMap.values()].some(r => String(r) === String(a.researcherId)))) {
            report.conflicts++; await audit({ kind: 'existing-unlinked-publication', workId: work.id }); continue;
          }
          id = existing[0]._id; report.existingPublications++;
        }
        else { const saved = await Publication.create(mapped); id = saved._id; report.insertedPublications++; }
        importedIds.add(String(id));
        await audit({ kind: 'publication', publicationId: id, workId: work.id, query: url,
          abstractSource: mapped.abstract ? 'OpenAlex abstract_inverted_index' : null,
          keywordSource: mapped.keywords.length ? 'OpenAlex enriched keywords' : null,
          dateSource: mapped.publicationDate ? 'OpenAlex reported publication_date (precision not independently verified)' : null });
      } catch (error) {
        if (error.code === 11000) { report.conflicts++; await audit({ kind: 'unique-conflict', workId: work.id }); }
        else throw error;
      }
    }
    if (data.results.length === 100 && current.page * 100 < Math.min(data.meta?.count || 10000, 10000)) pending.push({ ...current, page: current.page + 1 });
    else report.completedAuthors.push(current.authorId);
    report.uniqueEligiblePublications = importedIds.size;
    await saveReport();
  }
  const linkedIds = [...new Set([...researcherMap.values()].map(String))];
  const docs = await Publication.find({ 'authors.researcherId': { $in: linkedIds } }).lean();
  const present = predicate => docs.filter(predicate).length;
  report.coverage = { total: docs.length,
    abstract: present(p => Boolean(p.abstract?.trim())), doi: present(p => Boolean(p.externalIds?.doi)),
    keywords: present(p => p.keywords?.length > 0), venue: present(p => Boolean(p.venue?.name)),
    publisher: present(p => Boolean(p.venue?.publisher)), publicationDate: present(p => Boolean(p.publicationDate)),
    semanticScholarId: present(p => Boolean(p.externalIds?.semanticScholar)),
  };
  report.departments = {};
  for (const [id, profile] of profileMap) {
    for (const affiliation of profile.affiliations || []) {
      const name = affiliation.department || 'Unspecified';
      const group = report.departments[name] ||= { researchers: 0, publicationIds: new Set() };
      group.researchers++;
      for (const doc of docs) if (doc.authors.some(a => String(a.researcherId) === id)) group.publicationIds.add(String(doc._id));
    }
  }
  for (const group of Object.values(report.departments)) { group.publications = group.publicationIds.size; delete group.publicationIds; }
  report.status = importedIds.size >= target ? 'target-reached' : 'eligible-corpus-exhausted';
  report.finishedAt = new Date(); await saveReport();
} catch (error) {
  report.status = 'stopped'; report.errors.push({ name: error.name, message: error.message });
  console.error(error.message);
  if (lockOwned) await saveReport();
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
  if (lockOwned) await unlink(`${directory}/import.lock`);
}
