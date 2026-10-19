import { useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { api, ApiError, newIdempotencyKey } from './client';
import type {
  AttentionSummary,
  ItemDetail,
  ItemKind,
  ItemPriority,
  ListFilters,
  ListPage,
  Member,
  MeResponse,
  MutationResult,
  NotificationsPage,
  TimelinePage,
  TransitionAction,
} from './types';

// ---------- query keys ----------

export const keys = {
  me: ['me'] as const,
  attention: ['attention'] as const,
  items: ['items'] as const,
  list: (filters: ListFilters) => ['items', filters] as const,
  item: (id: number) => ['item', id] as const,
  timeline: (id: number) => ['timeline', id] as const,
  members: (teamId: number) => ['members', teamId] as const,
  notifications: ['notifications'] as const,
};

function listQueryString(filters: ListFilters, cursor?: string): string {
  const params = new URLSearchParams();
  params.set('view', filters.view);
  params.set('limit', '25');
  if (filters.teamId) params.set('teamId', String(filters.teamId));
  if (filters.status?.length) params.set('status', filters.status.join(','));
  if (filters.priority?.length) params.set('priority', filters.priority.join(','));
  if (filters.kind?.length) params.set('kind', filters.kind.join(','));
  if (filters.ownerId) params.set('ownerId', String(filters.ownerId));
  if (filters.q) params.set('q', filters.q);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

// ---------- reads ----------

export function useMe(enabled: boolean) {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api<MeResponse>('/api/auth/me'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useAttention() {
  return useQuery({
    queryKey: keys.attention,
    queryFn: () => api<AttentionSummary>('/api/attention'),
  });
}

// Cursor pagination: each page hands back the cursor for the next one
export function useItemList(filters: ListFilters) {
  return useInfiniteQuery({
    queryKey: keys.list(filters),
    queryFn: ({ pageParam }) => api<ListPage>(`/api/items?${listQueryString(filters, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useItem(id: number) {
  return useQuery({
    queryKey: keys.item(id),
    queryFn: async () => (await api<{ item: ItemDetail }>(`/api/items/${id}`)).item,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500 && error.status !== 0) && count < 2,
  });
}

export function useTimeline(id: number) {
  return useInfiniteQuery({
    queryKey: keys.timeline(id),
    queryFn: ({ pageParam }) =>
      api<TimelinePage>(`/api/items/${id}/events?limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useMembers(teamId: number | undefined) {
  return useQuery({
    queryKey: keys.members(teamId ?? 0),
    queryFn: async () => (await api<{ members: Member[] }>(`/api/teams/${teamId}/members?limit=100`)).members,
    enabled: teamId !== undefined,
    staleTime: 60_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => api<NotificationsPage>('/api/notifications?limit=20'),
  });
}

export function useMarkNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { all: true } | { ids: number[] }) =>
      api<{ updated: number }>('/api/notifications/read', { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.notifications }),
  });
}

// ---------- create ----------

export interface NewItemInput {
  title: string;
  description: string;
  kind: ItemKind;
  priority: ItemPriority;
  dueAt: string | null;
}

export function useCreateItem(teamId: number) {
  const client = useQueryClient();
  // The key is made once per form, so a double click or a retry cannot create two items.
  // It is replaced after a success so the next item gets a fresh key.
  const key = useRef(newIdempotencyKey());
  return useMutation({
    mutationFn: async (input: NewItemInput) => {
      try {
        const result = await api<{ item: ItemDetail }>(`/api/teams/${teamId}/items`, {
          method: 'POST',
          body: input,
          idempotencyKey: key.current,
        });
        key.current = newIdempotencyKey();
        return result.item;
      } catch (err) {
        // 4xx means the server rejected it for good, so a corrected form deserves a new key
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) key.current = newIdempotencyKey();
        throw err;
      }
    },
    onSuccess: (item) => {
      client.setQueryData(keys.item(item.id), item);
      void client.invalidateQueries({ queryKey: keys.items });
      void client.invalidateQueries({ queryKey: keys.attention });
    },
  });
}

export function useAddComment(itemId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api(`/api/items/${itemId}/comments`, { method: 'POST', body: { body }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.timeline(itemId) }),
  });
}

// ---------- item mutations (optimistic) ----------

// What the screen should look like right away, before the server answers
type Patch = (item: ItemDetail) => ItemDetail;

export interface ItemChange {
  path: string;
  method?: 'POST' | 'PATCH';
  body?: unknown;
  // claim is decided by the database, so it sends no version
  version?: number;
  optimistic: Patch;
}

export interface ConflictInfo {
  yourVersion: number;
  currentVersion: number;
}

const transitionTarget: Record<TransitionAction, ItemDetail['status']> = {
  release: 'open',
  request_approval: 'pending_approval',
  resolve: 'resolved',
  approve: 'resolved',
  reject: 'in_progress',
  close: 'closed',
  reopen: 'in_progress',
  cancel: 'cancelled',
};

// While a change is in flight we hide the action buttons so nobody fires a second one
function pending(item: ItemDetail): ItemDetail {
  return { ...item, allowedActions: item.allowedActions.filter((a) => a === 'comment') };
}

export const patches = {
  claim: (me: { id: number; name: string }): Patch => (item) =>
    pending({ ...item, status: 'in_progress', owner: { id: me.id, name: me.name } }),
  priority: (priority: ItemPriority): Patch => (item) => ({ ...item, priority }),
  assign: (owner: { id: number; name: string }): Patch => (item) =>
    pending({ ...item, owner, status: item.status === 'open' ? 'in_progress' : item.status }),
  transition: (action: TransitionAction): Patch => (item) =>
    pending({
      ...item,
      status: transitionTarget[action],
      owner: action === 'release' ? null : item.owner,
    }),
  details: (input: { title?: string; description?: string; dueAt?: string | null }): Patch => (item) => ({
    ...item,
    title: input.title ?? item.title,
    description: input.description ?? item.description,
    dueAt: input.dueAt === undefined ? item.dueAt : input.dueAt,
  }),
};

// Quick claim buttons in list rows use the same idea on the cached pages
function patchListRows(client: QueryClient, itemId: number, patch: (row: ListPage['items'][number]) => ListPage['items'][number]) {
  client.setQueriesData<InfiniteData<ListPage>>({ queryKey: keys.items }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((row) => (row.id === itemId ? patch(row) : row)),
      })),
    };
  });
}

export function useItemMutation(itemId: number) {
  const client = useQueryClient();

  return useMutation<
    MutationResult,
    ApiError,
    ItemChange,
    { previous: ItemDetail | undefined; previousLists: [readonly unknown[], unknown][] }
  >({
    mutationFn: (change) =>
      api<MutationResult>(change.path, {
        method: change.method ?? 'POST',
        body: change.body,
        version: change.version,
        idempotencyKey: newIdempotencyKey(),
      }),

    onMutate: async (change) => {
      // stop in-flight refetches from overwriting the optimistic state
      await client.cancelQueries({ queryKey: keys.item(itemId) });
      const previous = client.getQueryData<ItemDetail>(keys.item(itemId));
      const previousLists = client.getQueriesData<InfiniteData<ListPage>>({ queryKey: keys.items });

      if (previous) client.setQueryData(keys.item(itemId), change.optimistic(previous));
      return { previous, previousLists };
    },

    onError: (error, _change, context) => {
      // roll back to what we had, then let a conflict replace it with the server's copy
      if (context?.previous) client.setQueryData(keys.item(itemId), context.previous);
      for (const [key, data] of context?.previousLists ?? []) client.setQueryData(key, data);

      if (error.code === 'version_conflict') {
        const current = (error.details as { current?: ItemDetail } | undefined)?.current;
        if (current) client.setQueryData(keys.item(itemId), current);
      }
    },

    onSuccess: (result) => {
      client.setQueryData(keys.item(itemId), result.item);
    },

    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.item(itemId) });
      void client.invalidateQueries({ queryKey: keys.timeline(itemId) });
      void client.invalidateQueries({ queryKey: keys.items });
      void client.invalidateQueries({ queryKey: keys.attention });
    },
  });
}

export function conflictFrom(error: unknown): ConflictInfo | null {
  if (!(error instanceof ApiError) || error.code !== 'version_conflict') return null;
  const details = error.details as Partial<ConflictInfo> | undefined;
  if (typeof details?.yourVersion !== 'number' || typeof details.currentVersion !== 'number') return null;
  return { yourVersion: details.yourVersion, currentVersion: details.currentVersion };
}

// Claim straight from a list row, no detail page needed
export function useQuickClaim() {
  const client = useQueryClient();

  return useMutation<
    MutationResult,
    ApiError,
    { itemId: number; me: { id: number; name: string } },
    { previousLists: [readonly unknown[], unknown][] }
  >({
    mutationFn: ({ itemId }) =>
      api<MutationResult>(`/api/items/${itemId}/claim`, { method: 'POST', idempotencyKey: newIdempotencyKey() }),

    onMutate: async ({ itemId, me }) => {
      await client.cancelQueries({ queryKey: keys.items });
      const previousLists = client.getQueriesData<InfiniteData<ListPage>>({ queryKey: keys.items });
      patchListRows(client, itemId, (row) => ({
        ...row,
        status: 'in_progress',
        owner: { id: me.id, name: me.name },
      }));
      return { previousLists };
    },

    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.previousLists ?? []) client.setQueryData(key, data);
    },

    onSettled: (_data, _error, vars) => {
      void client.invalidateQueries({ queryKey: keys.items });
      void client.invalidateQueries({ queryKey: keys.attention });
      void client.invalidateQueries({ queryKey: keys.item(vars.itemId) });
    },
  });
}