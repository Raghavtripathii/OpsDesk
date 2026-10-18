import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { api, countRows, createItem, createWorld, itemRow, uniqueTitle, useServer } from './helpers.js';

useServer();

describe('idempotency keys', () => {
  it('replays the original response and does not repeat the action', async () => {
    const world = await createWorld();
    const title = uniqueTitle('Idempotent create');
    const key = randomUUID();

    const first = await api(world.member).post(`/api/teams/${world.teamId}/items`, { title, kind: 'task' }, { key });
    const second = await api(world.member).post(`/api/teams/${world.teamId}/items`, { title, kind: 'task' }, { key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.headers.get('etag')).toBe('"1"');
    expect(await countRows('work_items', 'title = $1', [title])).toBe(1);
  });

  it('creates one item when five identical requests arrive at the same instant', async () => {
    const world = await createWorld();
    const title = uniqueTitle('Double click');
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(world.member).post(`/api/teams/${world.teamId}/items`, { title, kind: 'task' }, { key }),
      ),
    );

    expect(results.every((reply) => reply.status === 201)).toBe(true);
    expect(new Set(results.map((reply) => reply.body.item.id)).size).toBe(1);
    expect(await countRows('work_items', 'title = $1', [title])).toBe(1);
  });

  it('returns the original success when a lost response is retried after an edit', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const key = randomUUID();

    const first = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Edited once' }, { version: 1, key });
    const retry = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Edited once' }, { version: 1, key });
    const withoutKey = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Edited once' }, { version: 1 });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(retry.body.item.version).toBe(2);
    expect(withoutKey.status).toBe(409);
    expect((await itemRow(item.id)).version).toBe(2);
  });

  it('rejects a reused key that comes with a different request, without acting on it', async () => {
    const world = await createWorld();
    const key = randomUUID();
    const firstTitle = uniqueTitle('First');
    const secondTitle = uniqueTitle('Second');

    await api(world.member).post(`/api/teams/${world.teamId}/items`, { title: firstTitle, kind: 'task' }, { key });
    const reuse = await api(world.member).post(`/api/teams/${world.teamId}/items`, { title: secondTitle, kind: 'task' }, { key });

    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('idempotency_key_reuse');
    expect(await countRows('work_items', 'title = $1', [secondTitle])).toBe(0);
  });

  it('keeps keys private to each user', async () => {
    const world = await createWorld();
    const key = randomUUID();
    const title = uniqueTitle('Shared key');

    const a = await api(world.member).post(`/api/teams/${world.teamId}/items`, { title, kind: 'task' }, { key });
    const b = await api(world.lead).post(`/api/teams/${world.teamId}/items`, { title, kind: 'task' }, { key });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.item.id).not.toBe(a.body.item.id);
    expect(b.headers.get('idempotent-replayed')).toBeNull();
  });

  it('replays deterministic failures instead of retrying them', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const key = randomUUID();

    const first = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Stale' }, { version: 99, key });
    const second = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Stale' }, { version: 99, key });

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
  });

  it('takes over a key abandoned by a crashed request, so a retry is not stuck', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const key = randomUUID();

    await api(world.member).post(`/api/items/${item.id}/comments`, { body: 'First attempt' }, { key });
    await pool.query(
      `UPDATE idempotency_keys
       SET state = 'in_progress', response_status = NULL, response_body = NULL, created_at = now() - interval '5 minutes'
       WHERE user_id = $1 AND key = $2`,
      [world.member.id, key],
    );

    const retry = await api(world.member).post(`/api/items/${item.id}/comments`, { body: 'First attempt' }, { key });
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();

    const stored = await pool.query(`SELECT state FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [
      world.member.id,
      key,
    ]);
    expect(stored.rows[0].state).toBe('completed');
  });

  it('rejects malformed keys before doing anything', async () => {
    const world = await createWorld();
    const res = await api(world.member).post(
      `/api/teams/${world.teamId}/items`,
      { title: uniqueTitle(), kind: 'task' },
      { key: 'short' },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
  });

  it('does nothing special when no key is sent', async () => {
    const world = await createWorld();
    const title = uniqueTitle('No key');
    await api(world.member).post(`/api/teams/${world.teamId}/items`, { title, kind: 'task' });
    await api(world.member).post(`/api/teams/${world.teamId}/items`, { title, kind: 'task' });
    expect(await countRows('work_items', 'title = $1', [title])).toBe(2);
  });
});
