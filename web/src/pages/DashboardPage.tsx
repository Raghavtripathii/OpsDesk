import { Link } from 'react-router-dom';
import { useAttention } from '../api/queries';
import type { ListView } from '../api/types';
import { useAuth } from '../auth/AuthContext';

interface Card {
  key: keyof NonNullable<ReturnType<typeof useAttention>['data']>['counts'];
  title: string;
  hint: string;
  view: ListView;
  tone: 'bad' | 'warn' | 'info';
}

const cards: Card[] = [
  { key: 'assignedToMe', title: 'Assigned to me', hint: 'In progress or waiting for approval', view: 'mine', tone: 'info' },
  { key: 'overdue', title: 'Overdue', hint: 'Past the due date and still active', view: 'overdue', tone: 'bad' },
  { key: 'unassignedUrgent', title: 'Unassigned and urgent', hint: 'Nobody owns these yet', view: 'unassigned', tone: 'bad' },
  { key: 'awaitingApproval', title: 'Awaiting my approval', hint: 'Waiting for a lead or admin', view: 'awaiting_approval', tone: 'warn' },
  { key: 'stale', title: 'Stale', hint: 'No activity for 7 days', view: 'stale', tone: 'warn' },
];

export function DashboardPage() {
  const { user } = useAuth();
  const { data, isPending, isError, refetch } = useAttention();

  if (isError) {
    return (
      <div className="state">
        <p>Could not load your dashboard.</p>
        <button className="btn" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1>Hello, {user?.name.split(' ')[0]}</h1>
      <p className="muted">Here is what needs your attention.</p>

      <div className="cards">
        {cards.map((card) => {
          const count = data?.counts[card.key];
          const capped = data && count !== undefined && count >= data.cap;
          // the unassigned+urgent card lists only the urgent ones
          const priority = card.key === 'unassignedUrgent' ? '&priority=urgent' : '';
          return (
            <Link key={card.key} to={`/items?view=${card.view}${priority}`} className={`card card-${card.tone}`}>
              <span className="card-title">{card.title}</span>
              <span className="card-count">{isPending ? '…' : capped ? `${count}+` : count}</span>
              <span className="muted small">{card.hint}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}