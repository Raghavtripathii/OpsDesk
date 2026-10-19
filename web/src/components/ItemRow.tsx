import { Link } from 'react-router-dom';
import type { ListItem } from '../api/types';
import { formatDate, timeAgo } from '../format';
import { KindTag, PriorityBadge, StatusBadge } from './Badges';

interface Props {
  item: ListItem;
  canClaim: boolean;
  claiming: boolean;
  onClaim: (item: ListItem) => void;
}

export function ItemRow({ item, canClaim, claiming, onClaim }: Props) {
  const claimable = canClaim && item.status === 'open' && item.owner === null;

  return (
    <li className="row">
      <div className="row-main">
        <div className="row-title">
          <span className="ref">{item.ref}</span>
          <Link to={`/items/${item.id}`}>{item.title}</Link>
        </div>
        <div className="row-meta">
          <StatusBadge status={item.status} />
          <PriorityBadge priority={item.priority} />
          <KindTag kind={item.kind} />
          <span className="muted">{item.team.name}</span>
          {item.isOverdue && item.dueAt && <span className="flag flag-bad">Overdue since {formatDate(item.dueAt)}</span>}
          {!item.isOverdue && item.dueAt && <span className="muted">Due {formatDate(item.dueAt)}</span>}
          {item.isStale && <span className="flag flag-warn">Stale</span>}
        </div>
      </div>
      <div className="row-side">
        <span className="owner">{item.owner ? item.owner.name : <em className="muted">Unassigned</em>}</span>
        <span className="muted small">{timeAgo(item.lastActivityAt)}</span>
        {claimable && (
          <button className="btn btn-small btn-primary" disabled={claiming} onClick={() => onClaim(item)}>
            Claim
          </button>
        )}
      </div>
    </li>
  );
}