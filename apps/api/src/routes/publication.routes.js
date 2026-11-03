import { Router } from 'express';

import {
  getPublicationById,
  getPublications,
  createPublication,
} from '../controllers/publication.controller.js';

const publicationRouter = Router();

publicationRouter.get('/', getPublications);
publicationRouter.get('/:id', getPublicationById);
publicationRouter.post('/', createPublication);

export default publicationRouter;
