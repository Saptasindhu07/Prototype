import mongoose from 'mongoose';
import { Publication } from '../models/publication.model.js';

export async function getPublications(req, res) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 100);

   if (!Number.isSafeInteger(page) || page < 1
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
      || !Number.isSafeInteger((page - 1) * limit)) {
    return res.status(400).json({
      error: { message: 'page must be a positive integer; limit must be between 1 and 1000.' },
    });
  }

  const publications = await Publication.find()
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({ data: publications, page, limit });
}

export async function getPublicationById(req, res) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return res.status(400).json({ error: { message: 'Invalid publication ID.' } });
  }

  const publication = await Publication.findById(req.params.id).lean();
  if (!publication) {
    return res.status(404).json({ error: { message: 'Publication not found.' } });
  }

  res.status(200).json({ data: publication });
}

export async function createPublication(req, res) {
  if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object'
      || typeof req.body.title !== 'string' || !req.body.title.trim()) {
    return res.status(400).json({ error: { message: 'A non-empty title string is required.' } });
  }

  const { title, abstract, externalIds, authors, year, publicationDate,type,venue,keywords,sourceUrl } = req.body;
  const publication = await Publication.create({
    title, abstract, externalIds, authors, year, publicationDate, type, venue, keywords, sourceUrl
  });

  res.location(`/api/publications/${publication._id}`)
    .status(201)
    .json({ data: publication });
}