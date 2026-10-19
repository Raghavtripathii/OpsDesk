export const itemKinds = ['customer_issue', 'incident', 'payment', 'compliance', 'task'] as const;
export const itemStatuses = ['open', 'in_progress', 'pending_approval', 'resolved', 'closed', 'cancelled'] as const;
export const itemPriorities = ['low', 'medium', 'high', 'urgent'] as const;

export type ItemKind = (typeof itemKinds)[number];
export type ItemStatus = (typeof itemStatuses)[number];
export type ItemPriority = (typeof itemPriorities)[number];
export type Role = 'member' | 'lead' | 'admin';

export type TransitionAction =
  | 'release'
  | 'request_approval'
  | 'resolve'
  | 'approve'
  | 'reject'
  | 'close'
  | 'reopen'
  | 'cancel';

export type ItemAction = 'comment' | 'claim' | 'edit' | 'assign' | 'change_priority' | TransitionAction;

export type ListView = 'all' | 'mine' | 'unassigned' | 'overdue' | 'stale' | 'awaiting_approval';

export interface Person {
  id: number;
  name: string | null;
}

export interface ListItem {
  id: number;
  ref: string;
  title: string;
  kind: ItemKind;
  status: ItemStatus;
  priority: ItemPriority;
  requiresApproval: boolean;
  team: { id: number; name: string };
  reporter: Person;
  owner: Person | null;
  dueAt: string | null;
  isOverdue: boolean;
  isStale: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface ItemDetail extends ListItem {
  description: string;
  allowedActions: ItemAction[];
}

export interface ListPage {
  items: ListItem[];
  nextCursor: string | null;
}

export interface TimelineEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
  actor: Person | null;
  comment: string | null;
}

export interface TimelinePage {
  events: TimelineEvent[];
  people: Record<string, string>;
  nextCursor: string | null;
}

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  isOrgAdmin: boolean;
}

export interface TeamMembership {
  teamId: number;
  teamName: string;
  role: Role;
}

export interface MeResponse {
  user: SessionUser;
  teams: TeamMembership[];
}

export interface Member {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export interface AttentionSummary {
  cap: number;
  counts: {
    assignedToMe: number;
    overdue: number;
    unassignedUrgent: number;
    awaitingApproval: number;
    stale: number;
  };
}

export interface AppNotification {
  id: number;
  type: string;
  itemId: number | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsPage {
  notifications: AppNotification[];
  unreadCount: number;
  unreadCap: number;
  nextCursor: string | null;
}

export interface ListFilters {
  view: ListView;
  teamId?: number;
  status?: ItemStatus[];
  priority?: ItemPriority[];
  kind?: ItemKind[];
  ownerId?: number;
  q?: string;
}

export interface MutationResult {
  item: ItemDetail;
  changed: boolean;
}