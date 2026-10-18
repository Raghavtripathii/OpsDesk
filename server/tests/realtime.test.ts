import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { connectedClientCount, startRealtime, stopRealtime } from '../src/services/realtime.js';
import { api, createItem, createWorld, drainQueue, useServer, type TestUser } from './helpers.js';

const server = useServer();

beforeAll(() => {
  startRealtime();
});

afterAll(() => {
  stopRealtime();
});

interface Stream {
  events: Array<{ event: string; data: any }>;
  status: number;
  contentType: string | null;
  close: () => void;
}

async function listen(user: TestUser): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(`${server.baseUrl}/api/stream`, {
    headers: { authorization: `Bearer ${user.token}` },
    signal: controller.signal,
  });

  const events: Stream['events'] = [];
  let buffer = '';

  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (name) events.push({ event: name, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      return;
    }
  })();

  return {
    events,
    status: res.status,
    contentType: res.headers.get('content-type'),
    close: () => controller.abort(),
  };
}

async function eventually(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('live updates', () => {
  it('requires a login', async () => {
    const res = await fetch(`${server.baseUrl}/api/stream`);
    expect(res.status).toBe(401);
  });

  it('tells team members about a change as soon as it commits, and nobody else', async () => {
    const world = await createWorld();
    const insider = await listen(world.member);
    const stranger = await listen(world.outsider);

    expect(await eventually(() => insider.events.some((e) => e.event === 'ready'))).toBe(true);
    expect(insider.status).toBe(200);
    expect(insider.contentType).toMatch(/text\/event-stream/);

    const item = await createItem(world.lead, world.teamId);
    expect(
      await eventually(() => insider.events.some((e) => e.event === 'item_changed' && e.data.itemId === item.id)),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stranger.events.filter((e) => e.event === 'item_changed')).toHaveLength(0);

    insider.close();
    stranger.close();
  });

  it('announces nothing for a change that was rolled back', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const insider = await listen(world.member);
    await eventually(() => insider.events.some((e) => e.event === 'ready'));
    const before = insider.events.filter((e) => e.event === 'item_changed').length;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO work_item_events (item_id, actor_id, type, data) VALUES ($1, $2, 'details_edited', '{}'::jsonb)`,
        [item.id, world.member.id],
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(insider.events.filter((e) => e.event === 'item_changed')).toHaveLength(before);
    insider.close();
  });

  it('pushes a notification only to the person it is for', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    await api(world.member2).post(`/api/items/${item.id}/claim`);

    const reporter = await listen(world.member);
    const bystander = await listen(world.member2);
    await eventually(() => reporter.events.some((e) => e.event === 'ready') && bystander.events.some((e) => e.event === 'ready'));

    await drainQueue();

    expect(await eventually(() => reporter.events.some((e) => e.event === 'notification'))).toBe(true);
    expect(bystander.events.some((e) => e.event === 'notification')).toBe(false);

    reporter.close();
    bystander.close();
  });

  it('asks clients to refresh after the database connection is lost, then keeps working', async () => {
    const world = await createWorld();
    const insider = await listen(world.member);
    await eventually(() => insider.events.some((e) => e.event === 'ready'));

    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN user_notifications' AND pid <> pg_backend_pid()`,
    );

    expect(await eventually(() => insider.events.some((e) => e.event === 'resync'), 10_000)).toBe(true);

    const item = await createItem(world.lead, world.teamId);
    expect(
      await eventually(() => insider.events.some((e) => e.event === 'item_changed' && e.data.itemId === item.id)),
    ).toBe(true);
    insider.close();
  });

  it('forgets connections that close', async () => {
    const world = await createWorld();
    const before = connectedClientCount();
    const stream = await listen(world.member);
    await eventually(() => stream.events.some((e) => e.event === 'ready'));
    expect(connectedClientCount()).toBe(before + 1);

    stream.close();
    expect(await eventually(() => connectedClientCount() === before)).toBe(true);
  });
});
