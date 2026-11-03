import { readFile, writeFile, mkdir, appendFile, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Publication } from '../src/models/index.js';
import { enrichFromCrossref } from './otago-enrich.mjs';

const directory = fileURLToPath(new URL('../../../work/otago/', import.meta.url));
const state = { startedAt: new Date(), status: 'starting', checked: 0, enriched: 0, changedFields: {}, failures: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastFetch = 0;
let ownsLock = false;
let stopped = false;
async function save() {
  state.updatedAt = new Date();
  await writeFile(`${directory}/enrichment-status.json`, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state));
}
async function cachedFetch(url) {
  const cache = `${directory}/crossref-cache/${createHash('sha256').update(url).digest('hex')}.json`;
  try { return JSON.parse(await readFile(cache, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (stopped) throw new Error('Enrichment stopped');
  await sleep(Math.max(0, 1100 - (Date.now() - lastFetch)));
  lastFetch = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: {
    'User-Agent': 'OtagoResearchPrototype/0.1 (noncommercial bibliographic metadata enrichment)',
  } });
  if ([401, 403, 429].includes(response.status)) { stopped = true; throw new Error(`Crossref HTTP ${response.status}; stopped without bypass.`); }
  if (response.status === 404) { const empty = { status: 'not-found' }; await writeFile(cache, JSON.stringify(empty)); return empty; }
  if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`);
  const data = await response.json();
  await writeFile(cache, JSON.stringify(data));
  return data;
}
try {
  await mkdir(`${directory}/crossref-cache`, { recursive: true });
  const lock = await open(`${directory}/enrichment.lock`, 'wx'); ownsLock = true;
  await lock.writeFile(String(process.pid)); await lock.close();
  const audit = (await readFile(`${directory}/audit.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const ids = [...new Set(audit.filter(a => a.kind === 'publication').map(a => a.publicationId))];
  await connectDatabase();
  const docs = await Publication.find({ _id: { $in: ids }, 'externalIds.doi': { $type: 'string' }, $or: [
    { abstract: '' }, { abstract: { $exists: false } }, { 'venue.publisher': { $exists: false } }, { publicationDate: { $exists: false } },
  ] }).lean();
  state.eligible = docs.length; state.status = 'enriching'; await save();
  for (const doc of docs) {
    if (stopped) break;
    const result = await enrichFromCrossref(doc, cachedFetch);
    state.checked++;
    if (result.skippedReason === 'fetch-failed') state.failures++;
    if (state.failures >= 10) { stopped = true; break; }
    const appliedFields = [];
    for (const field of result.changedFields) {
      const value = field === 'venue.publisher' ? result.publication.venue.publisher : result.publication[field];
      const update = await Publication.updateOne({ _id: doc._id, $or: [
        { [field]: { $exists: false } }, { [field]: null }, ...(field === 'publicationDate' ? [] : [{ [field]: '' }]),
      ] }, { $set: { [field]: value, lastSyncedAt: new Date() } }, { runValidators: true });
      if (update.modifiedCount) { appliedFields.push(field); state.changedFields[field] = (state.changedFields[field] || 0) + 1; }
    }
    if (appliedFields.length) state.enriched++;
    await appendFile(`${directory}/enrichment-audit.jsonl`, JSON.stringify({ at: new Date(), publicationId: doc._id,
      doi: doc.externalIds.doi, sourceUrl: result.sourceUrl, fields: appliedFields, skippedReason: result.skippedReason }) + '\n');
    if (state.checked % 25 === 0) await save();
  }
  const final = await Publication.find({ _id: { $in: ids } }).lean();
  state.coverage = { total: final.length, abstract: final.filter(p => p.abstract?.trim()).length,
    publisher: final.filter(p => p.venue?.publisher).length, doi: final.filter(p => p.externalIds?.doi).length,
    keywords: final.filter(p => p.keywords?.length).length, publicationDate: final.filter(p => p.publicationDate).length };
  state.status = stopped ? 'stopped-for-source-access' : 'complete';
  state.finishedAt = new Date(); await save();
} catch (error) {
  state.status = 'stopped'; state.error = error.message;
  if (ownsLock) await save();
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
  if (ownsLock) await unlink(`${directory}/enrichment.lock`);
}
