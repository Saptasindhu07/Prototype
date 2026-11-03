import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Researcher, Publication } from '../src/models/index.js';
import { mapPublication, canonicalOpenAlexId } from './otago-normalize.mjs';

const directory = fileURLToPath(new URL('../../../work/otago/', import.meta.url));
const readJson = name => readFile(`${directory}/${name}`, 'utf8').then(JSON.parse);
try {
  const profiles = await readJson('profiles.json');
  const audit = (await readFile(`${directory}/audit.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const ownIds = [...new Set(audit.filter(a => a.kind === 'researcher').map(a => a.researcherId))];
  const ownWorks = [...new Set(audit.filter(a => a.kind === 'publication').map(a => a.publicationId))];
  await connectDatabase();
  let updatedProfiles = 0;
  for (const doc of await Researcher.find({ _id: { $in: ownIds } }).lean()) {
    if (+doc.createdAt !== +doc.updatedAt) continue;
    const matches = profiles.filter(p => p.name === doc.name && p.affiliations.some(a => doc.affiliations.some(d => d.department === a.department)));
    if (matches.length !== 1) continue;
    const source = matches[0];
    const updates = { profileUrl: source.profileUrl, researchInterests: source.researchInterests,
      biography: source.biography, lastSyncedAt: new Date() };
    if (source.externalIds?.orcid && !doc.externalIds?.orcid) updates['externalIds.orcid'] = source.externalIds.orcid;
    await new Researcher({ ...doc, ...updates }).validate();
    const result = await Researcher.updateOne({ _id: doc._id, updatedAt: doc.updatedAt }, { $set: updates }, { runValidators: true });
    updatedProfiles += result.modifiedCount;
    if (result.modifiedCount) await appendFile(`${directory}/reconciliation-audit.jsonl`, JSON.stringify({
      at: new Date(), researcherId: doc._id, name: doc.name, sourceUrl: source.profileUrl,
      changedFields: Object.keys(updates), sourceProvenance: source._provenance,
    }) + '\n');
  }
  const researchers = await Researcher.find({ _id: { $in: ownIds } }).lean();
  const researcherMap = new Map(researchers.filter(r => r.externalIds?.openAlex).map(r => [canonicalOpenAlexId(r.externalIds.openAlex, 'A'), r._id]));
  let repairedAuthorLists = 0;
  for (const doc of await Publication.find({ _id: { $in: ownWorks }, 'authors.99': { $exists: true } }).lean()) {
    const url = `https://api.openalex.org/works/${doc.externalIds.openAlex}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Author verification HTTP ${response.status}`);
    const work = await response.json();
    await writeFile(`${directory}/verified-${doc.externalIds.openAlex}.json`, JSON.stringify(work));
    if (work.authorships?.length >= 5000) throw new Error('Single-work response potentially truncated; manual audit required.');
    const mapped = mapPublication(work, researcherMap);
    if (!mapped || mapped.externalIds.openAlex !== doc.externalIds.openAlex) throw new Error('Unable to verify existing author list.');
    await new Publication({ ...doc, authors: mapped.authors }).validate();
    const result = await Publication.updateOne({ _id: doc._id, updatedAt: doc.updatedAt }, { $set: { authors: mapped.authors } }, { runValidators: true });
    repairedAuthorLists += result.modifiedCount;
    await appendFile(`${directory}/reconciliation-audit.jsonl`, JSON.stringify({ at: new Date(), publicationId: doc._id,
      sourceUrl: url, previousAuthors: doc.authors.length, verifiedAuthors: mapped.authors.length, modified: result.modifiedCount }) + '\n');
  }
  console.log(JSON.stringify({ updatedProfiles, repairedAuthorLists }));
} finally { await disconnectDatabase(); }
