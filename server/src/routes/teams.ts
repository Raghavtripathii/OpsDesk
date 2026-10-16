import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { authenticate, currentUser } from '../middleware/authenticate.js';
import { requireTeamPermission } from '../middleware/teamAccess.js';

const addMemberSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(['member', 'lead', 'admin']),
});

export const teamsRouter = Router();

teamsRouter.use(authenticate);

teamsRouter.get('/:teamId/members', requireTeamPermission('team:view'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, m.role
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND u.is_active
     ORDER BY u.name, u.id
     LIMIT 200`,
    [Number(req.params.teamId)],
  );
  res.json({ members: rows });
});

teamsRouter.post('/:teamId/members', requireTeamPermission('team:manage_members'), async (req, res) => {
  const { userId, role } = addMemberSchema.parse(req.body);
  const teamId = Number(req.params.teamId);

  if (userId === currentUser(req).id && role !== 'admin') {
    throw new AppError(409, 'cannot_demote_self', 'You cannot lower your own role');
  }

  try {
    await pool.query(
      `INSERT INTO memberships (user_id, team_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
      [userId, teamId, role],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23503') {
      throw new AppError(404, 'user_not_found', 'That user does not exist');
    }
    throw err;
  }

  res.json({ userId, teamId, role });
});
