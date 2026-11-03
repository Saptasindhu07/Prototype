import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, extractDirectoryProfiles, enrichProfile } from '../scripts/otago-profiles.mjs';

const raw = lines => lines.map((line, i) => `L${i}: ${line}`).join('\n');
const directory = {
  id: 'chemistry', department: 'Chemistry', url: 'https://www.otago.ac.nz/chemistry/people',
  retrievedAt: '2026-10-23T00:00:00.000Z', source: 'test',
  raw: raw(['On this page ...', '## Academic staff', '### 【1†Professor Example Researcher】', '', 'Professor',
    '### 【2†Emeritus Professor Retired Person】', '', 'Professor',
    '### 【3†Dr Teaching Person】', '', 'Senior Teaching Fellow', '## Research staff']),
};

test('current academic directory membership excludes emeritus and teaching-only staff', () => {
  const profiles = extractDirectoryProfiles(directory);
  assert.deepEqual(profiles.map(p => p.name), ['Example Researcher']);
  assert.equal(profiles[0].affiliations[0].department, 'Chemistry');
  assert.equal(profiles[0].profileUrl, undefined, 'never invent profile links from names');
});

test('names normalize only explicit titles and zoology surname-first ordering', () => {
  assert.equal(cleanName('Associate Professor Jörg Hennig', 'maths'), 'Jörg Hennig');
  assert.equal(cleanName('van HEEZIK, Yolanda, Professor', 'zoology'), 'Yolanda van Heezik');
});

test('profile facts preserve identifiers without leaking student lists or navigation', () => {
  const base = extractDirectoryProfiles(directory)[0];
  const profile = enrichProfile(base, {
    url: 'https://www.otago.ac.nz/chemistry/people/example', retrievedAt: directory.retrievedAt,
    raw: raw(['On this page ...', 'ORCID 0000-0002-3027-3195', '## Research interests',
      '* Quantum chemistry', '### Postgraduate student research opportunities',
      '* Fake research from next section', '## Publications', 'doi: 10.1000/abcd.2020']),
  });
  assert.deepEqual(profile.researchInterests, ['Quantum chemistry']);
  assert.equal(profile.externalIds.orcid, '0000-0002-3027-3195');
  assert.deepEqual(profile._provenance.officialPublicationDois, ['10.1000/abcd.2020']);
});

test('ambiguous multiple ORCIDs are not assigned', () => {
  const base = extractDirectoryProfiles(directory)[0];
  const result = enrichProfile(base, { url: 'https://www.otago.ac.nz/example',
    raw: raw(['On this page ...', 'ORCID 0000-0002-3027-3195 and 0000-0002-2177-5265']) });
  assert.equal(result.externalIds.orcid, undefined);
});

test('unavailable profile retains the observed URL and records failure honestly', () => {
  const base = extractDirectoryProfiles(directory)[0];
  const result = enrichProfile(base, { url: 'https://www.otago.ac.nz/example',
    raw: 'L0: Failed to fetch https://www.otago.ac.nz/example' });
  assert.equal(result.profileUrl, 'https://www.otago.ac.nz/example');
  assert.equal(result.biography, '');
  assert.equal(result._provenance.sourceStatus, 'official-directory-verified-profile-unavailable');
});
