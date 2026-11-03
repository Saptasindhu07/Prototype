import mongoose from 'mongoose';
import { Researcher } from '../models/researcher.model.js';

export async function getResearchers(req, res) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);

  if (!Number.isSafeInteger(page) || page < 1
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger((page - 1) * limit)) {
    return res.status(400).json({
      error: { message: 'page must be a positive integer; limit must be between 1 and 100.' },
    });
  }

  const researchers = await Researcher.find()
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({ data: researchers, page, limit });
}

export async function getResearcherById(req, res) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return res.status(400).json({ error: { message: 'Invalid researcher ID.' } });
  }

  const researcher = await Researcher.findById(req.params.id).lean();
  if (!researcher) {
    return res.status(404).json({ error: { message: 'Researcher not found.' } });
  }

  res.status(200).json({ data: researcher });
}

export async function createResearcher(req, res) {
  if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object'
      || typeof req.body.name !== 'string' || !req.body.name.trim()) {
    return res.status(400).json({ error: { message: 'A non-empty name string is required.' } });
  }

  
  const { name, externalIds, biography, affiliations, researchInterests, profileUrl } = req.body;
  const researcher = await Researcher.create({
    name, externalIds, biography, affiliations, researchInterests, profileUrl,
  });

  res.location(`/api/researchers/${researcher._id}`)
    .status(201)
    .json({ data: researcher });
}
