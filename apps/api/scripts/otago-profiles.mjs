import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
export function pageLines(raw) {
  const byNumber = new Map();
  for (const line of raw.split('\n')) {
    const match = /^L(\d+): ?(.*)$/.exec(line);
    if (match) byNumber.set(Number(match[1]), match[2]);
  }
  return [...byNumber].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
}

export function cleanText(text) {
  return text.replace(/【\d+†Image:[^】]*】/g, '')
    .replace(/【\d+†([^†】]+)(?:†[^】]*)?】/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

export function cleanName(label, departmentId) {
  let name = cleanText(label).replace(/^(?:Sesquicentennial Distinguished |Distinguished |Associate )?Professor\s+|^Dr\.?\s+/i, '');
  if (departmentId === 'zoology') {
    const [surname, first] = name.split(',').map(x => x.trim());
    if (first) name = `${first} ${surname.toLowerCase().replace(/(^|[ -])[a-z]/g, x => x.toUpperCase()).replace(/^Van /, 'van ')}`;
  }
  return name;
}

function directoryRegion(directory) {
  const lines = pageLines(directory.raw);
  const contentStart = lines.findIndex(x => x === 'On this page ...');
  if (contentStart < 0) throw new Error(`No content marker for ${directory.id}`);
  let text = lines.slice(contentStart + 1).join('\n');
  const stops = {
    computing: '### Fellows', maths: '## Teaching staff',
    biochemistry: '## Teaching-only staff', physics: '## Admin Staff',
    chemistry: '## Research staff', microbiology: '## Teaching-only staff',
    geology: '## Research staff', zoology: '### Emeriti',
  };
  text = text.split(stops[directory.id])[0];
  return text;
}

function inferInterests(id, block) {
  const lines = block.split('\n').map(cleanText).filter(Boolean);
  if (id === 'geology') return lines.filter(x => x.startsWith('* '))
    .map(x => x.slice(2)).filter(x => !/level teaching/i.test(x));
  if (id === 'zoology') {
    return lines.filter(x => !/^(?:[#*]|Email|Please |\(|Professor|Dr)/.test(x))
      .flatMap(x => x.split(/[,;]/)).map(x => x.trim()).filter(Boolean);
  }
  if (id === 'maths') {
    return lines.filter(x => !/^(?:[#*]|\(|Office|Tel|Email|Professor|Dr |Associate|Senior|Lecturer|Director|Head |Fellow |Member |Vice-president|Chair |Coastal People|International Student|Pacific |Disability|Kaia|Kaik|Affiliate|Course |David is|Boris is)/i.test(x))
      .filter(x => !x.includes('@') && !/Sciences Division|Degree Programme/.test(x))
      .flatMap(x => x.split(/[,;]/)).map(x => x.trim()).filter(Boolean);
  }
  return [];
}

export function extractDirectoryProfiles(directory) {
  const body = directoryRegion(directory);
  const links = [...body.matchAll(/【(\d+)†([^†】]+)(?:†[^】]*)?】/g)]
    .filter(m => !m[2].startsWith('Image:'));
  const records = [];
  for (let i = 0; i < links.length; i += 1) {
    const match = links[i];
    const previous = body.slice(0, match.index);
    let block = body.slice(match.index, links[i + 1]?.index ?? body.length).split(/\n#{2,3} /)[0];
    if (directory.id === 'maths') block = block.split('\n* * *')[0];
    const prefix = body.slice(Math.max(0, match.index - 5), match.index);
    let role = '';
    if (directory.id === 'maths') {
      if (!/^(?:Professor|Associate Professor|Dr)\s/.test(match[2])) continue;
    } else if (directory.id === 'zoology') {
      if (!match[2].includes(',')) continue;
      role = match[2].split(',').slice(2).join(',').trim();
    } else {
      if (!prefix.includes('###') && !/Image:[^】]*】$/.test(previous)) continue;
      if (/Emerit|Honorary/i.test(match[2])) continue;
    }
    const firstLines = block.split('\n').slice(1).map(cleanText).filter(Boolean);
    if (directory.id === 'physics' || directory.id === 'chemistry') {
      role = firstLines[0] || '';
      if (!/Professor|Lecturer|Head of Department/.test(role) || /Teaching|Emerit|Honorary|Practice/.test(role)) continue;
    }
    const section = [...previous.matchAll(/^#{2,3} ([^【\n]+)$/gm)].at(-1)?.[1]?.trim() || '';
    if (directory.id === 'maths' && /Directors|Liaison/.test(section)) continue;
    records.push({
      name: cleanName(match[2], directory.id), externalIds: {}, biography: '',
      affiliations: [{ institution: 'University of Otago', department: directory.department, countryCode: 'NZ', isCurrent: true }],
      researchInterests: inferInterests(directory.id, block.split('\n').slice(1).join('\n')),
      lastSyncedAt: directory.retrievedAt,
      _provenance: {
        directoryUrl: directory.url, directoryId: directory.id, directorySection: section,
        directoryLinkId: Number(match[1]), role: role || firstLines[0] || section,
        retrievedAt: directory.retrievedAt, sourceStatus: 'official-directory-verified',
        retrievalMethod: directory.source, officialPublicationDois: [],
      },
    });
  }
  const unique = new Map();
  for (const record of records) {
    const existing = unique.get(record.name);
    if (existing) existing.researchInterests = [...new Set([...existing.researchInterests, ...record.researchInterests])];
    else unique.set(record.name, record);
  }
  return [...unique.values()];
}

function extractSection(lines, pattern) {
  const start = lines.findIndex(line => /^#{1,4} /.test(line) && pattern.test(line));
  if (start < 0) return [];
  const level = lines[start].match(/^#+/)[0].length;
  const output = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = lines[i].match(/^(#+) /);
    if (heading && heading[1].length <= level) break;
    if (heading && /student|post-?doc|opportunit|supervis|publications|contact|teaching/i.test(lines[i])) break;
    if (lines[i].startsWith('### Was this page')) break;
    output.push(lines[i]);
  }
  return output;
}

export function enrichProfile(profile, snapshot) {
  const result = structuredClone(profile);
  if (!snapshot || !snapshot.url || !/\.otago\.ac\.nz(?:\/|$)/.test(snapshot.url)) return result;
  result.profileUrl = snapshot.url;
  result._provenance.profileUrl = snapshot.url;
  const lines = pageLines(snapshot.raw);
  const marker = lines.findIndex(x => x === 'On this page ...');
  const content = marker >= 0 ? lines.slice(marker + 1) : lines;
  const body = content.join('\n');
  result._provenance.profileRetrievedAt = snapshot.retrievedAt;
  if (!body || /Failed to fetch|not accessible via this tool/.test(snapshot.raw)) {
    result._provenance.sourceStatus = 'official-directory-verified-profile-unavailable';
    return result;
  }
  result._provenance.sourceStatus = 'official-directory-and-profile-verified';
  const prePublications = body.split(/^#{1,4} .*Publications.*$/im)[0];
  const orcids = [...new Set(prePublications.match(/\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/g) || [])];
  if (orcids.length === 1) result.externalIds.orcid = orcids[0];
  const interests = extractSection(content, /research interests|research expertise|research areas/i)
    .map(cleanText).filter(Boolean)
    .filter(x => /^(?:\* |#{1,4} )/.test(x) || (x.length < 200 && !/\b(?:I|my|our|we|his|her|research|interested|details|supervise|include)\b/i.test(x)))
    .filter(x => !/^(?:Image:|Email|Tel|Research profile|ORCID|See |For |In particular|Other interests)/i.test(x))
    .filter(x => !/opportunit|postgraduate|supervis|publications|contact|tweets|\bstudents\b|^Figure\s|\b(?:PhD|MSc|BSc|Post-Doc)\b|^Dr\s|interests include|research activities include|^#+.*(?:past|ongoing|current) research activities/i.test(x));
  const summaryIndex = content.findIndex(x => /^Research summary\s*$/.test(x));
  if (summaryIndex >= 0) {
    const summary = content.slice(summaryIndex + 1).find(x => x.trim());
    if (summary && cleanText(summary).length < 200) interests.push(...cleanText(summary).split(/[,;]/));
  }
  if (interests.length) {
    result.researchInterests = [...new Set([...result.researchInterests, ...interests.flatMap(x => x.replace(/^(?:\* |#{1,4} )/, '').split(/[;\n]/))])]
      .map(x => x.trim().replace(/^\d+\.\s*/, '').replace(/\s*\(since[^)]*\)?$/, '').replace(/\s*[–-]\s*see .*/i, ''))
      .filter(x => x.length > 2 && x.length < 200 && !/\b(?:PhD|MSc|BSc|Post-Doc)\b|^Dr\s/i.test(x)).slice(0, 20);
  }
  const bio = extractSection(content, /background and interests|^#+ (?:biography|background)$/i)
    .map(cleanText).filter(x => x && !/^(?:Image:|Email|Tel|\* |#{1,4} )/.test(x));
  let words = 0;
  result.biography = bio.filter(line => {
    const size = line.split(/\s+/).length;
    if (words + size > 24 || /[:?]$/.test(line) || !/[.!]$/.test(line) || /contact|supervis|award|scholar|google|website|publications|opportunit/i.test(line)) return false;
    words += size; return true;
  }).join('\n\n');
  result._provenance.officialPublicationDois = [...new Set(
    [...body.matchAll(/(?:doi(?:\.org\/|:|\s+))\s*(10\.\d{4,9}\/[^\s<>【】†]+)/gi)]
      .map(m => m[1].replace(/[.,;]+$/, '').toLowerCase()),
  )];
  return result;
}

export function collectProfiles(directories, profilePages = []) {
  const lookup = new Map(profilePages.map(p => [`${p.directoryId}:${p.linkId}`, p]));
  return directories.flatMap(extractDirectoryProfiles).map(profile => enrichProfile(profile,
    lookup.get(`${profile._provenance.directoryId}:${profile._provenance.directoryLinkId}`)));
}

export function mergeIdentityReviews(profiles, reviews) {
  for (const review of reviews) {
    const matches = profiles.filter(p => p.name === review.name && p.affiliations.some(a => a.department === review.department));
    if (matches.length !== 1) throw new Error(`Identity review needs one exact roster match: ${review.name}`);
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(review.orcid) || !review.sources?.length || !review.verificationMethod) {
      throw new Error(`Incomplete identity evidence: ${review.name}`);
    }
    const profile = matches[0];
    if (profile.externalIds.orcid && profile.externalIds.orcid !== review.orcid) throw new Error(`Conflicting reviewed ORCID: ${review.name}`);
    profile.externalIds.orcid = review.orcid;
    profile._provenance.identityVerification = { method: review.verificationMethod, sources: review.sources,
      evidence: review.evidence, retrievedDate: review.retrievedDate, rejectedOpenAlex: review.rejectedOpenAlex || [] };
  }
  return profiles;
}

async function main() {
  const directoryPath = resolve(process.argv[2] || 'work/otago/official-directory-pages.json');
  const outputPath = resolve(process.argv[3] || 'work/otago/profiles.json');
  const directories = JSON.parse(await readFile(directoryPath, 'utf8'));
  try {
    directories.find(x => x.id === 'physics').raw += '\n' + await readFile(resolve(dirname(directoryPath), 'official-physics-tail.txt'), 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let pages = [];
  try { pages = JSON.parse(await readFile(resolve(dirname(directoryPath), 'official-profile-pages.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { pages.push(...JSON.parse(await readFile(resolve(dirname(directoryPath), 'official-profile-pages-supplement.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const profiles = collectProfiles(directories, pages);
  for (const filename of ['profile-enrichment-extra.json', 'profile-enrichment-biochemistry.json', 'profile-enrichment-reviewed.json']) {
    let extra = [];
    try { extra = JSON.parse(await readFile(resolve(dirname(directoryPath), filename), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const item of extra) {
      const profile = profiles.find(p => p.name === item.name && p.affiliations.some(a => a.department === item.department));
      if (!profile) continue;
      if (item.profileUrl) profile.profileUrl = item.profileUrl;
      Object.assign(profile.externalIds, item.externalIds || {});
      profile.researchInterests = [...new Set([...profile.researchInterests, ...(item.researchInterests || [])])];
      if (item.biography) profile.biography = item.biography;
      profile._provenance.officialPublicationDois = [...new Set([...profile._provenance.officialPublicationDois, ...(item.officialPublicationDois || [])])];
      profile._provenance.additionalSourceUrls = [...new Set([...(profile._provenance.additionalSourceUrls || []), ...(item.sourceUrls || [])])];
    }
  }
  for (const filename of ['identity-review.json', 'identity-review-approved.json']) {
    try {
      mergeIdentityReviews(profiles, JSON.parse(await readFile(resolve(dirname(directoryPath), filename), 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const profile of profiles) {
    if (!profile.biography && profile.researchInterests.length) {
      const topics = profile.researchInterests.filter(x => x.length < 90).slice(0, 4);
      if (topics.length) {
        profile.biography = `Research interests include ${topics.join('; ')}.`;
        profile._provenance.biographyDerivation = 'Concise summary of explicitly sourced research-interest facts; not a verbatim personal biography.';
      }
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(profiles, null, 2) + '\n');
  const counts = Object.fromEntries(directories.map(d => [d.department, profiles.filter(p => p._provenance.directoryId === d.id).length]));
  console.log(JSON.stringify({ outputPath, profiles: profiles.length, counts, withOrcid: profiles.filter(p => p.externalIds.orcid).length, withProfile: profiles.filter(p => p.profileUrl).length, withInterests: profiles.filter(p => p.researchInterests.length).length }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
