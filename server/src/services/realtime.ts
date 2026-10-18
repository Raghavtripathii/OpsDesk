import type { Response } from 'express';
import pg from 'pg';
import { config } from '../config.js';

export interface StreamClient {
  userId: number;
  teamIds: Set<number>;
  res: Response;
}

const heartbeatEveryMs = 25_000;
const reconnectAfterMs = 2000;

const clients = new Set<StreamClient>();

let listener: pg.Client | null = null;
let stopped = true;
let retryTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

export function addClient(client: StreamClient): () => void {
  clients.add(client);
  return () => {
    clients.delete(client);
  };
}

export function connectedClientCount(): number {
  return clients.size;
}

function send(client: StreamClient, chunk: string) {
  try {
    client.res.write(chunk);
  } catch {
    clients.delete(client);
  }
}

function sendEvent(client: StreamClient, event: string, data: unknown) {
  send(client, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function dispatch(channel: string, payload: string | undefined) {
  if (!payload) return;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return;
  }

  if (channel === 'item_events' && typeof data.teamId === 'number') {
    for (const client of clients) {
      if (client.teamIds.has(data.teamId)) {
        sendEvent(client, 'item_changed', {
          eventId: data.eventId,
          itemId: data.itemId,
          teamId: data.teamId,
          type: data.type,
          actorId: data.actorId,
        });
      }
    }
  }

  if (channel === 'user_notifications' && typeof data.userId === 'number') {
    for (const client of clients) {
      if (client.userId === data.userId) sendEvent(client, 'notification', { notificationId: data.notificationId });
    }
  }
}

function scheduleReconnect() {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, reconnectAfterMs);
}

async function connect() {
  if (stopped) return;

  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  listener = client;
  let finished = false;

  const lost = () => {
    if (finished) return;
    finished = true;
    if (listener === client) listener = null;
    client.removeAllListeners();
    client.on('error', () => undefined);
    client.end().catch(() => undefined);
    scheduleReconnect();
  };

  client.on('notification', (message) => dispatch(message.channel, message.payload));
  client.on('error', (err) => {
    console.error('Realtime listener error:', err.message);
    lost();
  });
  client.on('end', lost);

  try {
    await client.connect();
    await client.query('LISTEN item_events');
    await client.query('LISTEN user_notifications');
    for (const streamClient of clients) sendEvent(streamClient, 'resync', {});
  } catch (err) {
    console.error('Realtime listener could not start:', err instanceof Error ? err.message : err);
    lost();
  }
}

export function startRealtime() {
  if (!stopped) return;
  stopped = false;
  void connect();

  heartbeatTimer = setInterval(() => {
    for (const client of clients) send(client, ': ping\n\n');
  }, heartbeatEveryMs);
  heartbeatTimer.unref();
}

export function stopRealtime() {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  retryTimer = null;
  heartbeatTimer = null;

  for (const client of clients) client.res.end();
  clients.clear();

  if (listener) {
    const current = listener;
    listener = null;
    current.removeAllListeners();
    current.on('error', () => undefined);
    current.end().catch(() => undefined);
  }
}
