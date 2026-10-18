import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import {
  addMember,
  api,
  createItem,
  createMembers,
  createUser,
  createWorld,
  insertRawItem,
  uniqueTitle,
  useServer,
} from './helpers.js';

useServer();

async function walk(user: Parameters<typeof api>[0], path: string, limit: number) {
  const ids: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const suffix = cursor ? `&cursor=${cursor}` : '';
    const reply = await api(user).get(`${path}${path.includes('?') ? '&' : '?'}limit=${limit}${suffix}`);
    expect(reply.status).toBe(200);
    ids.push(...reply.body.items.map((item: any) => item.id));
    cursor = reply.body.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error('Pagination did not finish');
}

describe('cursor pagination', () => {
  it('returns every item exactly once, newest activity first', async () => {
    const world = await createWorld();
    const created: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      created.push(
        await insertRawItem({
          teamId: world.teamId,
          reporterId: world.member.id,
          lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }

    const seen = await walk(world.member, `/api/items?teamId=${world.teamId}`, 5);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen).toEqual([...created].reverse());
  });

  it('does not skip or repeat items whose timestamps differ by less than a millisecond', async () => {
    const world = await createWorld();
    const microsecondApart = ['.123100', '.123200', '.123300', '.123400', '.123500'];
    const created: number[] = [];
    for (const fraction of microsecondApart) {
      created.push(
        await insertRawItem({
          teamId: world.teamId,
          reporterId: world.member.id,
          lastActivityAt: `2026-02-02T10:00:00${fraction}Z`,
        }),
      );
    }

    const seen = await walk(world.member, `/api/items?teamId=${world.teamId}`, 1);
    expect(seen).toEqual([...created].reverse());
  });

  it('breaks ties between identical timestamps by id, without gaps or repeats', async () => {
    const world = await createWorld();
    const created: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      created.push(
        await insertRawItem({
          teamId: world.teamId,
          reporterId: world.member.id,
          lastActivityAt: '2026-03-03T03:03:03.333333Z',
        }),
      );
    }

    const seen = await walk(world.member, `/api/items?teamId=${world.teamId}`, 2);
    expect(seen).toEqual([...created].reverse());
  });

  it('stays correct while new items arrive between page requests', async () => {
    const world = await createWorld();
    const original: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      original.push(
        await insertRawItem({
          teamId: world.teamId,
          reporterId: world.member.id,
          lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }

    const first = await api(world.member).get(`/api/items?teamId=${world.teamId}&limit=3`);
    for (let i = 0; i < 3; i += 1) await createItem(world.member, world.teamId);
    const second = await api(world.member).get(`/api/items?teamId=${world.teamId}&limit=3&cursor=${first.body.nextCursor}`);
    const third = await api(world.member).get(`/api/items?teamId=${world.teamId}&limit=3&cursor=${second.body.nextCursor}`);

    const ids = [...first.body.items, ...second.body.items, ...third.body.items].map((item: any) => item.id);
    expect(ids).toEqual([...original].reverse());
  });

  it('rejects broken cursors and cursors from a different view', async () => {
    const world = await createWorld();
    await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, dueAt: '2020-01-01T00:00:00Z' });
    await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, dueAt: '2020-01-02T00:00:00Z' });

    expect((await api(world.member).get('/api/items?cursor=garbage')).status).toBe(400);

    const overdue = await api(world.member).get(`/api/items?view=overdue&teamId=${world.teamId}&limit=1`);
    expect(overdue.body.nextCursor).toBeTruthy();
    const wrongView = await api(world.member).get(`/api/items?view=all&cursor=${overdue.body.nextCursor}`);
    expect(wrongView.status).toBe(400);
    expect(wrongView.body.error.code).toBe('invalid_cursor');
  });

  it('limits page size', async () => {
    const world = await createWorld();
    for (const limit of ['0', '101', '-1', 'abc']) {
      expect((await api(world.member).get(`/api/items?limit=${limit}`)).status).toBe(400);
    }
    expect((await api(world.member).get('/api/items?limit=100')).status).toBe(200);
  });

  it('pages through a team\'s members without repeats', async () => {
    const world = await createWorld();
    await createMembers(world.teamId, 9);

    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const reply: any = await api(world.admin).get(`/api/teams/${world.teamId}/members?limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      expect(reply.status).toBe(200);
      names.push(...reply.body.members.map((member: any) => `${member.name}#${member.id}`));
      cursor = reply.body.nextCursor;
    } while (cursor);

    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(14);
  });
});

describe('filters, search and views', () => {
  it('filters by status, priority, kind and owner, alone or together', async () => {
    const world = await createWorld();
    const a = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'open', priority: 'urgent', kind: 'incident' });
    const b = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'in_progress', ownerId: world.member2.id, priority: 'low', kind: 'task' });
    const c = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'closed', ownerId: world.member2.id, priority: 'urgent', kind: 'incident' });

    const ids = async (query: string) =>
      (await api(world.member).get(`/api/items?teamId=${world.teamId}&${query}`)).body.items.map((item: any) => item.id).sort();

    expect(await ids('status=open')).toEqual([a]);
    expect(await ids('status=open,in_progress')).toEqual([a, b].sort());
    expect(await ids('priority=urgent')).toEqual([a, c].sort());
    expect(await ids('kind=incident&priority=urgent')).toEqual([a, c].sort());
    expect(await ids(`ownerId=${world.member2.id}`)).toEqual([b, c].sort());
    expect(await ids(`ownerId=${world.member2.id}&status=closed`)).toEqual([c]);
    expect((await api(world.member).get('/api/items?status=bogus')).status).toBe(400);
  });

  it('searches titles and descriptions', async () => {
    const world = await createWorld();
    const word = `zyxwv${Math.random().toString(36).slice(2, 8)}`;
    const inTitle = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, title: `Broken ${word} checkout` });
    const inDescription = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, description: `Customer reports ${word} errors` });
    await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, title: 'Unrelated' });

    const found = (await api(world.member).get(`/api/items?q=${word}`)).body.items.map((item: any) => item.id).sort();
    expect(found).toEqual([inTitle, inDescription].sort());

    const punctuation = await api(world.member).get(`/api/items?q=${encodeURIComponent('"(&|!:*')}`);
    expect(punctuation.status).toBe(200);
  });

  it('builds the attention views from the same rules the dashboard counts use', async () => {
    const world = await createWorld();
    const past = '2020-01-01T00:00:00Z';
    const old = '2020-01-01T00:00:00Z';

    const overdue = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'open', dueAt: past });
    await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'closed', ownerId: world.member2.id, dueAt: past });
    const stale = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'open', lastActivityAt: old });
    const unassignedUrgent = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'open', priority: 'urgent' });
    const mine = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'in_progress', ownerId: world.member2.id });
    const awaiting = await insertRawItem({
      teamId: world.teamId,
      reporterId: world.member.id,
      status: 'pending_approval',
      ownerId: world.member2.id,
      requiresApproval: true,
    });
    const ownedByLead = await insertRawItem({
      teamId: world.teamId,
      reporterId: world.member.id,
      status: 'pending_approval',
      ownerId: world.lead.id,
      requiresApproval: true,
    });

    const ids = async (user: Parameters<typeof api>[0], view: string) =>
      (await api(user).get(`/api/items?teamId=${world.teamId}&view=${view}&limit=100`)).body.items.map((item: any) => item.id);

    expect(await ids(world.member, 'unassigned')).toEqual(expect.arrayContaining([overdue, stale, unassignedUrgent]));
    expect(await ids(world.member, 'overdue')).toEqual([overdue]);
    expect(await ids(world.member, 'stale')).toEqual([stale]);
    expect(await ids(world.member2, 'mine')).toEqual(expect.arrayContaining([mine, awaiting]));
    expect(await ids(world.member, 'awaiting_approval')).toEqual([]);
    expect((await ids(world.lead, 'awaiting_approval')).sort()).toEqual([awaiting]);
    expect((await ids(world.lead2, 'awaiting_approval')).sort()).toEqual([awaiting, ownedByLead].sort());

    const counts = (await api(world.lead).get('/api/attention')).body.counts;
    expect(counts.overdue).toBeGreaterThanOrEqual(1);
    expect(counts.unassignedUrgent).toBe(1);
    expect(counts.awaitingApproval).toBe(1);
    expect(counts.assignedToMe).toBe(1);
  });

  it('orders overdue work by due date, soonest first', async () => {
    const world = await createWorld();
    const later = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, dueAt: '2021-06-01T00:00:00Z' });
    const earlier = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, dueAt: '2020-06-01T00:00:00Z' });
    const middle = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, dueAt: '2020-12-01T00:00:00Z' });

    const seen = await walk(world.member, `/api/items?view=overdue&teamId=${world.teamId}`, 1);
    expect(seen).toEqual([earlier, middle, later]);
  });

  it('shows a person only the teams they belong to, including people in several teams', async () => {
    const world = await createWorld();
    const both = await createUser('Both Teams');
    await addMember(both.id, world.teamId, 'member');
    await addMember(both.id, world.otherTeamId, 'member');
    const a = await createItem(world.member, world.teamId, { title: uniqueTitle('In A') });
    const b = await createItem(world.outsider, world.otherTeamId, { title: uniqueTitle('In B') });

    const ids = (await api(both).get('/api/items?limit=100')).body.items.map((item: any) => item.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));

    await pool.query(`DELETE FROM memberships WHERE user_id = $1 AND team_id = $2`, [both.id, world.otherTeamId]);
    const after = (await api(both).get('/api/items?limit=100')).body.items.map((item: any) => item.id);
    expect(after).toContain(a.id);
    expect(after).not.toContain(b.id);
  });
});
