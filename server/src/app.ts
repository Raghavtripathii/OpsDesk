import express from 'express';
import { pool } from './db.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { authenticate } from './middleware/authenticate.js';
import { idempotency } from './middleware/idempotency.js';
import { attentionRouter } from './routes/attention.js';
import { authRouter } from './routes/auth.js';
import { itemsRouter } from './routes/items.js';
import { teamsRouter } from './routes/teams.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/teams', authenticate, idempotency, teamsRouter);
  app.use('/api/items', authenticate, idempotency, itemsRouter);
  app.use('/api/attention', attentionRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
