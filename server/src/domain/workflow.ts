import { roleCan, type Role } from '../auth/permissions.js';
import type { ItemStatus } from './items.js';

export const transitionActions = [
  'release',
  'request_approval',
  'resolve',
  'approve',
  'reject',
  'close',
  'reopen',
  'cancel',
] as const;

export type TransitionAction = (typeof transitionActions)[number];

export type ItemAction = 'comment' | 'claim' | 'edit' | 'assign' | 'change_priority' | TransitionAction;

export interface Actor {
  userId: number;
  role: Role;
}

export interface WorkflowItem {
  status: ItemStatus;
  ownerId: number | null;
  reporterId: number;
  requiresApproval: boolean;
}

export const activeStatuses: readonly ItemStatus[] = ['open', 'in_progress', 'pending_approval'];
export const lockedStatuses: readonly ItemStatus[] = ['closed', 'cancelled'];

interface Rule {
  from: readonly ItemStatus[];
  to: ItemStatus;
  needsReason: boolean;
  permitted: (actor: Actor, item: WorkflowItem) => boolean;
  guard?: (item: WorkflowItem) => string | null;
}

function isOwner(actor: Actor, item: WorkflowItem): boolean {
  return item.ownerId === actor.userId;
}

function isReporter(actor: Actor, item: WorkflowItem): boolean {
  return item.reporterId === actor.userId;
}

function canManage(actor: Actor): boolean {
  return roleCan(actor.role, 'item:assign');
}

function ownerOrManager(actor: Actor, item: WorkflowItem): boolean {
  return isOwner(actor, item) || canManage(actor);
}

function reporterOrManager(actor: Actor, item: WorkflowItem): boolean {
  return isReporter(actor, item) || canManage(actor);
}

function canDecide(actor: Actor, item: WorkflowItem): boolean {
  return roleCan(actor.role, 'item:approve') && !isOwner(actor, item) && !isReporter(actor, item);
}

const rules: Record<TransitionAction, Rule> = {
  release: {
    from: ['in_progress'],
    to: 'open',
    needsReason: false,
    permitted: ownerOrManager,
  },
  request_approval: {
    from: ['in_progress'],
    to: 'pending_approval',
    needsReason: false,
    permitted: ownerOrManager,
    guard: (item) => (item.requiresApproval ? null : 'This item does not need approval'),
  },
  resolve: {
    from: ['in_progress'],
    to: 'resolved',
    needsReason: false,
    permitted: ownerOrManager,
    guard: (item) => (item.requiresApproval ? 'This item needs approval before it can be resolved' : null),
  },
  approve: {
    from: ['pending_approval'],
    to: 'resolved',
    needsReason: false,
    permitted: canDecide,
  },
  reject: {
    from: ['pending_approval'],
    to: 'in_progress',
    needsReason: true,
    permitted: canDecide,
  },
  close: {
    from: ['resolved'],
    to: 'closed',
    needsReason: false,
    permitted: reporterOrManager,
  },
  reopen: {
    from: ['resolved'],
    to: 'in_progress',
    needsReason: true,
    permitted: reporterOrManager,
    guard: (item) => (item.ownerId === null ? 'Assign an owner before reopening' : null),
  },
  cancel: {
    from: ['open', 'in_progress'],
    to: 'cancelled',
    needsReason: true,
    permitted: reporterOrManager,
  },
};

export type TransitionCheck =
  | { ok: true; to: ItemStatus; needsReason: boolean }
  | { ok: false; httpStatus: number; code: string; message: string; details?: Record<string, unknown> };

export function checkTransition(action: TransitionAction, actor: Actor, item: WorkflowItem): TransitionCheck {
  const rule = rules[action];

  if (!rule.permitted(actor, item)) {
    const decision = (action === 'approve' || action === 'reject') && roleCan(actor.role, 'item:approve');
    return {
      ok: false,
      httpStatus: 403,
      code: 'forbidden',
      message: decision
        ? 'You cannot decide on an item you own or reported'
        : 'You are not allowed to do this on this item',
    };
  }

  if (!rule.from.includes(item.status)) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'invalid_transition',
      message: `Cannot ${action.replace('_', ' ')} an item that is ${item.status.replace('_', ' ')}`,
      details: { action, status: item.status, allowedFrom: rule.from },
    };
  }

  const violation = rule.guard?.(item);
  if (violation) {
    return { ok: false, httpStatus: 409, code: 'rule_violation', message: violation, details: { action } };
  }

  return { ok: true, to: rule.to, needsReason: rule.needsReason };
}

export function availableTransitions(actor: Actor, item: WorkflowItem): TransitionAction[] {
  return transitionActions.filter((action) => checkTransition(action, actor, item).ok);
}

export function mayEditDetails(actor: Actor, item: WorkflowItem): boolean {
  if (roleCan(actor.role, 'item:edit_any')) return true;
  return roleCan(actor.role, 'item:edit_own') && (isOwner(actor, item) || isReporter(actor, item));
}

export function mayAssign(actor: Actor): boolean {
  return roleCan(actor.role, 'item:assign');
}

export function mayChangePriority(actor: Actor): boolean {
  return roleCan(actor.role, 'item:change_priority');
}

export function itemActions(item: WorkflowItem, actor: Actor): ItemAction[] {
  const actions: ItemAction[] = [];

  if (roleCan(actor.role, 'item:comment')) actions.push('comment');
  if (item.status === 'open' && item.ownerId === null && roleCan(actor.role, 'item:claim')) actions.push('claim');
  if (!lockedStatuses.includes(item.status) && mayEditDetails(actor, item)) actions.push('edit');
  if (activeStatuses.includes(item.status) && mayAssign(actor)) actions.push('assign');
  if (activeStatuses.includes(item.status) && mayChangePriority(actor)) actions.push('change_priority');
  actions.push(...availableTransitions(actor, item));

  return actions;
}
