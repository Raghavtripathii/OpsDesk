import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import {
  addMember,
  api,
  createItem,
  createUser,
  createWorld,
  insertRawItem,
  uniqueTitle,
  useServer,
} from './helpers.js';

useServer();

describe('authentication', () => {
  it('rejects requests with no token, a bad token, or a deactivated account', async () => {
    const world = await createWorld();

    expect((await api().get('/api/items')).status).toBe(401);
    expect((await api().get('/api/attention')).status).toBe(401);
    expect((await api({ id: 1, name: 'x', token: 'not-a-real-token' }).get('/api/items')).status).toBe(401);

    expect((await api(world.member).get('/api/items')).status).toBe(200);
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [world.member.id]);
    expect((await api(world.member).get('/api/items')).status).toBe(401);
  });
});

describe('team isolation', () => {
  it('hides another team\'s items completely, whatever the route', async () => {
    const world = await createWorld();
    const secret = await createItem(world.outsider, world.otherTeamId, { title: uniqueTitle('Confidential') });
    const id = secret.id;
    const stranger = api(world.member);

    const replies = await Promise.all([
      stranger.get(`/api/items/${id}`),
      stranger.get(`/api/items/${id}/events`),
      stranger.post(`/api/items/${id}/comments`, { body: 'hello' }),
      stranger.post(`/api/items/${id}/claim`),
      stranger.patch(`/api/items/${id}`, { title: 'hacked' }, { version: 1 }),
      stranger.post(`/api/items/${id}/assign`, { ownerId: world.member.id }, { version: 1 }),
      stranger.post(`/api/items/${id}/priority`, { priority: 'urgent' }, { version: 1 }),
      stranger.post(`/api/items/${id}/transitions`, { action: 'cancel', reason: 'because' }, { version: 1 }),
    ]);

    for (const reply of replies) {
      expect(reply.status).toBe(404);
      expect(JSON.stringify(reply.body)).not.toContain('Confidential');
    }
  });

  it('keeps other teams out of lists, searches, filters and counts', async () => {
    const world = await createWorld();
    const title = uniqueTitle('Zebracorn');
    await createItem(world.outsider, world.otherTeamId, { title, priority: 'urgent' });

    const list = await api(world.member).get('/api/items?limit=100');
    expect(list.body.items.some((item: any) => item.title === title)).toBe(false);

    const search = await api(world.member).get(`/api/items?q=${encodeURIComponent(title)}`);
    expect(search.body.items).toHaveLength(0);

    const filtered = await api(world.member).get(`/api/items?teamId=${world.otherTeamId}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(0);

    const attention = await api(world.member).get('/api/attention');
    expect(attention.body.counts.unassignedUrgent).toBe(0);
  });

  it('does not let outsiders create items, see members or manage a team', async () => {
    const world = await createWorld();
    const stranger = api(world.outsider);

    expect((await stranger.post(`/api/teams/${world.teamId}/items`, { title: 'x', kind: 'task' })).status).toBe(404);
    expect((await stranger.get(`/api/teams/${world.teamId}/members`)).status).toBe(404);
    expect(
      (await stranger.post(`/api/teams/${world.teamId}/members`, { userId: world.outsider.id, role: 'admin' })).status,
    ).toBe(404);
  });

  it('gives organisation admins no automatic access to a team\'s work', async () => {
    const world = await createWorld();
    const orgAdmin = await createUser('Org Admin');
    await pool.query(`UPDATE users SET is_org_admin = true WHERE id = $1`, [orgAdmin.id]);
    const item = await createItem(world.member, world.teamId);

    expect((await api(orgAdmin).get(`/api/items/${item.id}`)).status).toBe(404);
    expect((await api(orgAdmin).get(`/api/teams/${world.teamId}/members`)).status).toBe(404);
  });

  it('applies a person\'s role per team, not globally', async () => {
    const world = await createWorld();
    const traveller = await createUser('Dual Role');
    await addMember(traveller.id, world.teamId, 'lead');
    await addMember(traveller.id, world.otherTeamId, 'member');

    const inA = await createItem(world.member, world.teamId);
    const inB = await createItem(world.outsider, world.otherTeamId);

    expect((await api(traveller).post(`/api/items/${inA.id}/priority`, { priority: 'high' }, { version: 1 })).status).toBe(200);
    expect((await api(traveller).post(`/api/items/${inB.id}/priority`, { priority: 'high' }, { version: 1 })).status).toBe(403);
  });
});

describe('role permissions inside a team', () => {
  it('stops members from assigning, re-prioritising or editing other people\'s items', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const other = api(world.member2);

    expect((await other.post(`/api/items/${item.id}/assign`, { ownerId: world.member2.id }, { version: 1 })).status).toBe(403);
    expect((await other.post(`/api/items/${item.id}/priority`, { priority: 'urgent' }, { version: 1 })).status).toBe(403);
    expect((await other.patch(`/api/items/${item.id}`, { title: 'Not mine' }, { version: 1 })).status).toBe(403);
    expect((await other.post(`/api/items/${item.id}/transitions`, { action: 'cancel', reason: 'not mine' }, { version: 1 })).status).toBe(403);
  });

  it('lets the reporter and the owner edit, and leads edit anything', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    expect((await api(world.member).patch(`/api/items/${item.id}`, { title: 'By reporter' }, { version: 1 })).status).toBe(200);
    expect((await api(world.lead).patch(`/api/items/${item.id}`, { title: 'By lead' }, { version: 2 })).status).toBe(200);
    expect((await api(world.admin).patch(`/api/items/${item.id}`, { title: 'By admin' }, { version: 3 })).status).toBe(200);

    await api(world.member2).post(`/api/items/${item.id}/claim`);
    expect((await api(world.member2).patch(`/api/items/${item.id}`, { title: 'By owner' }, { version: 5 })).status).toBe(200);
  });

  it('lets leads and admins assign and change priority', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    expect((await api(world.lead).post(`/api/items/${item.id}/priority`, { priority: 'high' }, { version: 1 })).status).toBe(200);
    expect((await api(world.admin).post(`/api/items/${item.id}/assign`, { ownerId: world.member2.id }, { version: 2 })).status).toBe(200);
  });

  it('only lets team admins manage membership, and not lower their own role', async () => {
    const world = await createWorld();
    const newcomer = await createUser('Newcomer');

    const asMember = await api(world.member).post(`/api/teams/${world.teamId}/members`, { userId: newcomer.id, role: 'member' });
    const asLead = await api(world.lead).post(`/api/teams/${world.teamId}/members`, { userId: newcomer.id, role: 'member' });
    const asAdmin = await api(world.admin).post(`/api/teams/${world.teamId}/members`, { userId: newcomer.id, role: 'member' });
    const demoteSelf = await api(world.admin).post(`/api/teams/${world.teamId}/members`, { userId: world.admin.id, role: 'member' });
    const unknownUser = await api(world.admin).post(`/api/teams/${world.teamId}/members`, { userId: 999999999, role: 'member' });

    expect(asMember.status).toBe(403);
    expect(asLead.status).toBe(403);
    expect(asAdmin.status).toBe(200);
    expect(demoteSelf.status).toBe(409);
    expect(unknownUser.status).toBe(404);

    expect((await api(newcomer).get(`/api/teams/${world.teamId}/members`)).status).toBe(200);
  });

  it('applies a change of role immediately', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    expect((await api(world.member2).post(`/api/items/${item.id}/priority`, { priority: 'high' }, { version: 1 })).status).toBe(403);
    await addMember(world.member2.id, world.teamId, 'lead');
    expect((await api(world.member2).post(`/api/items/${item.id}/priority`, { priority: 'high' }, { version: 1 })).status).toBe(200);
  });

  it('shows each person only the actions they may take', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);

    const asMember = await api(world.member2).get(`/api/items/${item.id}`);
    const asLead = await api(world.lead).get(`/api/items/${item.id}`);

    expect(asMember.body.item.allowedActions).toEqual(expect.arrayContaining(['comment', 'claim']));
    expect(asMember.body.item.allowedActions).not.toContain('assign');
    expect(asMember.body.item.allowedActions).not.toContain('edit');
    expect(asLead.body.item.allowedActions).toEqual(expect.arrayContaining(['assign', 'change_priority', 'edit']));
  });

  it('keeps comments open to every team member and closed to everyone else', async () => {
    const world = await createWorld();
    const item = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'closed' });

    expect((await api(world.member2).post(`/api/items/${item}/comments`, { body: 'Still talking' })).status).toBe(201);
    expect((await api(world.outsider).post(`/api/items/${item}/comments`, { body: 'Intruder' })).status).toBe(404);
  });
});
