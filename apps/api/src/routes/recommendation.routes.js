import { Router } from 'express';
import { parseRecommendationBody, recommendResearchers, unavailable } from '../services/recommendation.service.js';

export function createRecommendationRouter({ enabled = false, inferenceUrl = 'http://127.0.0.1:8100', recommend } = {}) {
  const router = Router();
  const load = recommend || (options => recommendResearchers(options, { inferenceUrl }));
  router.get('/status', (_req, res) => res.json({ data: { enabled, state: enabled ? 'configured' : 'not-connected' } }));
  router.post('/', async (req, res) => {
    const options = parseRecommendationBody(req.body);
    if (!enabled) throw unavailable('AI recommendations are being prepared. Your search results are still available.');
    try { res.json(await load(options)); }
    catch (error) { if (error.status === 400) throw error; throw unavailable(); }
  });
  return router;
}
