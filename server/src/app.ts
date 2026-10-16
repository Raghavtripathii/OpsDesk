import express from 'express';
import { pool } from './db.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
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
  app.use('/api/teams', teamsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
