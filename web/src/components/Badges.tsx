import type { ItemKind, ItemPriority, ItemStatus } from '../api/types';
import { kindLabel, priorityLabel, statusLabel } from '../format';

export function StatusBadge({ status }: { status: ItemStatus }) {
  return <span className={`badge status-${status}`}>{statusLabel[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: ItemPriority }) {
  return <span className={`badge priority-${priority}`}>{priorityLabel[priority]}</span>;
}

export function KindTag({ kind }: { kind: ItemKind }) {
  return <span className="tag">{kindLabel[kind]}</span>;
}