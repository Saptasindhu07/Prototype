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

const publicationSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    abstract: { type: String, default: '' },
    externalIds: {
      doi: { ...optionalId, lowercase: true },
      openAlex: { ...optionalId },
      semanticScholar: { ...optionalId },
    },
    authors: {
      type: [
        {
          _id: false,
          researcherId: {
            type: Schema.Types.ObjectId,
            ref: 'Researcher',
            default: null,
          },
          name: { type: String, required: true, trim: true },
        },
      ],
      default: [],
    },
    year: {
      type: Number,
      min: 1000,
      validate: {
        validator: (value) => value == null || Number.isInteger(value),
        message: 'Year must be an integer',
      },
    },
    publicationDate: Date,
    type: {
      type: String,
      enum: [
        'journal-article',
        'conference-paper',
        'preprint',
        'book-chapter',
        'thesis',
        'other',
      ],
      default: 'other',
    },
    venue: {
      name: { type: String, trim: true },
      publisher: { type: String, trim: true },
    },
    keywords: { type: [String], default: [] },
    sourceUrl: { type: String, trim: true },
    lastSyncedAt: Date,
  },
  { timestamps: true, collection: 'publications' },
);

for (const field of ['doi', 'openAlex', 'semanticScholar']) {
  const path = `externalIds.${field}`;
  publicationSchema.index(
    { [path]: 1 },
    {
      unique: true,
      partialFilterExpression: { [path]: { $type: 'string' } },
    },
  );
}

publicationSchema.index({ 'authors.researcherId': 1, year: -1 });
publicationSchema.index({ title: 'text', abstract: 'text', keywords: 'text' });

export const Publication = mongoose.model('Publication', publicationSchema);
