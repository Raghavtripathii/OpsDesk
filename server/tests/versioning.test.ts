import { describe, expect, it } from 'vitest';
import { api, createItem, createWorld, eventsFor, itemRow, useServer } from './helpers.js';

useServer();

describe('version checks', () => {
  it('requires an If-Match version on every change to an item', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const lead = api(world.lead);

    const attempts = await Promise.all([
      lead.patch(`/api/items/${item.id}`, { title: 'x' }),
      lead.post(`/api/items/${item.id}/assign`, { ownerId: world.member2.id }),
      lead.post(`/api/items/${item.id}/priority`, { priority: 'high' }),
      lead.post(`/api/items/${item.id}/transitions`, { action: 'cancel', reason: 'because' }),
    ]);

    for (const reply of attempts) {
      expect(reply.status).toBe(428);
      expect(reply.body.error.code).toBe('precondition_required');
    }
    expect((await itemRow(item.id)).version).toBe(1);
  });

  it('rejects an If-Match value that is not a version', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    for (const bad of ['abc', '*', '1.5', '-1']) {
      const reply = await api(world.member).patch(`/api/items/${item.id}`, { title: 'x' }, {
        headers: { 'if-match': bad },
      });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('invalid_if_match');
    }
  });

  it('answers a stale write with the full current item so the client can recover', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    await api(world.member).patch(`/api/items/${item.id}`, { title: 'Newer title' }, { version: 1 });

    const stale = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Older edit' }, { version: 1 });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details).toMatchObject({ yourVersion: 1, currentVersion: 2 });
    expect(stale.body.error.details.current.title).toBe('Newer title');
    expect((await itemRow(item.id)).title).toBe('Newer title');
  });

  it('raises the version by exactly one per change, never for a no-op', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId, { title: 'Original' });

    const edited = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Changed' }, { version: 1 });
    expect(edited.body.changed).toBe(true);
    expect(edited.body.item.version).toBe(2);

    const same = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Changed' }, { version: 2 });
    expect(same.status).toBe(200);
    expect(same.body.changed).toBe(false);
    expect(same.body.item.version).toBe(2);

    const priority = await api(world.lead).post(`/api/items/${item.id}/priority`, { priority: 'urgent' }, { version: 2 });
    expect(priority.body.item.version).toBe(3);

    const samePriority = await api(world.lead).post(`/api/items/${item.id}/priority`, { priority: 'urgent' }, { version: 3 });
    expect(samePriority.body.changed).toBe(false);
    expect(samePriority.body.item.version).toBe(3);
  });

  it('sends the version as an ETag on reads and writes', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    const read = await api(world.member).get(`/api/items/${item.id}`);
    expect(read.headers.get('etag')).toBe('"1"');

    const write = await api(world.member).patch(`/api/items/${item.id}`, { title: 'Etag check' }, { version: 1 });
    expect(write.headers.get('etag')).toBe('"2"');
  });

  it('records what changed in the item history', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId, { title: 'History' });

    await api(world.member).patch(`/api/items/${item.id}`, { title: 'History 2', dueAt: '2030-01-01T00:00:00Z' }, { version: 1 });
    await api(world.lead).post(`/api/items/${item.id}/priority`, { priority: 'high' }, { version: 2 });
    await api(world.lead).post(`/api/items/${item.id}/assign`, { ownerId: world.member2.id }, { version: 3 });

    const events = await eventsFor(item.id);
    expect(events.map((event) => event.type)).toEqual([
      'created',
      'details_edited',
      'due_date_changed',
      'priority_changed',
      'owner_changed',
      'status_changed',
    ]);
    expect(events[1]!.data.title).toEqual({ from: 'History', to: 'History 2' });
    expect(events[3]!.data).toEqual({ from: 'medium', to: 'high' });
    expect(events[4]!.data).toEqual({ from: null, to: world.member2.id });
    expect(events[4]!.actor_id).toBe(world.lead.id);
  });

  it('validates what can be edited', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    const empty = await api(world.member).patch(`/api/items/${item.id}`, {}, { version: 1 });
    const tooLong = await api(world.member).patch(`/api/items/${item.id}`, { title: 'x'.repeat(201) }, { version: 1 });
    const badDate = await api(world.member).patch(`/api/items/${item.id}`, { dueAt: 'tomorrow' }, { version: 1 });

    expect([empty.status, tooLong.status, badDate.status]).toEqual([400, 400, 400]);
    expect((await itemRow(item.id)).version).toBe(1);
  });

  it('can clear a due date', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId, { dueAt: '2031-05-05T10:00:00Z' });

    const cleared = await api(world.member).patch(`/api/items/${item.id}`, { dueAt: null }, { version: 1 });
    expect(cleared.status).toBe(200);
    expect(cleared.body.item.dueAt).toBeNull();
  });
});
