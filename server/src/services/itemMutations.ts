import type pg from 'pg';
import type { Role } from '../auth/permissions.js';
import { withTransaction } from '../db.js';
import type { ItemKind, ItemPriority, ItemStatus } from '../domain/items.js';
import {
  activeStatuses,
  checkTransition,
  lockedStatuses,
  mayAssign,
  mayChangePriority,
  mayEditDetails,
  type Actor,
  type TransitionAction,
  type WorkflowItem,
} from '../domain/workflow.js';
import { AppError } from '../errors.js';
import { getItem, loadItemForUser } from './itemService.js';

type EventType = 'status_changed' | 'owner_changed' | 'priority_changed' | 'due_date_changed' | 'details_edited';
type Column = 'title' | 'description' | 'due_at' | 'priority' | 'owner_id' | 'status';

interface Change {
  set: Partial<Record<Column, unknown>>;
  events: Array<{ type: EventType; data: Record<string, unknown> }>;
}

interface LockedItem {
  id: number;
  team_id: number;
  title: string;
  description: string;
  kind: ItemKind;
  status: ItemStatus;
  priority: ItemPriority;
  requires_approval: boolean;
  reporter_id: number;
  owner_id: number | null;
  due_at: Date | null;
  version: number;
}

type Plan = (item: LockedItem, actor: Actor, client: pg.PoolClient) => Promise<Change | null>;

class VersionMismatch extends Error {}

const writableColumns: readonly string[] = ['title', 'description', 'due_at', 'priority', 'owner_id', 'status'];

function toWorkflow(item: LockedItem): WorkflowItem {
  return {
    status: item.status,
    ownerId: item.owner_id,
    reporterId: item.reporter_id,
    requiresApproval: item.requires_approval,
  };
}

async function writeChange(client: pg.PoolClient, itemId: number, actorId: number, change: Change) {
  const entries = Object.entries(change.set);

  const assignments = entries.map(([column], index) => {
    if (!writableColumns.includes(column)) throw new Error(`Column ${column} is not writable`);
    return `${column} = $${index + 2}`;
  });

  await client.query(
    `UPDATE work_items
     SET ${assignments.join(', ')},
         version = version + 1,
         updated_at = clock_timestamp(),
         last_activity_at = GREATEST(last_activity_at, clock_timestamp())
     WHERE id = $1`,
    [itemId, ...entries.map(([, value]) => value)],
  );

  const values: unknown[] = [];
  const rows = change.events.map((event) => {
    values.push(itemId, actorId, event.type, JSON.stringify(event.data));
    const base = values.length - 4;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, clock_timestamp())`;
  });

  await client.query(
    `INSERT INTO work_item_events (item_id, actor_id, type, data, created_at) VALUES ${rows.join(', ')}`,
    values,
  );
}

async function runMutation(itemId: number, userId: number, expectedVersion: number, plan: Plan) {
  const { role } = await loadItemForUser(itemId, userId, 'item:view');
  const actor: Actor = { userId, role: role as Role };

  try {
    const changed = await withTransaction(async (client) => {
      const locked = await client.query<LockedItem>(
        `SELECT id, team_id, title, description, kind, status, priority, requires_approval,
                reporter_id, owner_id, due_at, version
         FROM work_items
         WHERE id = $1
         FOR UPDATE`,
        [itemId],
      );

      const item = locked.rows[0];
      if (!item) throw new AppError(404, 'not_found', 'Work item not found');
      if (item.version !== expectedVersion) throw new VersionMismatch();

      const change = await plan(item, actor, client);
      if (!change) return false;

      await writeChange(client, itemId, userId, change);
      return true;
    });

    return { item: await getItem(itemId, userId), changed };
  } catch (err) {
    if (err instanceof VersionMismatch) {
      const current = await getItem(itemId, userId);
      throw new AppError(409, 'version_conflict', 'This item was changed by someone else since you loaded it', {
        yourVersion: expectedVersion,
        currentVersion: current.version,
        current,
      });
    }
    throw err;
  }
}

export interface DetailsInput {
  title?: string;
  description?: string;
  dueAt?: string | null;
}

export function editDetails(itemId: number, userId: number, expectedVersion: number, input: DetailsInput) {
  return runMutation(itemId, userId, expectedVersion, async (item, actor) => {
    if (!mayEditDetails(actor, toWorkflow(item))) {
      throw new AppError(403, 'forbidden', 'You can only edit items you own or reported');
    }
    if (lockedStatuses.includes(item.status)) {
      throw new AppError(409, 'item_locked', 'Closed and cancelled items cannot be edited', {
        status: item.status,
      });
    }

    const change: Change = { set: {}, events: [] };
    const fields: string[] = [];
    const data: Record<string, unknown> = {};

    if (input.title !== undefined && input.title !== item.title) {
      change.set.title = input.title;
      fields.push('title');
      data.title = { from: item.title, to: input.title };
    }

    if (input.description !== undefined && input.description !== item.description) {
      change.set.description = input.description;
      fields.push('description');
    }

    if (fields.length > 0) {
      change.events.push({ type: 'details_edited', data: { fields, ...data } });
    }

    if (input.dueAt !== undefined) {
      const current = item.due_at ? item.due_at.toISOString() : null;
      const next = input.dueAt ? new Date(input.dueAt).toISOString() : null;
      if (current !== next) {
        change.set.due_at = next;
        change.events.push({ type: 'due_date_changed', data: { from: current, to: next } });
      }
    }

    return change.events.length > 0 ? change : null;
  });
}

export function assignItem(itemId: number, userId: number, expectedVersion: number, ownerId: number) {
  return runMutation(itemId, userId, expectedVersion, async (item, actor, client) => {
    if (!mayAssign(actor)) {
      throw new AppError(403, 'forbidden', 'Only leads and admins can assign items');
    }
    if (!activeStatuses.includes(item.status)) {
      throw new AppError(409, 'item_not_assignable', 'Only open or active items can be assigned', {
        status: item.status,
      });
    }
    if (item.owner_id === ownerId) return null;

    const member = await client.query(
      `SELECT 1
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.team_id = $2 AND u.is_active`,
      [ownerId, item.team_id],
    );
    if (member.rowCount === 0) {
      throw new AppError(422, 'invalid_assignee', 'That person is not an active member of this team');
    }

    const change: Change = {
      set: { owner_id: ownerId },
      events: [{ type: 'owner_changed', data: { from: item.owner_id, to: ownerId } }],
    };

    if (item.status === 'open') {
      change.set.status = 'in_progress';
      change.events.push({
        type: 'status_changed',
        data: { from: 'open', to: 'in_progress', action: 'assign' },
      });
    }

    return change;
  });
}

export function changePriority(itemId: number, userId: number, expectedVersion: number, priority: ItemPriority) {
  return runMutation(itemId, userId, expectedVersion, async (item, actor) => {
    if (!mayChangePriority(actor)) {
      throw new AppError(403, 'forbidden', 'Only leads and admins can change priority');
    }
    if (!activeStatuses.includes(item.status)) {
      throw new AppError(409, 'item_not_active', 'Priority can only change on open or active items', {
        status: item.status,
      });
    }
    if (item.priority === priority) return null;

    return {
      set: { priority },
      events: [{ type: 'priority_changed', data: { from: item.priority, to: priority } }],
    };
  });
}

export function transitionItem(
  itemId: number,
  userId: number,
  expectedVersion: number,
  action: TransitionAction,
  reason?: string,
) {
  return runMutation(itemId, userId, expectedVersion, async (item, actor) => {
    const check = checkTransition(action, actor, toWorkflow(item));
    if (!check.ok) throw new AppError(check.httpStatus, check.code, check.message, check.details);

    const cleanReason = reason?.trim();
    if (check.needsReason && (!cleanReason || cleanReason.length < 3)) {
      throw new AppError(400, 'reason_required', 'A reason of at least 3 characters is required for this action');
    }

    const statusData: Record<string, unknown> = { from: item.status, to: check.to, action };
    if (cleanReason) statusData.reason = cleanReason;

    const change: Change = { set: { status: check.to }, events: [] };

    if (action === 'release') {
      change.set.owner_id = null;
      change.events.push({ type: 'owner_changed', data: { from: item.owner_id, to: null } });
    }

    change.events.push({ type: 'status_changed', data: statusData });
    return change;
  });
}
