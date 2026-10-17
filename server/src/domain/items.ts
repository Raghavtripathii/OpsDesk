export const itemKinds = ['customer_issue', 'incident', 'payment', 'compliance', 'task'] as const;
export const itemStatuses = ['open', 'in_progress', 'pending_approval', 'resolved', 'closed', 'cancelled'] as const;
export const itemPriorities = ['low', 'medium', 'high', 'urgent'] as const;

export type ItemKind = (typeof itemKinds)[number];
export type ItemStatus = (typeof itemStatuses)[number];
export type ItemPriority = (typeof itemPriorities)[number];

export const staleAfterDays = 7;

export function approvalRequiredFor(kind: ItemKind): boolean {
  return kind === 'payment' || kind === 'compliance';
}

export function itemRef(id: number): string {
  return `OPS-${id}`;
}
