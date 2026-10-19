import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAddComment, useItem, useTimeline, type ConflictInfo } from '../api/queries';
import { ActionsPanel } from '../components/ActionsPanel';
import { KindTag, PriorityBadge, StatusBadge } from '../components/Badges';
import { ConflictBanner } from '../components/ConflictBanner';
import { Timeline } from '../components/Timeline';
import { useToast } from '../components/Toasts';
import { formatDateTime } from '../format';

export function ItemDetailPage() {
  const params = useParams();
  const id = Number(params.itemId);
  const validId = Number.isSafeInteger(id) && id > 0;

  const item = useItem(validId ? id : 0);
  const timeline = useTimeline(validId ? id : 0);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  if (!validId || (item.isError && item.error instanceof ApiError && item.error.status === 404)) {
    return (
      <div className="state">
        <h2>Item not found</h2>
        <p className="muted">It may not exist, or it belongs to a team you are not in.</p>
        <Link to="/items" className="btn">
          Back to work
        </Link>
      </div>
    );
  }

  if (item.isPending) return <p className="muted pad">Loading…</p>;

  if (item.isError) {
    return (
      <div className="state">
        <p>{item.error instanceof ApiError ? item.error.message : 'Could not load this item.'}</p>
        <button className="btn" onClick={() => void item.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const data = item.data;
  const events = timeline.data?.pages.flatMap((page) => page.events) ?? [];
  const people = Object.assign({}, ...(timeline.data?.pages.map((page) => page.people) ?? []));

  return (
    <div>
      <p className="crumbs">
        <Link to="/items">← All work</Link>
      </p>

      {conflict && <ConflictBanner conflict={conflict} onDismiss={() => setConflict(null)} />}

      <div className="detail">
        <div className="detail-main">
          <div className="detail-head">
            <span className="ref">{data.ref}</span>
            <h1>{data.title}</h1>
            <div className="row-meta">
              <StatusBadge status={data.status} />
              <PriorityBadge priority={data.priority} />
              <KindTag kind={data.kind} />
              {data.requiresApproval && <span className="tag">Needs approval</span>}
              {data.isOverdue && <span className="flag flag-bad">Overdue</span>}
              {data.isStale && <span className="flag flag-warn">Stale</span>}
            </div>
          </div>

          <section className="panel">
            <h3>Description</h3>
            {data.description ? <p className="prewrap">{data.description}</p> : <p className="muted">No description.</p>}
          </section>

          <section className="panel">
            <h3>Discussion and history</h3>
            <CommentBox itemId={data.id} />
            {timeline.isPending && <p className="muted">Loading history…</p>}
            {timeline.isError && (
              <p className="form-error">
                Could not load history.{' '}
                <button className="link-btn" onClick={() => void timeline.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {timeline.data && (
              <Timeline
                events={events}
                people={people}
                hasMore={Boolean(timeline.hasNextPage)}
                loadingMore={timeline.isFetchingNextPage}
                onLoadMore={() => void timeline.fetchNextPage()}
              />
            )}
          </section>
        </div>

        <aside className="detail-side">
          <ActionsPanel item={data} onConflict={setConflict} />

          <section className="panel">
            <h3>Details</h3>
            <dl className="facts">
              <dt>Team</dt>
              <dd>{data.team.name}</dd>
              <dt>Owner</dt>
              <dd>{data.owner?.name ?? <em className="muted">Unassigned</em>}</dd>
              <dt>Reporter</dt>
              <dd>{data.reporter.name}</dd>
              <dt>Due</dt>
              <dd>{data.dueAt ? formatDateTime(data.dueAt) : <span className="muted">No due date</span>}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(data.createdAt)}</dd>
              <dt>Version</dt>
              <dd>{data.version}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

function CommentBox({ itemId }: { itemId: number }) {
  const [body, setBody] = useState('');
  const add = useAddComment(itemId);
  const toast = useToast();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text || add.isPending) return;
    add.mutate(text, {
      onSuccess: () => setBody(''),
      onError: (err) => toast.push('error', err instanceof ApiError ? err.message : 'Could not post the comment'),
    });
  };

  return (
    <form className="comment-form" onSubmit={submit}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={5000}
        placeholder="Write a comment"
        aria-label="Comment"
      />
      <button className="btn btn-primary" disabled={add.isPending || !body.trim()}>
        {add.isPending ? 'Posting…' : 'Comment'}
      </button>
    </form>
  );
}