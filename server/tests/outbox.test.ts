import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { handleItemEvent } from '../src/jobs/itemEventNotifications.js';
import {
  backoffSeconds,
  claimJobs,
  markDone,
  markFailed,
  pruneFinishedJobs,
  requeueStuckJobs,
} from '../src/services/outbox.js';
import {
  addMember,
  api,
  countRows,
  createItem,
  createUser,
  createWorld,
  drainQueue,
  insertRawItem,
  useServer,
} from './helpers.js';

useServer();

async function addEvent(itemId: number, actorId: number, type: string, data: Record<string, unknown>) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO work_item_events (item_id, actor_id, type, data) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [itemId, actorId, type, JSON.stringify(data)],
  );
  return rows[0]!.id;
}

async function jobFor(eventId: number) {
  const { rows } = await pool.query(`SELECT * FROM outbox_jobs WHERE dedupe_key = $1`, [`item_event:${eventId}`]);
  return rows[0] as { id: number; status: string; attempts: number; max_attempts: number; run_at: Date; last_error: string | null } | undefined;
}

async function recipients(eventId: number) {
  const { rows } = await pool.query<{ user_id: number; type: string }>(
    `SELECT user_id, type FROM notifications WHERE dedupe_key LIKE $1 ORDER BY user_id`,
    [`event:${eventId}:%`],
  );
  return rows;
}

describe('the transactional outbox', () => {
  it('queues a job in the same transaction as the event, and only if it commits', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id });

    const rolledBack = await pool.connect();
    let eventId = 0;
    try {
      await rolledBack.query('BEGIN');
      const inserted = await rolledBack.query(
        `INSERT INTO work_item_events (item_id, actor_id, type, data) VALUES ($1, $2, 'details_edited', '{}'::jsonb) RETURNING id`,
        [itemId, world.member.id],
      );
      eventId = inserted.rows[0].id;
      const inside = await rolledBack.query(`SELECT 1 FROM outbox_jobs WHERE dedupe_key = $1`, [`item_event:${eventId}`]);
      expect(inside.rowCount).toBe(1);
      await rolledBack.query('ROLLBACK');
    } finally {
      rolledBack.release();
    }
    expect(await jobFor(eventId)).toBeUndefined();

    const committed = await addEvent(itemId, world.member.id, 'details_edited', {});
    expect((await jobFor(committed))?.status).toBe('pending');
  });

  it('queues exactly one job per real action, whichever code path made the event', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    await api(world.member2).post(`/api/items/${item.id}/claim`);
    await api(world.member).post(`/api/items/${item.id}/comments`, { body: 'Hello' });

    const { rows: events } = await pool.query(`SELECT id FROM work_item_events WHERE item_id = $1`, [item.id]);
    const { rows: jobs } = await pool.query(
      `SELECT dedupe_key FROM outbox_jobs WHERE dedupe_key = ANY($1::text[])`,
      [events.map((event: { id: number }) => `item_event:${event.id}`)],
    );
    expect(events).toHaveLength(4);
    expect(jobs).toHaveLength(4);
  });

  it('keeps bulk-loaded history out of the queue when asked to', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id });

    const client = await pool.connect();
    let eventId = 0;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL opsdesk.skip_outbox = 'on'`);
      const inserted = await client.query(
        `INSERT INTO work_item_events (item_id, actor_id, type, data) VALUES ($1, $2, 'created', '{}'::jsonb) RETURNING id`,
        [itemId, world.member.id],
      );
      eventId = inserted.rows[0].id;
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await jobFor(eventId)).toBeUndefined();
  });

  it('accepts work while no worker is running, and delivers it once one starts', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    await api(world.member2).post(`/api/items/${item.id}/claim`);

    const comment = await api(world.member).post(`/api/items/${item.id}/comments`, { body: 'Written while the worker is down' });
    expect(comment.status).toBe(201);

    const { rows } = await pool.query(
      `SELECT j.status
       FROM outbox_jobs j
       JOIN work_item_events e ON j.dedupe_key = 'item_event:' || e.id
       WHERE e.item_id = $1 AND e.type = 'comment_added'`,
      [item.id],
    );
    expect(rows.map((row: { status: string }) => row.status)).toEqual(['pending']);
    expect(await countRows('notifications', 'item_id = $1', [item.id])).toBe(0);

    await drainQueue();

    const delivered = await api(world.member2).get('/api/notifications');
    const mine = delivered.body.notifications.filter((n: any) => n.itemId === item.id && n.type === 'comment');
    expect(mine).toHaveLength(1);
    expect(mine[0].data.excerpt).toBe('Written while the worker is down');
  });
});

describe('who gets notified', () => {
  it('tells the owner about a comment from the reporter, and the reporter about one from the owner', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });
    const { rows } = await pool.query(`INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, 'hi') RETURNING id`, [itemId, world.member.id]);

    const fromReporter = await addEvent(itemId, world.member.id, 'comment_added', { commentId: rows[0].id });
    await handleItemEvent({ eventId: fromReporter });
    expect((await recipients(fromReporter)).map((r) => r.user_id)).toEqual([world.member2.id]);

    const fromOwner = await addEvent(itemId, world.member2.id, 'comment_added', { commentId: rows[0].id });
    await handleItemEvent({ eventId: fromOwner });
    expect((await recipients(fromOwner)).map((r) => r.user_id)).toEqual([world.member.id]);
  });

  it('tells the new and the old owner about reassignment, but never the person who did it', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });

    const eventId = await addEvent(itemId, world.lead.id, 'owner_changed', { from: world.member2.id, to: world.lead2.id });
    await handleItemEvent({ eventId });

    const found = await recipients(eventId);
    expect(found.map((r) => `${r.user_id}:${r.type}`).sort()).toEqual(
      [`${world.lead2.id}:assigned`, `${world.member2.id}:unassigned`].sort(),
    );

    const selfAssigned = await addEvent(itemId, world.lead.id, 'owner_changed', { from: world.lead2.id, to: world.lead.id });
    await handleItemEvent({ eventId: selfAssigned });
    expect((await recipients(selfAssigned)).map((r) => r.user_id)).toEqual([world.lead2.id]);
  });

  it('sends an approval request to leads and admins only, never to the owner or reporter', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({
      teamId: world.teamId,
      reporterId: world.lead2.id,
      ownerId: world.member.id,
      status: 'pending_approval',
      requiresApproval: true,
    });

    const eventId = await addEvent(itemId, world.member.id, 'status_changed', { from: 'in_progress', to: 'pending_approval' });
    await handleItemEvent({ eventId });

    const ids = (await recipients(eventId)).map((r) => r.user_id).sort();
    expect(ids).toEqual([world.lead.id, world.admin.id].sort());
    expect(ids).not.toContain(world.lead2.id);
    expect(ids).not.toContain(world.member.id);
    expect(ids).not.toContain(world.member2.id);
    expect(ids).not.toContain(world.outsider.id);
  });

  it('does not notify people who have left the team or been deactivated', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });
    const { rows } = await pool.query(`INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, 'bye') RETURNING id`, [itemId, world.lead.id]);

    await pool.query(`DELETE FROM memberships WHERE user_id = $1 AND team_id = $2`, [world.member2.id, world.teamId]);
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [world.member.id]);

    const eventId = await addEvent(itemId, world.lead.id, 'comment_added', { commentId: rows[0].id });
    await handleItemEvent({ eventId });

    expect(await recipients(eventId)).toHaveLength(0);
  });

  it('only escalates a priority change when it becomes urgent', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });

    const urgent = await addEvent(itemId, world.lead.id, 'priority_changed', { from: 'medium', to: 'urgent' });
    const low = await addEvent(itemId, world.lead.id, 'priority_changed', { from: 'medium', to: 'low' });
    await handleItemEvent({ eventId: urgent });
    await handleItemEvent({ eventId: low });

    expect((await recipients(urgent)).map((r) => r.type)).toEqual(['priority_urgent']);
    expect(await recipients(low)).toHaveLength(0);
  });

  it('does not notify anyone about edits that nobody else needs to hear about', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });
    const eventId = await addEvent(itemId, world.lead.id, 'details_edited', { fields: ['title'] });
    await handleItemEvent({ eventId });
    expect(await recipients(eventId)).toHaveLength(0);
  });
});

describe('delivering twice', () => {
  it('creates no duplicate notifications when the same job runs again', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });
    const { rows } = await pool.query(`INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, 'again') RETURNING id`, [itemId, world.lead.id]);
    const eventId = await addEvent(itemId, world.lead.id, 'comment_added', { commentId: rows[0].id });

    await handleItemEvent({ eventId });
    const once = (await recipients(eventId)).length;
    await handleItemEvent({ eventId });
    await handleItemEvent({ eventId });

    expect(once).toBe(2);
    expect(await recipients(eventId)).toHaveLength(2);
  });

  it('delivers once even when two workers handle the same event at the same moment', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });
    const { rows } = await pool.query(`INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, 'race') RETURNING id`, [itemId, world.lead.id]);
    const eventId = await addEvent(itemId, world.lead.id, 'comment_added', { commentId: rows[0].id });

    await Promise.all(Array.from({ length: 6 }, () => handleItemEvent({ eventId })));

    expect(await recipients(eventId)).toHaveLength(2);
  });

  it('refuses a payload that is not a valid event reference', async () => {
    await expect(handleItemEvent({})).rejects.toThrow();
    await expect(handleItemEvent({ eventId: 'abc' })).rejects.toThrow();
    await expect(handleItemEvent({ eventId: 999999999 })).rejects.toThrow(/does not exist/);
  });
});

describe('failures, retries and recovery', () => {
  async function queueJob(type: string, maxAttempts = 3) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO outbox_jobs (type, payload, max_attempts) VALUES ($1, '{}'::jsonb, $2) RETURNING id`,
      [type, maxAttempts],
    );
    return rows[0]!.id;
  }

  async function state(id: number) {
    const { rows } = await pool.query(
      `SELECT status, attempts, last_error, extract(epoch FROM (run_at - now()))::float AS wait FROM outbox_jobs WHERE id = $1`,
      [id],
    );
    return rows[0] as { status: string; attempts: number; last_error: string | null; wait: number };
  }

  it('retries a failing job later, then gives up and keeps the error', async () => {
    const id = await queueJob(`always_fails_${randomUUID().slice(0, 8)}`, 3);

    await drainQueue();
    const first = await state(id);
    expect(first.status).toBe('pending');
    expect(first.attempts).toBe(1);
    expect(first.wait).toBeGreaterThan(1);
    expect(first.last_error).toMatch(/No handler registered/);

    await pool.query(`UPDATE outbox_jobs SET run_at = now() WHERE id = $1`, [id]);
    await drainQueue();
    const second = await state(id);
    expect(second.status).toBe('pending');
    expect(second.attempts).toBe(2);
    expect(second.wait).toBeGreaterThan(first.wait);

    await pool.query(`UPDATE outbox_jobs SET run_at = now() WHERE id = $1`, [id]);
    await drainQueue();
    const last = await state(id);
    expect(last.status).toBe('dead');
    expect(last.attempts).toBe(3);

    await pool.query(`UPDATE outbox_jobs SET run_at = now() WHERE id = $1`, [id]);
    await drainQueue();
    expect((await state(id)).attempts).toBe(3);
  });

  it('keeps healthy jobs flowing while one job keeps failing', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });
    const poison = await queueJob(`poison_${randomUUID().slice(0, 8)}`, 5);
    const { rows } = await pool.query(`INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, 'ok') RETURNING id`, [itemId, world.lead.id]);
    const healthyEvent = await addEvent(itemId, world.lead.id, 'comment_added', { commentId: rows[0].id });

    await drainQueue();

    expect((await state(poison)).status).toBe('pending');
    expect((await jobFor(healthyEvent))?.status).toBe('done');
    expect(await recipients(healthyEvent)).toHaveLength(2);
  });

  it('recovers a job left behind by a crashed worker, and finishes it once', async () => {
    const world = await createWorld();
    const itemId = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, ownerId: world.member2.id, status: 'in_progress' });
    const { rows } = await pool.query(`INSERT INTO comments (item_id, author_id, body) VALUES ($1, $2, 'crash') RETURNING id`, [itemId, world.lead.id]);
    const eventId = await addEvent(itemId, world.lead.id, 'comment_added', { commentId: rows[0].id });

    await pool.query(
      `UPDATE outbox_jobs SET status = 'processing', attempts = 1, locked_at = now() - interval '10 minutes' WHERE dedupe_key = $1`,
      [`item_event:${eventId}`],
    );
    expect(await requeueStuckJobs()).toBeGreaterThanOrEqual(1);
    expect((await jobFor(eventId))?.status).toBe('pending');

    await drainQueue();
    expect((await jobFor(eventId))?.status).toBe('done');
    expect(await recipients(eventId)).toHaveLength(2);
  });

  it('marks a stuck job dead if it has already used all its attempts', async () => {
    const id = await queueJob(`stuck_${randomUUID().slice(0, 8)}`, 2);
    await pool.query(`UPDATE outbox_jobs SET status = 'processing', attempts = 2, locked_at = now() - interval '10 minutes' WHERE id = $1`, [id]);

    await requeueStuckJobs();
    expect((await state(id)).status).toBe('dead');
  });

  it('leaves a job alone while a worker is still within its time to finish', async () => {
    const id = await queueJob(`working_${randomUUID().slice(0, 8)}`, 3);
    await pool.query(`UPDATE outbox_jobs SET status = 'processing', attempts = 1, locked_at = now() WHERE id = $1`, [id]);

    await requeueStuckJobs();
    expect((await state(id)).status).toBe('processing');
    await pool.query(`UPDATE outbox_jobs SET status = 'done', finished_at = now() WHERE id = $1`, [id]);
  });

  it('never hands the same job to two workers', async () => {
    const type = `parallel_${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO outbox_jobs (type, payload) SELECT $1, '{}'::jsonb FROM generate_series(1, 60)`,
      [type],
    );

    const claimedIds: number[] = [];
    const mine = new Set<number>();
    for (let round = 0; round < 10 && mine.size < 60; round += 1) {
      const batches = await Promise.all(Array.from({ length: 6 }, () => claimJobs(10)));
      for (const job of batches.flat()) {
        claimedIds.push(job.id);
        if (job.type === type) mine.add(job.id);
        await markDone(job.id);
      }
    }

    expect(mine.size).toBe(60);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
  });

  it('waits longer after each failure, with a ceiling', () => {
    const waits = [1, 2, 3, 4, 5].map((attempt) => backoffSeconds(attempt));
    const lowerBounds = [3.75, 7.5, 15, 30, 60];
    waits.forEach((wait, index) => {
      expect(wait).toBeGreaterThanOrEqual(Math.floor(lowerBounds[index]!));
      expect(wait).toBeLessThanOrEqual(Math.ceil(lowerBounds[index]! * (1.25 / 0.75)));
    });
    expect(backoffSeconds(30)).toBeLessThanOrEqual(375);
  });

  it('removes old finished jobs and keeps recent ones', async () => {
    const oldId = await queueJob(`old_${randomUUID().slice(0, 8)}`);
    const recentId = await queueJob(`recent_${randomUUID().slice(0, 8)}`);
    await pool.query(`UPDATE outbox_jobs SET status = 'done', finished_at = now() - interval '30 days' WHERE id = $1`, [oldId]);
    await pool.query(`UPDATE outbox_jobs SET status = 'done', finished_at = now() WHERE id = $1`, [recentId]);

    expect(await pruneFinishedJobs()).toBeGreaterThanOrEqual(1);
    expect(await countRows('outbox_jobs', 'id = $1', [oldId])).toBe(0);
    expect(await countRows('outbox_jobs', 'id = $1', [recentId])).toBe(1);
  });

  it('records a failure only for a job that is actually being processed', async () => {
    const id = await queueJob(`ghost_${randomUUID().slice(0, 8)}`);
    await markFailed({ id, type: 'ghost', payload: {}, attempts: 1, maxAttempts: 3 }, new Error('late'));
    expect((await state(id)).status).toBe('pending');
    expect((await state(id)).last_error).toBeNull();
  });
});

describe('notification routes', () => {
  async function notificationsFor(world: Awaited<ReturnType<typeof createWorld>>) {
    const item = await createItem(world.member, world.teamId);
    await api(world.member2).post(`/api/items/${item.id}/claim`);
    for (let i = 0; i < 4; i += 1) await api(world.member2).post(`/api/items/${item.id}/comments`, { body: `Update ${i}` });
    await drainQueue();
    return item;
  }

  it('pages through a person\'s notifications with an unread count', async () => {
    const world = await createWorld();
    await notificationsFor(world);

    const first = await api(world.member).get('/api/notifications?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.notifications).toHaveLength(2);
    expect(first.body.unreadCount).toBe(5);
    expect(first.body.nextCursor).toBeTruthy();

    const rest = await api(world.member).get(`/api/notifications?limit=50&cursor=${first.body.nextCursor}`);
    const ids = [...first.body.notifications, ...rest.body.notifications].map((n: any) => n.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('marks notifications read, safely and only for their owner', async () => {
    const world = await createWorld();
    await notificationsFor(world);

    const list = await api(world.member).get('/api/notifications');
    const target = list.body.notifications[0].id;

    const foreign = await api(world.member2).post('/api/notifications/read', { ids: [target] });
    expect(foreign.body.updated).toBe(0);

    const first = await api(world.member).post('/api/notifications/read', { ids: [target] });
    const repeat = await api(world.member).post('/api/notifications/read', { ids: [target] });
    expect(first.body.updated).toBe(1);
    expect(repeat.body.updated).toBe(0);

    const unread = await api(world.member).get('/api/notifications?unread=true');
    expect(unread.body.notifications.map((n: any) => n.id)).not.toContain(target);

    const all = await api(world.member).post('/api/notifications/read', { all: true });
    expect(all.body.updated).toBe(4);
    expect((await api(world.member).get('/api/notifications')).body.unreadCount).toBe(0);
  });

  it('rejects invalid read requests', async () => {
    const world = await createWorld();
    expect((await api(world.member).post('/api/notifications/read', { ids: [] })).status).toBe(400);
    expect((await api(world.member).post('/api/notifications/read', {})).status).toBe(400);
    expect((await api(world.member).post('/api/notifications/read', { ids: ['x'] })).status).toBe(400);
  });

  it('hides notifications about a team the person has since left', async () => {
    const world = await createWorld();
    await notificationsFor(world);

    const before = await api(world.member).get('/api/notifications?limit=100');
    expect(before.body.notifications.length).toBeGreaterThan(0);

    await pool.query(`DELETE FROM memberships WHERE user_id = $1 AND team_id = $2`, [world.member.id, world.teamId]);
    const after = await api(world.member).get('/api/notifications?limit=100');
    expect(after.body.notifications).toHaveLength(0);

    await addMember(world.member.id, world.teamId, 'member');
    expect((await api(world.member).get('/api/notifications?limit=100')).body.notifications.length).toBeGreaterThan(0);
  });

  it('shows nobody else\'s notifications', async () => {
    const world = await createWorld();
    await notificationsFor(world);
    const stranger = await createUser('Stranger');

    const reply = await api(stranger).get('/api/notifications');
    expect(reply.body.notifications).toHaveLength(0);
    expect(reply.body.unreadCount).toBe(0);
    expect((await api().get('/api/notifications')).status).toBe(401);
  });
});
