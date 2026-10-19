import type { ItemAction, ItemKind, ItemPriority, ItemStatus, TransitionAction } from './api/types';

export const statusLabel: Record<ItemStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  pending_approval: 'Pending approval',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const kindLabel: Record<ItemKind, string> = {
  customer_issue: 'Customer issue',
  incident: 'Incident',
  payment: 'Payment',
  compliance: 'Compliance',
  task: 'Task',
};

export const priorityLabel: Record<ItemPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const actionLabel: Record<TransitionAction, string> = {
  release: 'Release',
  request_approval: 'Request approval',
  resolve: 'Resolve',
  approve: 'Approve',
  reject: 'Reject',
  close: 'Close',
  reopen: 'Reopen',
  cancel: 'Cancel item',
};

// These actions need a written reason on the server, so the UI asks for it up front
export const reasonRequired: ReadonlySet<ItemAction> = new Set(['reject', 'reopen', 'cancel']);

export function humanize(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// <input type="datetime-local"> wants local time without a zone, the API wants a full ISO string
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}