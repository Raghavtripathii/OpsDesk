import type { TimelineEvent } from '../api/types';
import { formatDateTime, humanize, priorityLabel, statusLabel } from '../format';
import type { ItemPriority, ItemStatus } from '../api/types';

interface Props {
  events: TimelineEvent[];
  people: Record<string, string>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function personName(people: Record<string, string>, value: unknown): string {
  if (value === null || value === undefined) return 'nobody';
  return people[String(value)] ?? 'someone';
}

function status(value: unknown): string {
  return statusLabel[value as ItemStatus] ?? humanize(String(value));
}

function describe(event: TimelineEvent, people: Record<string, string>): string {
  const d = event.data;
  switch (event.type) {
    case 'created':
      return 'created this item';
    case 'status_changed': {
      const base = `moved it from ${status(d.from)} to ${status(d.to)}`;
      return typeof d.reason === 'string' ? `${base}. Reason: ${d.reason}` : base;
    }
    case 'owner_changed':
      return d.from === null || d.from === undefined
        ? `assigned it to ${personName(people, d.to)}`
        : d.to === null || d.to === undefined
          ? `removed ${personName(people, d.from)} as owner`
          : `changed the owner from ${personName(people, d.from)} to ${personName(people, d.to)}`;
    case 'priority_changed':
      return `changed priority from ${priorityLabel[d.from as ItemPriority] ?? String(d.from)} to ${priorityLabel[d.to as ItemPriority] ?? String(d.to)}`;
    case 'due_date_changed':
      return d.to ? `set the due date to ${formatDateTime(String(d.to))}` : 'removed the due date';
    case 'details_edited': {
      const fields = Array.isArray(d.fields) ? d.fields.join(' and ') : 'details';
      return `edited the ${fields}`;
    }
    case 'comment_added':
      return 'commented';
    default:
      return humanize(event.type);
  }
}

export function Timeline({ events, people, hasMore, loadingMore, onLoadMore }: Props) {
  if (events.length === 0) return <p className="muted">No history yet.</p>;

  return (
    <div>
      <ol className="timeline">
        {events.map((event) => (
          <li key={event.id} className={`event event-${event.type}`}>
            <div className="event-head">
              <strong>{event.actor?.name ?? 'System'}</strong> {describe(event, people)}
              <span className="muted small"> · {formatDateTime(event.createdAt)}</span>
            </div>
            {event.type === 'comment_added' && event.comment && <p className="comment-body">{event.comment}</p>}
          </li>
        ))}
      </ol>
      {hasMore && (
        <button className="btn btn-small" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? 'Loading…' : 'Show older history'}
        </button>
      )}
    </div>
  );
}