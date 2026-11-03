import { Router } from 'express';
import healthRoutes from './health.routes.js';
import researcherRouter from './researcher.routes.js';
import publicationRouter from './publication.routes.js';
import discoveryRouter from './discovery.routes.js';
import { createRecommendationRouter } from './recommendation.routes.js';
import { env } from '../config/env.js';

const router = Router();
router.use('/health', healthRoutes);
router.use('/researchers', researcherRouter);
router.use('/publications', publicationRouter);
router.use('/discovery', discoveryRouter);
router.use('/recommendations', createRecommendationRouter({ enabled: env.aiRecommendationsEnabled, inferenceUrl: env.aiInferenceUrl }));

export default router;
