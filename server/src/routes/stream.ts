import { Router } from 'express';
import { getTeamScope } from '../auth/teamScope.js';
import { authenticate, currentUser } from '../middleware/authenticate.js';
import { addClient } from '../services/realtime.js';

const maxConnectionMs = 15 * 60 * 1000;

export const streamRouter = Router();

streamRouter.get('/', authenticate, async (req, res) => {
  const user = currentUser(req);
  const scope = await getTeamScope(user.id);

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  res.write('retry: 3000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ teamIds: scope.teamIds })}\n\n`);

  const remove = addClient({ userId: user.id, teamIds: new Set(scope.teamIds), res });
  const expiry = setTimeout(() => {
    res.end();
  }, maxConnectionMs);

  req.on('close', () => {
    clearTimeout(expiry);
    remove();
  });
});
