import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useItemList, useQuickClaim } from '../api/queries';
import {
  itemKinds,
  itemPriorities,
  itemStatuses,
  type ItemKind,
  type ItemPriority,
  type ItemStatus,
  type ListFilters,
  type ListItem,
  type ListView,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ItemRow } from '../components/ItemRow';
import { useToast } from '../components/Toasts';
import { kindLabel, priorityLabel, statusLabel } from '../format';

const views: Array<{ value: ListView; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'stale', label: 'Stale' },
  { value: 'awaiting_approval', label: 'Awaiting my approval' },
];

const viewValues = views.map((v) => v.value);

// Only keep values that really exist, so a hand-edited URL cannot send nonsense to the API
function pickAll<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  return raw.split(',').filter((v): v is T => (allowed as readonly string[]).includes(v));
}

// The URL is the source of truth for filters, so a filtered list can be bookmarked and shared
function filtersFrom(params: URLSearchParams): ListFilters {
  const view = params.get('view') as ListView | null;
  const teamId = Number(params.get('teamId'));
  return {
    view: view && viewValues.includes(view) ? view : 'all',
    teamId: Number.isInteger(teamId) && teamId > 0 ? teamId : undefined,
    status: pickAll<ItemStatus>(params.get('status'), itemStatuses),
    priority: pickAll<ItemPriority>(params.get('priority'), itemPriorities),
    kind: pickAll<ItemKind>(params.get('kind'), itemKinds),
    q: params.get('q')?.trim() || undefined,
  };
}

export function ItemsPage() {
  const [params, setParams] = useSearchParams();
  const { user, teams, roleIn } = useAuth();
  const toast = useToast();
  const filters = useMemo(() => filtersFrom(params), [params]);

  // typing in the search box updates the URL only after a short pause
  const [search, setSearch] = useState(filters.q ?? '');
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.q ?? '') !== search.trim()) setFilter('q', search.trim() || null);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const list = useItemList(filters);
  const claim = useQuickClaim();
  const [claimingId, setClaimingId] = useState<number | null>(null);

  function setFilter(name: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  // Infinite scroll: load the next page when the marker near the bottom becomes visible
  const marker = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const node = marker.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '300px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);

  const onClaim = (item: ListItem) => {
    if (!user) return;
    setClaimingId(item.id);
    claim.mutate(
      { itemId: item.id, me: { id: user.id, name: user.name } },
      {
        onError: (err) => {
          toast.push('error', err instanceof ApiError && err.code === 'already_claimed' ? `Too late: ${err.message}.` : (err as Error).message);
        },
        onSuccess: () => toast.push('success', `You claimed ${item.ref}`),
        onSettled: () => setClaimingId(null),
      },
    );
  };

  const toggle = (name: 'status' | 'priority' | 'kind', value: string, current: string[]) => {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilter(name, next.length ? next.join(',') : null);
  };

  const hasFilters = Boolean(
    filters.teamId || filters.status?.length || filters.priority?.length || filters.kind?.length || filters.q,
  );

  return (
    <div>
      <div className="page-head">
        <h1>Work</h1>
      </div>

      <div className="tabs" role="tablist">
        {views.map((view) => (
          <button
            key={view.value}
            role="tab"
            aria-selected={filters.view === view.value}
            className={`tab ${filters.view === view.value ? 'active' : ''}`}
            onClick={() => setFilter('view', view.value === 'all' ? null : view.value)}
          >
            {view.label}
          </button>
        ))}
      </div>

      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search title and description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {teams.length > 1 && (
          <select value={filters.teamId ?? ''} onChange={(e) => setFilter('teamId', e.target.value || null)}>
            <option value="">All my teams</option>
            {teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.teamName}
              </option>
            ))}
          </select>
        )}
        <ChipGroup
          label="Status"
          options={itemStatuses.map((v) => ({ value: v, label: statusLabel[v] }))}
          selected={filters.status ?? []}
          onToggle={(v) => toggle('status', v, filters.status ?? [])}
        />
        <ChipGroup
          label="Priority"
          options={itemPriorities.map((v) => ({ value: v, label: priorityLabel[v] }))}
          selected={filters.priority ?? []}
          onToggle={(v) => toggle('priority', v, filters.priority ?? [])}
        />
        <ChipGroup
          label="Kind"
          options={itemKinds.map((v) => ({ value: v, label: kindLabel[v] }))}
          selected={filters.kind ?? []}
          onToggle={(v) => toggle('kind', v, filters.kind ?? [])}
        />
        {hasFilters && (
          <button
            className="link-btn"
            onClick={() => {
              setSearch('');
              setParams(filters.view === 'all' ? {} : { view: filters.view }, { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {list.isPending && <p className="muted pad">Loading…</p>}

      {list.isError && (
        <div className="state">
          <p>{list.error instanceof ApiError ? list.error.message : 'Could not load items.'}</p>
          <button className="btn" onClick={() => void list.refetch()}>
            Try again
          </button>
        </div>
      )}

      {!list.isPending && !list.isError && items.length === 0 && (
        <div className="state">
          <p>{hasFilters ? 'Nothing matches these filters.' : 'Nothing here. Enjoy the quiet.'}</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="rows">
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              canClaim={roleIn(item.team.id) !== null}
              claiming={claimingId === item.id}
              onClaim={onClaim}
            />
          ))}
        </ul>
      )}

      <div ref={marker} />
      {isFetchingNextPage && <p className="muted pad">Loading more…</p>}
      {hasNextPage && !isFetchingNextPage && (
        <div className="pad center">
          <button className="btn" onClick={() => void fetchNextPage()}>
            Load more
          </button>
        </div>
      )}
      {list.isFetchNextPageError && <p className="form-error pad">Could not load more. Scroll again to retry.</p>}
    </div>
  );
}

interface ChipGroupProps {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string) => void;
}

function ChipGroup({ label, options, selected, onToggle }: ChipGroupProps) {
  return (
    <details className="chips">
      <summary>
        {label}
        {selected.length > 0 && <span className="count">{selected.length}</span>}
      </summary>
      <div className="chips-menu">
        {options.map((option) => (
          <label key={option.value} className="check">
            <input type="checkbox" checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
    </details>
  );
}