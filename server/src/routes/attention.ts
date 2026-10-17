import { Router } from 'express';
import { authenticate, currentUser } from '../middleware/authenticate.js';
import { getAttentionSummary } from '../services/attentionService.js';

export const attentionRouter = Router();

attentionRouter.get('/', authenticate, async (req, res) => {
  res.json(await getAttentionSummary(currentUser(req).id));
});
