import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCandidates, normalizeName, sampleEvidenceDois } from '../scripts/otago-match-authors.mjs';

const profile = { name: 'Example Researcher', profileUrl: 'https://www.otago.ac.nz/example',
  researchInterests: ['Genomics cancer transcriptomics'], externalIds: {} };
const author = { id: 'https://openalex.org/A1', display_name: 'Example Researcher',
  affiliations: [{ institution: { id: 'https://openalex.org/I80281795' } }],
  topics: [{ display_name: 'Genomics cancer transcriptomics' }], works_count: 10 };

test('names normalize titles, accents and punctuation only', () => {
  assert.equal(normalizeName('Professor René A. Example'), 'rene a example');
  assert.notEqual(normalizeName('Jane Example'), normalizeName('John Example'));
});
test('exact name and institution alone do not verify an identity', () => {
  assert.equal(classifyCandidates({ ...profile, researchInterests: [] }, [author]).authorId, undefined);
});
test('exact name, institution and three specific interest terms qualify', () => {
  assert.equal(classifyCandidates(profile, [author]).authorId, 'A1');
});
test('official DOI authorship qualifies exact names with an institution', () => {
  const match = classifyCandidates({ ...profile, researchInterests: [] }, [author], new Map([['10.1234/example', ['A1']]]));
  assert.equal(match.authorId, 'A1');
  assert.equal(match.method, 'exact-name-institution-official-doi');
});
test('conflicting ORCID prevents name-based match', () => {
  const match = classifyCandidates({ ...profile, externalIds: { orcid: '0000-0001-0000-0001' } },
    [{ ...author, orcid: 'https://orcid.org/0000-0002-0000-0002' }]);
  assert.equal(match.authorId, undefined);
});
test('multiple same-name candidates without shared ORCID stay ambiguous', () => {
  const match = classifyCandidates(profile, [author, { ...author, id: 'https://openalex.org/A2' }]);
  assert.equal(match.reason, 'ambiguous-qualified-candidates');
});
test('exact official ORCID aliases kept with one primary ID', () => {
  const orcid = '0000-0001-0000-0001';
  const match = classifyCandidates({ ...profile, externalIds: { orcid } },
    [{ ...author, orcid, works_count: 5 }, { ...author, orcid, id: 'https://openalex.org/A2', works_count: 20 }]);
  assert.equal(match.authorId, 'A2');
  assert.deepEqual(match.aliases, ['A1']);
  assert.equal(match.method, 'official-orcid');
});
test('official ORCID takes precedence over a same-name no-ORCID fragment', () => {
  const orcid = '0000-0001-0000-0001';
  const match = classifyCandidates({ ...profile, externalIds: { orcid } },
    [{ ...author, orcid }, { ...author, id: 'https://openalex.org/A2' }]);
  assert.equal(match.authorId, 'A1');
  assert.deepEqual(match.aliases, []);
});
test('nullable source institution and name identifiers do not crash matching', () => {
  const match = classifyCandidates(profile, [{ ...author, raw_author_names: [null],
    last_known_institutions: [{ id: null }], affiliations: [{ institution: { id: null } }] }]);
  assert.equal(match.authorId, undefined);
  assert.equal(normalizeName(null), '');
});
test('identity evidence samples recent, middle and older official DOIs without duplication', () => {
  const result = sampleEvidenceDois({ _provenance: { officialPublicationDois: Array.from({ length: 20 }, (_, index) => `10.1234/${index}`) } });
  assert.equal(result.length, 9);
  assert.ok(result.includes('10.1234/0'));
  assert.ok(result.includes('10.1234/10'));
  assert.ok(result.includes('10.1234/19'));
});
