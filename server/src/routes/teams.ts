import { Router } from 'express';
import { z } from 'zod';
import type { Role } from '../auth/permissions.js';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { authenticate, currentUser } from '../middleware/authenticate.js';
import { requireTeamPermission } from '../middleware/teamAccess.js';
import { decodeCursor, encodeCursor, limitSchema } from '../pagination.js';
import { createItemHandler } from './items.js';

const addMemberSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(['member', 'lead', 'admin']),
});

const membersQuerySchema = z.object({
  limit: limitSchema,
  cursor: z.string().max(500).optional(),
});

const memberCursorSchema = z.object({
  name: z.string().max(200),
  id: z.number().int().positive(),
});

export const teamsRouter = Router();

teamsRouter.use(authenticate);

teamsRouter.get('/:teamId/members', requireTeamPermission('team:view'), async (req, res) => {
  const { limit, cursor } = membersQuerySchema.parse(req.query);
  const after = cursor ? decodeCursor(cursor, memberCursorSchema) : null;

  const { rows } = await pool.query<{ id: number; name: string; email: string; role: Role }>(
    `SELECT u.id, u.name, u.email, m.role
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1
       AND u.is_active
       AND ($2::text IS NULL OR (u.name, u.id) > ($2::text, $3::bigint))
     ORDER BY u.name, u.id
     LIMIT $4`,
    [Number(req.params.teamId), after?.name ?? null, after?.id ?? null, limit + 1],
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  res.json({
    members: page,
    nextCursor: rows.length > limit && last ? encodeCursor({ name: last.name, id: last.id }) : null,
  });
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

teamsRouter.post('/:teamId/items', requireTeamPermission('item:create'), createItemHandler);
