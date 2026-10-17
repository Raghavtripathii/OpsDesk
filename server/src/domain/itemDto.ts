import { itemRef, type ItemKind, type ItemPriority, type ItemStatus } from './items.js';
import { itemActions, type Actor } from './workflow.js';

export interface ItemRow {
  id: number;
  team_id: number;
  team_name: string;
  title: string;
  description?: string;
  kind: ItemKind;
  status: ItemStatus;
  priority: ItemPriority;
  requires_approval: boolean;
  reporter_id: number;
  reporter_name: string;
  owner_id: number | null;
  owner_name: string | null;
  due_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  is_overdue: boolean;
  is_stale: boolean;
}

export function toListItem(row: ItemRow) {
  return {
    id: row.id,
    ref: itemRef(row.id),
    title: row.title,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    requiresApproval: row.requires_approval,
    team: { id: row.team_id, name: row.team_name },
    reporter: { id: row.reporter_id, name: row.reporter_name },
    owner: row.owner_id === null ? null : { id: row.owner_id, name: row.owner_name },
    dueAt: row.due_at,
    isOverdue: row.is_overdue,
    isStale: row.is_stale,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  };
}

export function toItemDetail(row: ItemRow, actor: Actor) {
  return {
    ...toListItem(row),
    description: row.description ?? '',
    allowedActions: itemActions(
      {
        status: row.status,
        ownerId: row.owner_id,
        reporterId: row.reporter_id,
        requiresApproval: row.requires_approval,
      },
      actor,
    ),
  };
}
