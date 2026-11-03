import mongoose from 'mongoose';

const { Schema } = mongoose;

const optionalId = {
  type: String,
  trim: true,
  set: (value) => {
    if (value == null) return undefined;
    return typeof value === 'string' ? value.trim() || undefined : value;
  },
};

const researcherSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    externalIds: {
      orcid: { ...optionalId },
      openAlex: { ...optionalId },
      semanticScholar: { ...optionalId },
    },
    biography: { type: String, default: '' },
    affiliations: [
      {
        _id: false,
        institution: { type: String, required: true, trim: true },
        department: { type: String, trim: true },
        countryCode: { type: String, uppercase: true, trim: true },
        isCurrent: { type: Boolean, default: true },
      },
    ],
    researchInterests: { type: [String], default: [] },
    profileUrl: { type: String, trim: true },
    lastSyncedAt: Date,
  },
  { timestamps: true, collection: 'researchers' },
);

for (const field of ['orcid', 'openAlex', 'semanticScholar']) {
  const path = `externalIds.${field}`;
  researcherSchema.index(
    { [path]: 1 },
    {
      unique: true,
      partialFilterExpression: { [path]: { $type: 'string' } },
    },
  );
}

researcherSchema.index({ name: 'text', researchInterests: 'text' });
researcherSchema.index({ 'affiliations.institution': 1 });

export const Researcher = mongoose.model('Researcher', researcherSchema);
