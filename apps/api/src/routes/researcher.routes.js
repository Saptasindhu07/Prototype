import { Router } from 'express';
import {
  createResearcher,
  getResearcherById,
  getResearchers,
} from '../controllers/researcher.controller.js';

const researcherRouter = Router();

researcherRouter.get('/', getResearchers);
researcherRouter.get('/:id', getResearcherById);
researcherRouter.post('/', createResearcher);

export default researcherRouter;
