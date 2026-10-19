import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getToken } from '../api/client';
import { keys } from '../api/queries';

export type LiveStatus = 'connecting' | 'live' | 'offline';

interface ServerEvent {
  event: string;
  data: string;
}

// Reads the stream and calls onEvent for every complete "event/data" block
async function readStream(response: Response, onEvent: (event: ServerEvent) => void) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');

      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        // lines starting with ":" are heartbeats and "retry:" is handled by our own backoff
      }
      if (data.length > 0) onEvent({ event, data: data.join('\n') });
    }
  }
}

export function useRealtime(enabled: boolean): LiveStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    if (!enabled) return;

    const abort = new AbortController();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const dirtyItems = new Set<number>();
    let dirtyNotifications = false;
    let dirtyEverything = false;

    // A burst of events becomes one round of refetches
    const flush = () => {
      flushTimer = null;

      if (dirtyEverything) {
        void client.invalidateQueries();
      } else {
        for (const id of dirtyItems) {
          void client.invalidateQueries({ queryKey: keys.item(id) });
          void client.invalidateQueries({ queryKey: keys.timeline(id) });
        }
        if (dirtyItems.size > 0) {
          void client.invalidateQueries({ queryKey: keys.items });
          void client.invalidateQueries({ queryKey: keys.attention });
        }
        if (dirtyNotifications) void client.invalidateQueries({ queryKey: keys.notifications });
      }

      dirtyItems.clear();
      dirtyNotifications = false;
      dirtyEverything = false;
    };

    const schedule = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    };

    const handle = ({ event, data }: ServerEvent) => {
      if (event === 'item_changed') {
        try {
          const parsed = JSON.parse(data) as { itemId?: unknown };
          if (typeof parsed.itemId === 'number') dirtyItems.add(parsed.itemId);
        } catch {
          dirtyEverything = true;
        }
      } else if (event === 'notification') {
        dirtyNotifications = true;
      } else if (event === 'resync') {
        // the server lost its database listener for a moment, so we may have missed events
        dirtyEverything = true;
      } else if (event === 'ready') {
        setStatus('live');
        return;
      } else {
        return;
      }
      schedule();
    };

    async function run() {
      let failures = 0;

      while (!abort.signal.aborted) {
        setStatus('connecting');
        try {
          const token = getToken();
          if (!token) return;

          const response = await fetch('/api/stream', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            signal: abort.signal,
          });
          // 401 means the session is gone; the normal API calls will log the user out
          if (response.status === 401) return;
          if (!response.ok) throw new Error(`Stream failed (${response.status})`);

          if (failures > 0) dirtyEverything = true;
          failures = 0;
          await readStream(response, handle);
        } catch {
          if (abort.signal.aborted) return;
        }

        // The server closes the stream every 15 minutes on purpose, so ending is normal.
        // Either way we wait a little, then reconnect and refetch what we may have missed.
        failures += 1;
        setStatus('offline');
        const wait = Math.min(1000 * 2 ** Math.min(failures, 5), 30_000);
        await new Promise((resolve) => setTimeout(resolve, wait));
        dirtyEverything = true;
        schedule();
      }
    }

    void run();

    return () => {
      abort.abort();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [enabled, client]);

  return status;
}