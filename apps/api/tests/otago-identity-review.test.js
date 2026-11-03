import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeIdentityReviews } from '../scripts/otago-profiles.mjs';

const profile = () => ({ name: 'Bruce Russell', affiliations: [{ department: 'Microbiology and Immunology' }], externalIds: {}, _provenance: {} });
const review = { name: 'Bruce Russell', department: 'Microbiology and Immunology', orcid: '0000-0003-2333-4348',
  sources: ['https://journals.asm.org/doi/abs/10.1128/aac.00280-24'], verificationMethod: 'primary-publisher-author-ORCID' };

test('identity review uses exact name and department and preserves source attribution', () => {
  const records = [profile(), { ...profile(), affiliations: [{ department: 'Pharmacy' }] }];
  mergeIdentityReviews(records, [review]);
  assert.equal(records[0].externalIds.orcid, review.orcid);
  assert.equal(records[0]._provenance.identityVerification.method, review.verificationMethod);
  assert.equal(records[1].externalIds.orcid, undefined);
});
test('identity review refuses conflicting existing ORCID', () => {
  const record = profile();
  record.externalIds.orcid = '0000-0001-6935-1974';
  assert.throws(() => mergeIdentityReviews([record], [review]), /Conflicting reviewed ORCID/);
});
test('identity review refuses ambiguous roster records or missing source evidence', () => {
  assert.throws(() => mergeIdentityReviews([profile(), profile()], [review]), /one exact roster match/);
  assert.throws(() => mergeIdentityReviews([profile()], [{ ...review, sources: [] }]), /Incomplete identity evidence/);
});
