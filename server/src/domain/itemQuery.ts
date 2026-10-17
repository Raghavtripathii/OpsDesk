import { z } from 'zod';
import type { TeamScope } from '../auth/teamScope.js';
import { staleAfterDays, type ItemKind, type ItemPriority, type ItemStatus } from './items.js';

export const listViews = ['all', 'mine', 'unassigned', 'overdue', 'stale', 'awaiting_approval'] as const;
export type ListView = (typeof listViews)[number];

export const attentionCap = 1000;

const sortNames = ['activity_desc', 'due_asc', 'quiet_asc'] as const;
export type SortName = (typeof sortNames)[number];

const sorts: Record<SortName, { column: string; direction: 'ASC' | 'DESC' }> = {
  activity_desc: { column: 'i.last_activity_at', direction: 'DESC' },
  due_asc: { column: 'i.due_at', direction: 'ASC' },
  quiet_asc: { column: 'i.last_activity_at', direction: 'ASC' },
};

const timestampText = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?)?$/;

export const listCursorSchema = z.object({
  s: z.enum(sortNames),
  t: z.string().regex(timestampText),
  id: z.number().int().positive(),
});

export type ListCursor = z.infer<typeof listCursorSchema>;

export interface ListFilters {
  view: ListView;
  teamId?: number;
  statuses?: ItemStatus[];
  priorities?: ItemPriority[];
  kinds?: ItemKind[];
  ownerId?: number;
  search?: string;
}

export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const activeStatuses = `('open', 'in_progress', 'pending_approval')`;

export const itemJoins = `
  JOIN teams t ON t.id = i.team_id
  JOIN users rep ON rep.id = i.reporter_id
  LEFT JOIN users own ON own.id = i.owner_id`;

export function itemSelect(withDescription: boolean): string {
  const description = withDescription ? 'i.description, ' : '';
  return `i.id, i.team_id, t.name AS team_name, i.title, ${description}i.kind, i.status, i.priority, i.requires_approval,
    i.reporter_id, rep.name AS reporter_name, i.owner_id, own.name AS owner_name,
    i.due_at, i.version, i.created_at, i.updated_at, i.last_activity_at,
    (i.due_at IS NOT NULL AND i.due_at < now() AND i.status IN ${activeStatuses}) AS is_overdue,
    (i.status IN ('open', 'in_progress') AND i.last_activity_at < now() - interval '${staleAfterDays} days') AS is_stale`;
}

export function sortForView(view: ListView): SortName {
  if (view === 'overdue') return 'due_asc';
  if (view === 'stale') return 'quiet_asc';
  return 'activity_desc';
}

export function viewConditions(view: ListView, userId: number, scope: TeamScope, params: Params): string[] {
  const conditions = [`i.team_id = ANY(${params.add(scope.teamIds)}::bigint[])`];

  switch (view) {
    case 'mine':
      conditions.push(`i.owner_id = ${params.add(userId)}`, `i.status IN ('in_progress', 'pending_approval')`);
      break;
    case 'unassigned':
      conditions.push(`i.status = 'open'`);
      break;
    case 'overdue':
      conditions.push('i.due_at < now()', `i.status IN ${activeStatuses}`);
      break;
    case 'stale':
      conditions.push(
        `i.status IN ('open', 'in_progress')`,
        `i.last_activity_at < now() - interval '${staleAfterDays} days'`,
      );
      break;
    case 'awaiting_approval':
      conditions.push(
        `i.status = 'pending_approval'`,
        `i.team_id = ANY(${params.add(scope.approverTeamIds)}::bigint[])`,
        `i.owner_id <> ${params.add(userId)}`,
        `i.reporter_id <> ${params.add(userId)}`,
      );
      break;
    case 'all':
      break;
  }

  return conditions;
}

export interface ListQueryArgs {
  userId: number;
  scope: TeamScope;
  filters: ListFilters;
  sort: SortName;
  cursor?: ListCursor;
  limit: number;
}

export function buildListQuery(args: ListQueryArgs) {
  const params = new Params();
  const { filters, sort: sortName, cursor, limit } = args;
  const where = viewConditions(filters.view, args.userId, args.scope, params);

  if (filters.teamId !== undefined) where.push(`i.team_id = ${params.add(filters.teamId)}`);
  if (filters.statuses?.length) where.push(`i.status = ANY(${params.add(filters.statuses)}::text[])`);
  if (filters.priorities?.length) where.push(`i.priority = ANY(${params.add(filters.priorities)}::text[])`);
  if (filters.kinds?.length) where.push(`i.kind = ANY(${params.add(filters.kinds)}::text[])`);
  if (filters.ownerId !== undefined) where.push(`i.owner_id = ${params.add(filters.ownerId)}`);
  if (filters.search) {
    where.push(`i.search_vector @@ websearch_to_tsquery('english', ${params.add(filters.search)}::text)`);
  }

  const sort = sorts[sortName];

  if (cursor) {
    const comparison = sort.direction === 'DESC' ? '<' : '>';
    where.push(
      `(${sort.column}, i.id) ${comparison} (${params.add(cursor.t)}::timestamptz, ${params.add(cursor.id)}::bigint)`,
    );
  }

  const limitParam = params.add(limit + 1);

  const text = `SELECT ${itemSelect(false)}, ${sort.column}::text AS cursor_key
    FROM work_items i ${itemJoins}
    WHERE ${where.join(' AND ')}
    ORDER BY ${sort.column} ${sort.direction}, i.id ${sort.direction}
    LIMIT ${limitParam}`;

  return { text, values: params.values };
}

export function buildCountQuery(view: ListView, userId: number, scope: TeamScope, extra: string[] = []) {
  const params = new Params();
  const where = [...viewConditions(view, userId, scope, params), ...extra];
  const cap = params.add(attentionCap);

  const text = `SELECT count(*) AS total
    FROM (SELECT 1 FROM work_items i WHERE ${where.join(' AND ')} LIMIT ${cap}) capped`;

  return { text, values: params.values };
}
