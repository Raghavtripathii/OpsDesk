import { describe, expect, it } from 'vitest';
import { api, createItem, createMembers, createWorld, eventsFor, itemRow, useServer } from './helpers.js';

useServer();

describe('simultaneous claims', () => {
  it('lets exactly one of ten simultaneous claimers win, every time', async () => {
    const world = await createWorld();
    const claimers = await createMembers(world.teamId, 10);

    for (let round = 0; round < 5; round += 1) {
      const item = await createItem(world.member, world.teamId);
      const results = await Promise.all(claimers.map((user) => api(user).post(`/api/items/${item.id}/claim`)));

      const winners = results.filter((reply) => reply.status === 200 && reply.body.changed === true);
      const losers = results.filter((reply) => reply.status === 409);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(9);
      for (const loser of losers) expect(loser.body.error.code).toBe('already_claimed');

      const winnerIndex = results.findIndex((reply) => reply.status === 200);
      const row = await itemRow(item.id);
      expect(row.owner_id).toBe(claimers[winnerIndex]!.id);
      expect(row.status).toBe('in_progress');
      expect(row.version).toBe(2);

      const events = await eventsFor(item.id);
      expect(events.filter((event) => event.type === 'owner_changed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'status_changed')).toHaveLength(1);
    }
  });

  it('treats the same person claiming twice at once as one change and one harmless repeat', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    const results = await Promise.all([
      api(world.member2).post(`/api/items/${item.id}/claim`),
      api(world.member2).post(`/api/items/${item.id}/claim`),
    ]);

    expect(results.map((reply) => reply.status)).toEqual([200, 200]);
    expect(results.filter((reply) => reply.body.changed)).toHaveLength(1);
    expect((await eventsFor(item.id)).filter((event) => event.type === 'owner_changed')).toHaveLength(1);
  });

  it('refuses to claim an item that already has an owner or has moved on', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    await api(world.member2).post(`/api/items/${item.id}/claim`);

    const late = await api(world.lead).post(`/api/items/${item.id}/claim`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('already_claimed');
    expect(late.body.error.details.ownerId).toBe(world.member2.id);
  });
});

describe('simultaneous edits', () => {
  it('never loses an update when two people edit the same version', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    const [a, b] = await Promise.all([
      api(world.member).patch(`/api/items/${item.id}`, { title: 'Edit from Maya' }, { version: item.version }),
      api(world.lead).patch(`/api/items/${item.id}`, { title: 'Edit from Leo' }, { version: item.version }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.body.error.code).toBe('version_conflict');
    expect(loser.body.error.details.currentVersion).toBe(2);
    expect(loser.body.error.details.current.title).toBe(winner.body.item.title);

    const row = await itemRow(item.id);
    expect(row.title).toBe(winner.body.item.title);
    expect(row.version).toBe(2);
    expect((await eventsFor(item.id)).filter((event) => event.type === 'details_edited')).toHaveLength(1);
  });

  it('serialises an edit and a workflow move that start from the same version', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    const [edit, cancel] = await Promise.all([
      api(world.member).patch(`/api/items/${item.id}`, { title: 'Renamed' }, { version: item.version }),
      api(world.lead).post(
        `/api/items/${item.id}/transitions`,
        { action: 'cancel', reason: 'No longer needed' },
        { version: item.version },
      ),
    ]);

    expect([edit.status, cancel.status].sort()).toEqual([200, 409]);
    expect((await itemRow(item.id)).version).toBe(2);
  });

  it('lets only one of two leads approve the same pending item', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId, { kind: 'payment' });
    await api(world.member).post(`/api/items/${item.id}/claim`);
    const requested = await api(world.member).post(
      `/api/items/${item.id}/transitions`,
      { action: 'request_approval' },
      { version: 2 },
    );
    expect(requested.status).toBe(200);

    const [a, b] = await Promise.all([
      api(world.lead).post(`/api/items/${item.id}/transitions`, { action: 'approve' }, { version: 3 }),
      api(world.lead2).post(`/api/items/${item.id}/transitions`, { action: 'approve' }, { version: 3 }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await itemRow(item.id);
    expect(row.status).toBe('resolved');
    expect(row.version).toBe(4);

    const resolvedEvents = (await eventsFor(item.id)).filter(
      (event) => event.type === 'status_changed' && event.data.to === 'resolved',
    );
    expect(resolvedEvents).toHaveLength(1);
  });
});

describe('simultaneous comments', () => {
  it('accepts ten comments at once without conflicts or version changes', async () => {
    const world = await createWorld();
    const people = await createMembers(world.teamId, 10);
    const item = await createItem(world.member, world.teamId);

    const results = await Promise.all(
      people.map((user, index) => api(user).post(`/api/items/${item.id}/comments`, { body: `Comment ${index}` })),
    );

    expect(results.every((reply) => reply.status === 201)).toBe(true);

    const row = await itemRow(item.id);
    expect(row.version).toBe(1);
    expect((await eventsFor(item.id)).filter((event) => event.type === 'comment_added')).toHaveLength(10);
    expect(new Date(row.last_activity_at).getTime()).toBeGreaterThanOrEqual(new Date(row.created_at).getTime());
  });
});
