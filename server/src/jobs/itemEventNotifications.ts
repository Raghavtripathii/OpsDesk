import { z } from 'zod';
import { roleCan, type Role } from '../auth/permissions.js';
import { pool } from '../db.js';
import { itemRef } from '../domain/items.js';

const payloadSchema = z.object({ eventId: z.number().int().positive() });

interface EventContext {
  id: number;
  item_id: number;
  actor_id: number | null;
  type: string;
  data: Record<string, unknown>;
  team_id: number;
  title: string;
  owner_id: number | null;
  reporter_id: number;
  actor_name: string | null;
}

interface Planned {
  userId: number;
  type: string;
  extra: Record<string, unknown>;
}

const approverRoles = (['member', 'lead', 'admin'] as Role[]).filter((role) => roleCan(role, 'item:approve'));

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

async function findApprovers(teamId: number): Promise<number[]> {
  const { rows } = await pool.query<{ user_id: number }>(
    `SELECT m.user_id
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND m.role = ANY($2::text[]) AND u.is_active`,
    [teamId, approverRoles],
  );
  return rows.map((row) => row.user_id);
}

async function commentExcerpt(commentId: number | null): Promise<string> {
  if (commentId === null) return '';
  const { rows } = await pool.query<{ excerpt: string }>('SELECT left(body, 140) AS excerpt FROM comments WHERE id = $1', [
    commentId,
  ]);
  return rows[0]?.excerpt ?? '';
}

async function plan(event: EventContext): Promise<Planned[]> {
  const planned = new Map<string, Planned>();

  const add = (userId: number | null, type: string, extra: Record<string, unknown> = {}) => {
    if (userId === null || userId === event.actor_id) return;
    planned.set(`${userId}:${type}`, { userId, type, extra });
  };

  switch (event.type) {
    case 'comment_added': {
      const excerpt = await commentExcerpt(numberOrNull(event.data.commentId));
      add(event.owner_id, 'comment', { excerpt });
      add(event.reporter_id, 'comment', { excerpt });
      break;
    }
    case 'owner_changed':
      add(numberOrNull(event.data.to), 'assigned');
      add(numberOrNull(event.data.from), 'unassigned');
      break;
    case 'status_changed': {
      const from = String(event.data.from ?? '');
      const to = String(event.data.to ?? '');
      const extra: Record<string, unknown> = { from, to };
      if (typeof event.data.reason === 'string') extra.reason = event.data.reason;

      if (to === 'pending_approval') {
        for (const approverId of await findApprovers(event.team_id)) {
          if (approverId !== event.owner_id && approverId !== event.reporter_id) {
            add(approverId, 'approval_requested', extra);
          }
        }
      } else if (to === 'resolved' || to === 'closed' || to === 'cancelled' || (to === 'in_progress' && from !== 'open')) {
        add(event.owner_id, 'status_changed', extra);
        add(event.reporter_id, 'status_changed', extra);
      } else if (to === 'in_progress' && from === 'open') {
        add(event.reporter_id, 'picked_up', extra);
      }
      break;
    }
    case 'priority_changed':
      if (event.data.to === 'urgent') add(event.owner_id, 'priority_urgent', { from: event.data.from, to: 'urgent' });
      break;
    default:
      break;
  }

  return [...planned.values()];
}

async function stillInTeam(teamId: number, userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const { rows } = await pool.query<{ user_id: number }>(
    `SELECT m.user_id
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 AND m.user_id = ANY($2::bigint[]) AND u.is_active`,
    [teamId, userIds],
  );
  return new Set(rows.map((row) => row.user_id));
}

export async function handleItemEvent(rawPayload: Record<string, unknown>): Promise<void> {
  const { eventId } = payloadSchema.parse(rawPayload);

  const { rows } = await pool.query<EventContext>(
    `SELECT e.id, e.item_id, e.actor_id, e.type, e.data,
            i.team_id, i.title, i.owner_id, i.reporter_id, u.name AS actor_name
     FROM work_item_events e
     JOIN work_items i ON i.id = e.item_id
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.id = $1`,
    [eventId],
  );

  const event = rows[0];
  if (!event) throw new Error(`Event ${eventId} does not exist`);

  const planned = await plan(event);
  const members = await stillInTeam(
    event.team_id,
    planned.map((entry) => entry.userId),
  );
  const deliverable = planned.filter((entry) => members.has(entry.userId));
  if (deliverable.length === 0) return;

  const snapshot = { itemRef: itemRef(event.item_id), title: event.title, actorName: event.actor_name };

  await pool.query(
    `INSERT INTO notifications (user_id, item_id, type, data, dedupe_key)
     SELECT n.user_id, $1::bigint, n.type, n.data::jsonb, 'event:' || $2::text || ':' || n.type
     FROM unnest($3::bigint[], $4::text[], $5::text[]) AS n(user_id, type, data)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [
      event.item_id,
      event.id,
      deliverable.map((entry) => entry.userId),
      deliverable.map((entry) => entry.type),
      deliverable.map((entry) => JSON.stringify({ ...snapshot, ...entry.extra })),
    ],
  );
}
