import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { Researcher, Publication } from '../src/models/index.js';

test('researcher trims values and omits blank external IDs', () => {
  const researcher = new Researcher({
    name: ' Jane Smith ',
    externalIds: { orcid: ' ', openAlex: ' A123 ', semanticScholar: null },
    affiliations: [{ institution: ' University of Auckland ', countryCode: ' nz ' }],
  });
  assert.equal(researcher.validateSync(), undefined);
  assert.equal(researcher.name, 'Jane Smith');
  assert.equal(researcher.externalIds.orcid, undefined);
  assert.equal(researcher.externalIds.openAlex, 'A123');
  assert.equal(researcher.externalIds.semanticScholar, undefined);
  assert.equal(researcher.affiliations[0].countryCode, 'NZ');
  assert.equal(researcher.affiliations[0].isCurrent, true);
  assert.ok(new Researcher({ name: ' ' }).validateSync()?.errors.name);
  assert.ok(new Researcher({ name: 'Jane', affiliations: [{}] }).validateSync());
});

test('publication preserves author order and accepts unlinked authors', () => {
  const researcherId = new mongoose.Types.ObjectId();
  const publication = new Publication({
    title: ' Medical Imaging ',
    externalIds: { doi: ' 10.1234/ABC ', openAlex: '' },
    authors: [{ researcherId, name: 'Jane' }, { name: 'Rahim' }],
  });
  assert.equal(publication.validateSync(), undefined);
  assert.equal(publication.title, 'Medical Imaging');
  assert.equal(publication.externalIds.doi, '10.1234/abc');
  assert.equal(publication.externalIds.openAlex, undefined);
  assert.deepEqual(publication.authors.map((author) => author.name), ['Jane', 'Rahim']);
  assert.ok(publication.authors[0].researcherId.equals(researcherId));
  assert.equal(publication.authors[1].researcherId, null);
  assert.equal(publication.authors[0]._id, undefined);
});

test('publication rejects missing title, invalid authors, years and types', () => {
  assert.ok(new Publication({}).validateSync()?.errors.title);
  assert.ok(new Publication({ title: 'Paper', authors: [{}] }).validateSync());
  for (const year of [999, 2026.5]) {
    assert.ok(new Publication({ title: 'Paper', year }).validateSync()?.errors.year);
  }
  assert.ok(new Publication({ title: 'Paper', type: 'invalid' }).validateSync()?.errors.type);
  assert.equal(new Publication({ title: 'Paper', year: 2026 }).validateSync(), undefined);
});

test('external ID uniqueness is declared with partial indexes for both models', () => {
  for (const Model of [Researcher, Publication]) {
    const indexes = Model.schema.indexes();
    const uniqueIndexes = indexes.filter(([, options]) => options.unique);
    assert.equal(uniqueIndexes.length, 3);
    for (const [keys, options] of uniqueIndexes) {
      const path = Object.keys(keys)[0];
      assert.deepEqual(options.partialFilterExpression, { [path]: { $type: 'string' } });
    }
    assert.equal(indexes.filter(([keys]) => Object.values(keys).includes('text')).length, 1);
    assert.ok(Model.schema.path('createdAt'));
    assert.ok(Model.schema.path('updatedAt'));
  }
});
