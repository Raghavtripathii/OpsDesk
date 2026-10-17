import { z } from 'zod';
import { roleCan, type Permission, type Role } from '../auth/permissions.js';
import { getTeamScope } from '../auth/teamScope.js';
import { pool, withTransaction } from '../db.js';
import { toItemDetail, toListItem, type ItemRow } from '../domain/itemDto.js';
import {
  buildListQuery,
  itemJoins,
  itemSelect,
  listCursorSchema,
  sortForView,
  type ListFilters,
} from '../domain/itemQuery.js';
import { approvalRequiredFor, type ItemKind, type ItemPriority } from '../domain/items.js';
import { AppError } from '../errors.js';
import { decodeCursor, encodeCursor } from '../pagination.js';

type ListRow = ItemRow & { cursor_key: string };

interface TimelineRow {
  id: number;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
  actor_id: number | null;
  actor_name: string | null;
  comment_body: string | null;
}

const timelineCursorSchema = z.object({ id: z.number().int().positive() });

export interface NewItemInput {
  title: string;
  description: string;
  kind: ItemKind;
  priority: ItemPriority;
  dueAt: string | null;
}

export async function loadItemForUser(itemId: number, userId: number, permission: Permission) {
  const { rows } = await pool.query<ItemRow & { viewer_role: Role }>(
    `SELECT ${itemSelect(true)}, m.role AS viewer_role
     FROM work_items i ${itemJoins}
     JOIN memberships m ON m.team_id = i.team_id AND m.user_id = $2
     WHERE i.id = $1`,
    [itemId, userId],
  );

  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Work item not found');
  if (!roleCan(row.viewer_role, permission)) {
    throw new AppError(403, 'forbidden', 'Your role does not allow this action');
  }

  return { row, role: row.viewer_role };
}

export async function getItem(itemId: number, userId: number) {
  const { row, role } = await loadItemForUser(itemId, userId, 'item:view');
  return toItemDetail(row, { userId, role });
}

export async function createItem(userId: number, teamId: number, input: NewItemInput) {
  const id = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO work_items (team_id, title, description, kind, priority, requires_approval, reporter_id, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       RETURNING id`,
      [
        teamId,
        input.title,
        input.description,
        input.kind,
        input.priority,
        approvalRequiredFor(input.kind),
        userId,
        input.dueAt,
      ],
    );

    const created = inserted.rows[0];
    if (!created) throw new Error('Insert did not return a row');

    await client.query(
      `INSERT INTO work_item_events (item_id, actor_id, type, data)
       VALUES ($1, $2, 'created', $3::jsonb)`,
      [created.id, userId, JSON.stringify({ kind: input.kind, priority: input.priority, dueAt: input.dueAt })],
    );

    return created.id;
  });

  return getItem(id, userId);
}

export async function listItemsForUser(userId: number, filters: ListFilters, limit: number, rawCursor?: string) {
  const sort = sortForView(filters.view);
  const cursor = rawCursor ? decodeCursor(rawCursor, listCursorSchema) : undefined;

  if (cursor && cursor.s !== sort) {
    throw new AppError(400, 'invalid_cursor', 'The cursor does not belong to this view');
  }

  const scope = await getTeamScope(userId);
  const { text, values } = buildListQuery({ userId, scope, filters, sort, cursor, limit });
  const { rows } = await pool.query<ListRow>(text, values);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ s: sort, t: last.cursor_key, id: last.id }) : null;

  return { items: page.map(toListItem), nextCursor };
}

export async function claimItem(itemId: number, userId: number) {
  const { role } = await loadItemForUser(itemId, userId, 'item:claim');

  const changed = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE work_items
       SET owner_id = $2, status = 'in_progress', version = version + 1, updated_at = now(), last_activity_at = now()
       WHERE id = $1 AND status = 'open' AND owner_id IS NULL`,
      [itemId, userId],
    );

    if (result.rowCount === 0) return false;

    await client.query(
      `INSERT INTO work_item_events (item_id, actor_id, type, data)
       VALUES ($1, $2, 'owner_changed', $3::jsonb), ($1, $2, 'status_changed', $4::jsonb)`,
      [
        itemId,
        userId,
        JSON.stringify({ from: null, to: userId }),
        JSON.stringify({ from: 'open', to: 'in_progress' }),
      ],
    );

    return true;
  });

  const { row } = await loadItemForUser(itemId, userId, 'item:view');

  if (!changed && row.owner_id !== userId) {
    if (row.owner_id === null) {
      throw new AppError(409, 'not_claimable', 'Only open, unassigned items can be claimed', {
        status: row.status,
      });
    }
    throw new AppError(409, 'already_claimed', `${row.owner_name} already owns this item`, {
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      status: row.status,
    });
  }

  return { item: toItemDetail(row, { userId, role }), changed };
}

export async function addComment(itemId: number, author: { id: number; name: string }, body: string) {
  await loadItemForUser(itemId, author.id, 'item:comment');

  const comment = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: number; created_at: Date }>(
      `INSERT INTO comments (item_id, author_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [itemId, author.id, body],
    );

    const row = inserted.rows[0];
    if (!row) throw new Error('Insert did not return a row');

    await client.query(
      `INSERT INTO work_item_events (item_id, actor_id, type, data)
       VALUES ($1, $2, 'comment_added', $3::jsonb)`,
      [itemId, author.id, JSON.stringify({ commentId: row.id })],
    );

    await client.query(
      `UPDATE work_items SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1`,
      [itemId],
    );

    return row;
  });

  return {
    id: comment.id,
    itemId,
    body,
    createdAt: comment.created_at,
    author: { id: author.id, name: author.name },
  };
}

export async function listTimeline(itemId: number, userId: number, limit: number, rawCursor?: string) {
  await loadItemForUser(itemId, userId, 'item:view');

  const before = rawCursor ? decodeCursor(rawCursor, timelineCursorSchema).id : null;

  const { rows } = await pool.query<TimelineRow>(
    `SELECT e.id, e.type, e.data, e.created_at, e.actor_id, u.name AS actor_name, c.body AS comment_body
     FROM work_item_events e
     LEFT JOIN users u ON u.id = e.actor_id
     LEFT JOIN comments c ON e.type = 'comment_added' AND c.id = (e.data->>'commentId')::bigint
     WHERE e.item_id = $1 AND ($2::bigint IS NULL OR e.id < $2::bigint)
     ORDER BY e.id DESC
     LIMIT $3`,
    [itemId, before, limit + 1],
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  const personIds = new Set<number>();
  for (const event of page) {
    if (event.type !== 'owner_changed') continue;
    for (const key of ['from', 'to']) {
      const value = event.data[key];
      if (typeof value === 'number') personIds.add(value);
    }
  }

  const people: Record<string, string> = {};
  if (personIds.size > 0) {
    const names = await pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM users WHERE id = ANY($1::bigint[])',
      [[...personIds]],
    );
    for (const person of names.rows) people[String(person.id)] = person.name;
  }

  return {
    events: page.map((event) => ({
      id: event.id,
      type: event.type,
      data: event.data,
      createdAt: event.created_at,
      actor: event.actor_id === null ? null : { id: event.actor_id, name: event.actor_name },
      comment: event.comment_body,
    })),
    people,
    nextCursor: rows.length > limit && last ? encodeCursor({ id: last.id }) : null,
  };
}
