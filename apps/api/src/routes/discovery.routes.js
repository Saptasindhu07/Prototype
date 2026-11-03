import { Router } from 'express';
import { discover, discoverySummary, parseDiscoveryQuery } from '../services/discovery.service.js';

const router = Router();
router.get('/summary', async (_req, res) => res.json({ data: await discoverySummary() }));
router.get('/', async (req, res) => res.json(await discover(parseDiscoveryQuery(req.query))));
export default router;
