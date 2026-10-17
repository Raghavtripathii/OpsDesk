import { roleCan, type Role } from '../auth/permissions.js';
import { itemRef, type ItemKind, type ItemPriority, type ItemStatus } from './items.js';

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

export type ItemAction = 'comment' | 'claim';

export function allowedActions(item: Pick<ItemRow, 'status' | 'owner_id'>, role: Role): ItemAction[] {
  const actions: ItemAction[] = [];
  if (roleCan(role, 'item:comment')) actions.push('comment');
  if (item.status === 'open' && item.owner_id === null && roleCan(role, 'item:claim')) actions.push('claim');
  return actions;
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

export function toItemDetail(row: ItemRow, role: Role) {
  return {
    ...toListItem(row),
    description: row.description ?? '',
    allowedActions: allowedActions(row, role),
  };
}
