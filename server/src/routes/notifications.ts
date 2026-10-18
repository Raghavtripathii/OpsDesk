import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { authenticate, currentUser } from '../middleware/authenticate.js';
import { decodeCursor, encodeCursor, limitSchema } from '../pagination.js';

const listQuerySchema = z.object({
  limit: limitSchema,
  cursor: z.string().max(500).optional(),
  unread: z.enum(['true', 'false']).optional(),
});

const cursorSchema = z.object({ id: z.number().int().positive() });

const readSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }),
]);

const unreadCap = 100;

interface NotificationRow {
  id: number;
  type: string;
  item_id: number | null;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const { limit, cursor, unread } = listQuerySchema.parse(req.query);
  const before = cursor ? decodeCursor(cursor, cursorSchema).id : null;

  const [list, count] = await Promise.all([
    pool.query<NotificationRow>(
      `SELECT n.id, n.type, n.item_id, n.data, n.read_at, n.created_at
       FROM notifications n
       WHERE n.user_id = $1
         AND ($2::bigint IS NULL OR n.id < $2::bigint)
         AND ($3::boolean IS NOT TRUE OR n.read_at IS NULL)
         AND (
           n.item_id IS NULL
           OR EXISTS (
             SELECT 1
             FROM work_items i
             JOIN memberships m ON m.team_id = i.team_id
             WHERE i.id = n.item_id AND m.user_id = n.user_id
           )
         )
       ORDER BY n.id DESC
       LIMIT $4`,
      [user.id, before, unread === undefined ? null : unread === 'true', limit + 1],
    ),
    pool.query<{ total: number }>(
      `SELECT count(*) AS total
       FROM (SELECT 1 FROM notifications WHERE user_id = $1 AND read_at IS NULL LIMIT ${unreadCap}) capped`,
      [user.id],
    ),
  ]);

  const page = list.rows.slice(0, limit);
  const last = page[page.length - 1];

  res.json({
    notifications: page.map((row) => ({
      id: row.id,
      type: row.type,
      itemId: row.item_id,
      data: row.data,
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
    unreadCount: count.rows[0]?.total ?? 0,
    unreadCap,
    nextCursor: list.rows.length > limit && last ? encodeCursor({ id: last.id }) : null,
  });
});

notificationsRouter.post('/read', async (req, res) => {
  const user = currentUser(req);
  const body = readSchema.parse(req.body);

  const result =
    'all' in body
      ? await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [user.id])
      : await pool.query(
          `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])`,
          [user.id, body.ids],
        );

  res.json({ updated: result.rowCount ?? 0 });
});
