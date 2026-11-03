import { access, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { canonicalOpenAlexId, mapPublication, normaliseDoi } from './otago-normalize.mjs';

const directory = fileURLToPath(new URL('../../../work/otago/', import.meta.url));
const institution = 'I80281795';
const agreedDepartments = new Set([
  'School of Computing', 'Mathematics and Statistics', 'Biochemistry', 'Physics',
  'Chemistry', 'Microbiology and Immunology', 'Geology', 'Zoology',
]);
const report = {
  verifiedAt: new Date().toISOString(), status: 'starting', readOnly: true,
  errors: {}, warnings: {}, counts: {}, coverage: {}, departments: {},
  provenance: { checked: 0, missing: 0, canonicalOlderAudit: 0, alternateWorkAuditEvents: 0 },
};
let connection;
const fail = (code, sample) => record(report.errors, code, sample);
const warn = (code, sample) => record(report.warnings, code, sample);
function record(target, code, sample) {
  const group = target[code] ||= { count: 0, samples: [] };
  group.count++;
  if (sample !== undefined && group.samples.length < 8) group.samples.push(sample);
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => value == null ? null : String(value);
const objectId = value => value?._bsontype === 'ObjectId';
const text = value => typeof value === 'string' && value.trim().length > 0;
function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === value;
}
const normaliseOrcid = value => {
  if (typeof value !== 'string') return undefined;
  const result = value.trim().replace(/^https?:\/\/orcid\.org\//i, '').toUpperCase();
  return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(result) ? result : undefined;
};
function validOrcid(value) {
  const chars = value.replaceAll('-', '');
  let total = 0;
  for (const digit of chars.slice(0, 15)) total = (total + Number(digit)) * 2;
  const check = (12 - total % 11) % 11;
  return chars[15] === (check === 10 ? 'X' : String(check));
}
async function assertIdle() {
  for (const name of ['import.lock', 'enrichment.lock']) {
    try { await access(`${directory}/${name}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Refusing verification while ${name} exists; wait for the pipeline to finish.`);
  }
}
async function fingerprint(names) {
  return JSON.stringify(await Promise.all(names.map(async name => {
    const info = await stat(`${directory}/${name}`);
    return [name, info.size, info.mtimeMs];
  })));
}
async function latestSnapshot() {
  const files = (await readdir(directory)).filter(name => /^input-snapshot-\d+\.json$/.test(name));
  files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!files.length) throw new Error('No frozen input snapshot found.');
  return files[0];
}
function jsonLines(body, label) {
  return body.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid JSON in ${label}, nonblank line ${index + 1}.`); }
  });
}
function fieldCoverage(docs) {
  const present = predicate => docs.filter(predicate).length;
  return {
    total: docs.length, abstract: present(p => text(p.abstract)),
    doi: present(p => text(p.externalIds?.doi)), openAlex: present(p => text(p.externalIds?.openAlex)),
    semanticScholar: present(p => text(p.externalIds?.semanticScholar)),
    keywords: present(p => Array.isArray(p.keywords) && p.keywords.some(text)),
    venue: present(p => text(p.venue?.name)), publisher: present(p => text(p.venue?.publisher)),
    publicationDate: present(p => p.publicationDate instanceof Date && !Number.isNaN(+p.publicationDate)),
  };
}
const cache = new Map();
async function cachedJson(path) {
  if (!cache.has(path)) {
    const promise = readJson(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    cache.set(path, promise);
  }
  return cache.get(path);
}
const unwrap = value => value?.data || value;
async function sourceFor(publication, entries) {
  const workId = canonicalOpenAlexId(publication.externalIds?.openAlex, 'W');
  if (!workId) return null;
  const canonicalEntries = entries.filter(event => canonicalOpenAlexId(event.workId, 'W') === workId);
  const chosen = canonicalEntries.at(-1);
  report.provenance.alternateWorkAuditEvents += entries.length - canonicalEntries.length;
  if (chosen && chosen !== entries.at(-1)) report.provenance.canonicalOlderAudit++;
  let work;
  let source;
  let fullSourceMissing = false;
  for (const event of canonicalEntries.toReversed()) {
    if (!event.query) continue;
    const path = `${directory}/works-cache/${hash(event.query)}.json`;
    const response = unwrap(await cachedJson(path));
    const found = response?.results?.find(item => canonicalOpenAlexId(item.id, 'W') === workId);
    if (found) { work = found; source = path; break; }
  }
  if (!work || work.authorships?.length >= 100 || work.is_authors_truncated
      || work.authors_count > (work.authorships?.length || 0)) {
    fullSourceMissing = true;
    const fullUrl = `https://api.openalex.org/works/${workId}`;
    for (const path of [
      `${directory}/works-cache/${hash(fullUrl)}.json`, `${directory}/verified-${workId}.json`,
    ]) {
      const full = unwrap(await cachedJson(path));
      if (canonicalOpenAlexId(full?.id, 'W') === workId) {
        work = full; source = path; fullSourceMissing = false; break;
      }
    }
  }
  return work ? { work, source, event: chosen, fullSourceMissing } : null;
}
function duplicateCheck(docs, field, normalise, scope, label) {
  const groups = new Map();
  for (const doc of docs) {
    const value = doc.externalIds?.[field];
    if (value == null || value === '') continue;
    const canonical = normalise(value);
    if (!canonical) {
      (scope.has(id(doc._id)) ? fail : warn)(`invalid-${label}`, { id: id(doc._id), value });
      continue;
    }
    const ids = groups.get(canonical) || [];
    ids.push(id(doc._id)); groups.set(canonical, ids);
  }
  let duplicates = 0;
  for (const [value, ids] of groups) {
    if (ids.length < 2) continue;
    duplicates++;
    (ids.some(value => scope.has(value)) ? fail : warn)(`duplicate-${label}`, { value, ids });
  }
  return duplicates;
}

try {
  await assertIdle();
  const snapshotName = await latestSnapshot();
  const tracked = [snapshotName, 'audit.jsonl', 'status.json', 'enrichment-status.json'];
  const before = await fingerprint(tracked);
  const [snapshot, status, enrichment, auditText] = await Promise.all([
    readJson(`${directory}/${snapshotName}`), readJson(`${directory}/status.json`),
    readJson(`${directory}/enrichment-status.json`), readFile(`${directory}/audit.jsonl`, 'utf8'),
  ]);
  const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : snapshot.profiles?.profiles;
  const matches = snapshot.matchData?.matches;
  if (!profiles?.length || !Array.isArray(matches) || snapshot.matchData.status !== 'complete') {
    throw new Error('Frozen snapshot lacks completed researcher identity verification.');
  }
  if (!['target-reached', 'eligible-corpus-exhausted'].includes(status.status)
      || enrichment.status !== 'complete') throw new Error('Import and enrichment must both have completed.');
  const snapshotTime = Number(snapshotName.match(/\d+/)[0]);
  if (!Number.isFinite(Date.parse(status.startedAt)) || Math.abs(snapshotTime - Date.parse(status.startedAt)) > 60000) {
    throw new Error('Import status does not correspond to the latest frozen snapshot.');
  }
  if (Date.parse(enrichment.startedAt) < Date.parse(status.finishedAt)) {
    throw new Error('Enrichment status belongs to a previous import run.');
  }
  const fromDate = status.fromDate === undefined ? '2015-01-01' : status.fromDate;
  if (!validCalendarDate(status.cutoff)) throw new Error('Missing or invalid frozen cutoff date.');
  if (!validCalendarDate(fromDate) || fromDate < '1900-01-01' || fromDate > status.cutoff) {
    throw new Error('Frozen fromDate must be a valid calendar date from 1900-01-01 through cutoff.');
  }
  if (!Number.isSafeInteger(status.target) || status.target < 1 || status.target > 8000) {
    throw new Error('Frozen target must be an integer from 1 through 8000.');
  }
  if (snapshot.config !== undefined) {
    if (!snapshot.config || typeof snapshot.config !== 'object' || Array.isArray(snapshot.config)
        || snapshot.config.fromDate !== fromDate || snapshot.config.cutoff !== status.cutoff
        || snapshot.config.target !== status.target) {
      throw new Error('Frozen snapshot config does not match the import status scope.');
    }
  }
  report.inputs = { snapshot: snapshotName, cutoff: status.cutoff, fromDate,
    target: status.target, importStatus: status.status, enrichmentStatus: enrichment.status };
  const snapshotDepartments = new Set();
  for (const profile of profiles) {
    if (!profile.affiliations?.length) fail('snapshot-profile-missing-department', profile.name);
    for (const affiliation of profile.affiliations || []) {
      const department = affiliation.department;
      if (!agreedDepartments.has(department)) {
        fail('snapshot-department-outside-agreed-scope', { name: profile.name, department });
      } else snapshotDepartments.add(department);
      if (affiliation.institution !== 'University of Otago') {
        fail('snapshot-institution-outside-agreed-scope', { name: profile.name, institution: affiliation.institution });
      }
    }
  }
  for (const department of agreedDepartments) {
    if (!snapshotDepartments.has(department)) fail('agreed-department-missing-from-snapshot', department);
  }
  report.inputs.agreedDepartments = [...agreedDepartments];
  report.inputs.snapshotDepartments = [...snapshotDepartments];
  const events = jsonLines(auditText, 'audit.jsonl');
  const byPublication = new Map();
  for (const event of events.filter(event => event.kind === 'publication')) {
    const key = String(event.publicationId);
    if (!/^[a-f\d]{24}$/i.test(key)) { fail('invalid-audit-publication-id', key); continue; }
    const list = byPublication.get(key) || [];
    list.push(event); byPublication.set(key, list);
  }
  for (const entries of byPublication.values()) entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const publicationScope = new Set(byPublication.keys());
  const researcherScope = new Set(events.filter(event => event.kind === 'researcher').map(event => String(event.researcherId)));
  const { env } = await import('../src/config/env.js');
  connection = await mongoose.createConnection(env.mongodbUri, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000,
  }).asPromise();
  const researchersCollection = connection.db.collection('researchers');
  const publicationsCollection = connection.db.collection('publications');
  const [researchers, publicationIds, publications] = await Promise.all([
    researchersCollection.find({}).toArray(),
    publicationsCollection.find({}, { projection: { externalIds: 1 } }).toArray(),
    publicationsCollection.find({ _id: { $in: [...publicationScope].map(value => new mongoose.Types.ObjectId(value)) } }).toArray(),
  ]);
  const researchersById = new Map(researchers.map(doc => [id(doc._id), doc]));
  const docsById = new Map(publications.map(doc => [id(doc._id), doc]));
  for (const key of publicationScope) if (!docsById.has(key)) fail('missing-audited-publication', key);
  for (const key of researcherScope) if (!researchersById.has(key)) fail('missing-audited-researcher', key);
  const cohortIds = new Set();
  const authorMap = new Map();
  const profileByResearcher = new Map();
  const matchedUrls = new Set();
  for (const profile of profiles) {
    const paired = matches.filter(match => match.profileUrl === profile.profileUrl);
    if (paired.length !== 1) { fail('snapshot-profile-match-pairing', { name: profile.name, count: paired.length }); continue; }
    const match = paired[0]; matchedUrls.add(match.profileUrl);
    const primary = canonicalOpenAlexId(match.authorId, 'A');
    const orcid = normaliseOrcid(match.orcid || profile.externalIds?.orcid);
    if (!primary) { fail('invalid-snapshot-author-id', profile.name); continue; }
    if (orcid && !validOrcid(orcid)) fail('invalid-snapshot-orcid-checksum', profile.name);
    const candidates = researchers.filter(doc => doc.profileUrl === profile.profileUrl
      || canonicalOpenAlexId(doc.externalIds?.openAlex, 'A') === primary
      || (orcid && normaliseOrcid(doc.externalIds?.orcid) === orcid));
    if (candidates.length !== 1) { fail('researcher-identity-pairing', { name: profile.name, count: candidates.length }); continue; }
    const doc = candidates[0]; const key = id(doc._id);
    if (cohortIds.has(key)) fail('researcher-reused-across-profiles', { name: profile.name, id: key });
    cohortIds.add(key); profileByResearcher.set(key, profile);
    const missingDepartments = (profile.affiliations || []).filter(affiliation => !doc.affiliations?.some(current =>
      current.institution === affiliation.institution && current.department === affiliation.department));
    if (doc.name !== profile.name || doc.profileUrl !== profile.profileUrl || missingDepartments.length
        || canonicalOpenAlexId(doc.externalIds?.openAlex, 'A') !== primary
        || (orcid && normaliseOrcid(doc.externalIds?.orcid) !== orcid)) {
      fail('researcher-source-identity-mismatch', { name: profile.name, id: key });
    }
    for (const raw of [match.authorId, ...(match.aliases || [])]) {
      const sourceId = canonicalOpenAlexId(raw, 'A');
      if (!sourceId) { fail('invalid-snapshot-alias', { name: profile.name, raw }); continue; }
      if (authorMap.has(sourceId) && authorMap.get(sourceId) !== key) fail('snapshot-author-id-collision', sourceId);
      authorMap.set(sourceId, key);
    }
  }
  for (const match of matches) if (!matchedUrls.has(match.profileUrl)) fail('snapshot-match-without-profile', match.name);
  for (const key of cohortIds) researcherScope.add(key);
  report.duplicates = {
    publicationDoi: duplicateCheck(publicationIds, 'doi', normaliseDoi, publicationScope, 'publication-doi'),
    publicationOpenAlex: duplicateCheck(publicationIds, 'openAlex', value => canonicalOpenAlexId(value, 'W'), publicationScope, 'publication-openalex'),
    researcherOpenAlex: duplicateCheck(researchers, 'openAlex', value => canonicalOpenAlexId(value, 'A'), researcherScope, 'researcher-openalex'),
    researcherOrcid: duplicateCheck(researchers, 'orcid', normaliseOrcid, researcherScope, 'researcher-orcid'),
  };
  for (const doc of researchers.filter(doc => researcherScope.has(id(doc._id)))) {
    const orcid = normaliseOrcid(doc.externalIds?.orcid);
    if (orcid && !validOrcid(orcid)) fail('researcher-orcid-checksum', id(doc._id));
  }
  const linkedResearchers = new Set();
  const linkedPublicationIds = new Map();
  let nullAuthorSlots = 0;
  let authorSlots = 0;
  let sourceCheckedAuthorSlots = 0;
  for (const doc of publications) {
    const key = id(doc._id);
    const authors = Array.isArray(doc.authors) ? doc.authors : [];
    if (!authors.length) fail('empty-author-list', key);
    let hasCohort = false;
    for (const author of authors) {
      authorSlots++;
      if (author.researcherId == null) { nullAuthorSlots++; continue; }
      const linked = id(author.researcherId);
      if (!objectId(author.researcherId)) fail('non-objectid-author-link', { id: key, researcherId: linked });
      if (!researchersById.has(linked)) fail('dangling-author-link', { id: key, researcherId: linked });
      if (cohortIds.has(linked)) {
        hasCohort = true; linkedResearchers.add(linked);
        const set = linkedPublicationIds.get(linked) || new Set(); set.add(key); linkedPublicationIds.set(linked, set);
      }
    }
    if (!hasCohort) fail('publication-without-cohort-link', key);
    if (!Number.isInteger(doc.year) || doc.year < Number(fromDate.slice(0, 4)) || doc.year > Number(status.cutoff.slice(0, 4))) fail('year-out-of-scope', { id: key, year: doc.year });
    if (doc.publicationDate != null) {
      if (!(doc.publicationDate instanceof Date) || Number.isNaN(+doc.publicationDate)) fail('invalid-publication-date', key);
      else {
        const day = doc.publicationDate.toISOString().slice(0, 10);
        if (day < fromDate || day > status.cutoff) fail('date-out-of-scope', { id: key, date: day });
      }
    }
    const entries = byPublication.get(key);
    const source = await sourceFor(doc, entries);
    if (!source) { report.provenance.missing++; fail('missing-canonical-source-cache', { id: key, workId: doc.externalIds?.openAlex }); continue; }
    report.provenance.checked++;
    const work = source.work;
    if (!source.event) fail('missing-canonical-work-audit', { id: key, workId: doc.externalIds?.openAlex });
    if (source.fullSourceMissing) {
      report.provenance.missing++;
      fail('missing-required-full-author-source-cache', { id: key, workId: doc.externalIds?.openAlex });
      continue;
    }
    if (work.is_retracted || work.is_authors_truncated || work.authorships?.length >= 5000
        || work.authors_count > (work.authorships?.length || 0)) fail('retracted-or-incomplete-source', key);
    const mapped = mapPublication(work, authorMap);
    if (!mapped) { fail('source-no-longer-maps-to-supported-publication', key); continue; }
    if (doc.type !== mapped.type) fail('publication-type-source-mismatch', { id: key, actual: doc.type, expected: mapped.type });
    if (doc.year !== mapped.year) fail('publication-year-source-mismatch', { id: key, actual: doc.year, expected: mapped.year });
    const sourceDoi = normaliseDoi(work.doi);
    if (sourceDoi && normaliseDoi(doc.externalIds?.doi) !== sourceDoi) fail('publication-doi-source-mismatch', key);
    if (!work.authorships.some(author => authorMap.has(canonicalOpenAlexId(author.author?.id, 'A'))
        && author.institutions?.some(institutionRef => canonicalOpenAlexId(institutionRef.id, 'I') === institution))) {
      fail('no-source-cohort-authorship-at-otago', key);
    }
    if (authors.length !== mapped.authors.length || authors.some((author, index) => author.name !== mapped.authors[index]?.name)) {
      fail('source-author-order-or-count-mismatch', { id: key, actual: authors.length, expected: mapped.authors.length });
      continue; // Positional identity assertions are unsafe after an order mismatch.
    }
    sourceCheckedAuthorSlots += authors.length;
    for (let index = 0; index < authors.length; index++) {
      const actual = id(authors[index].researcherId);
      const expected = id(mapped.authors[index].researcherId);
      if (expected && !actual) fail('missing-cohort-author-link', { id: key, index, expected });
      else if ((expected || cohortIds.has(actual)) && actual !== expected) {
        fail('incorrect-cohort-author-link', { id: key, index, actual, expected });
      } else if (actual && !expected) warn('non-cohort-link-not-verifiable-from-snapshot', { id: key, index, actual });
    }
  }
  for (const [key, profile] of profileByResearcher) {
    for (const department of new Set((profile.affiliations || []).map(a => a.department || 'Unspecified'))) {
      const group = report.departments[department] ||= { researchers: 0, linkedResearchers: 0, publicationIds: new Set() };
      group.researchers++;
      if (linkedResearchers.has(key)) group.linkedResearchers++;
      for (const publicationId of linkedPublicationIds.get(key) || []) group.publicationIds.add(publicationId);
    }
  }
  for (const group of Object.values(report.departments)) {
    group.publications = group.publicationIds.size; delete group.publicationIds;
  }
  report.counts = { databaseResearchers: researchers.length, databasePublications: publicationIds.length,
    snapshotProfiles: profiles.length, snapshotMatches: matches.length, cohortResearchers: cohortIds.size,
    sourceAuthorIdsIncludingAliases: authorMap.size, uniqueAuditedPublications: publicationScope.size,
    scopedPublicationsFound: publications.length, unrelatedPublications: publicationIds.length - publications.length,
    linkedCohortResearchers: linkedResearchers.size, cohortResearchersWithoutEligiblePublication: cohortIds.size - linkedResearchers.size,
    authorSlots, nullAuthorSlots, sourceCheckedAuthorSlots };
  report.coverage = fieldCoverage(publications);
  report.scopeOutcome = { target: status.target, publications: publications.length,
    targetReached: publications.length >= status.target, shortfall: Math.max(0, status.target - publications.length),
    note: 'Below target is an eligible-corpus outcome, not a data-integrity failure. Null non-cohort author links are expected.' };
  if (publications.length > 8000) fail('publication-scope-exceeds-8000', publications.length);
  if (status.uniqueEligiblePublications !== publications.length) warn('status-and-audit-scope-count-differ', {
    importRun: status.uniqueEligiblePublications, auditedScope: publications.length,
  });
  report.datePrecisionNote = 'Dates are source-reported; OpenAlex calendar-date precision is not independently established.';
  await assertIdle();
  if (await latestSnapshot() !== snapshotName || await fingerprint(tracked) !== before) {
    throw new Error('Inputs changed during verification; discard this report and rerun when idle.');
  }
  report.errorCount = Object.values(report.errors).reduce((sum, value) => sum + value.count, 0);
  report.status = report.errorCount ? 'quality-errors' : 'passed';
  if (report.errorCount) process.exitCode = 1;
} catch (error) {
  report.status = 'verification-unavailable';
  report.error = String(error.message).replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[MongoDB URI redacted]');
  process.exitCode = 1;
} finally {
  if (connection) {
    try { await connection.close(); }
    catch { report.status = 'verification-unavailable'; report.error = 'Unable to close read-only DB connection cleanly.'; process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
}
