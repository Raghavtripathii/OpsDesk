import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { api, createItem, createMembers, createWorld, eventsFor, insertRawItem, itemRow, useServer, type World } from './helpers.js';

useServer();

const statuses = ['open', 'in_progress', 'pending_approval', 'resolved', 'closed', 'cancelled'] as const;
const actions = ['release', 'request_approval', 'resolve', 'approve', 'reject', 'close', 'reopen', 'cancel'] as const;
type Status = (typeof statuses)[number];
type Action = (typeof actions)[number];

const allowedFrom: Record<Action, Status[]> = {
  release: ['in_progress'],
  request_approval: ['in_progress'],
  resolve: ['in_progress'],
  approve: ['pending_approval'],
  reject: ['pending_approval'],
  close: ['resolved'],
  reopen: ['resolved'],
  cancel: ['open', 'in_progress'],
};

const resultingStatus: Record<Action, Status> = {
  release: 'open',
  request_approval: 'pending_approval',
  resolve: 'resolved',
  approve: 'resolved',
  reject: 'in_progress',
  close: 'closed',
  reopen: 'in_progress',
  cancel: 'cancelled',
};

const needsReason = new Set<Action>(['reject', 'reopen', 'cancel']);

function bodyFor(action: Action) {
  return needsReason.has(action) ? { action, reason: 'A valid reason' } : { action };
}

function requiresApprovalFor(action: Action, status: Status): boolean {
  if (action === 'request_approval') return true;
  if (action === 'resolve') return false;
  return status === 'pending_approval';
}

async function itemIn(world: World, status: Status, requiresApproval: boolean) {
  const needsOwner = status !== 'open' && status !== 'cancelled';
  return insertRawItem({
    teamId: world.teamId,
    reporterId: world.member.id,
    ownerId: needsOwner ? world.member2.id : null,
    status,
    requiresApproval,
    kind: requiresApproval ? 'payment' : 'task',
  });
}

describe('workflow transitions (acting as a lead who neither owns nor reported the item)', () => {
  const cases = actions.flatMap((action) => statuses.map((status) => ({ action, status })));

  it.each(cases)('$action from $status', async ({ action, status }) => {
    const world = await createWorld();
    const id = await itemIn(world, status, requiresApprovalFor(action, status));

    const reply = await api(world.lead).post(`/api/items/${id}/transitions`, bodyFor(action), { version: 1 });

    if (allowedFrom[action].includes(status)) {
      expect(reply.status).toBe(200);
      expect(reply.body.item.status).toBe(resultingStatus[action]);
      expect(reply.body.item.version).toBe(2);
      const events = await eventsFor(id);
      const last = events.filter((event) => event.type === 'status_changed').pop()!;
      expect(last.data).toMatchObject({ from: status, to: resultingStatus[action], action });
    } else {
      expect(reply.status).toBe(409);
      expect(reply.body.error.code).toBe('invalid_transition');
      const row = await itemRow(id);
      expect(row.status).toBe(status);
      expect(row.version).toBe(1);
    }
  });
});

describe('approval rules', () => {
  it('will not resolve an item that needs approval, and will not ask approval for one that does not', async () => {
    const world = await createWorld();
    const needs = await itemIn(world, 'in_progress', true);
    const doesNot = await itemIn(world, 'in_progress', false);

    const resolve = await api(world.lead).post(`/api/items/${needs}/transitions`, { action: 'resolve' }, { version: 1 });
    const ask = await api(world.lead).post(`/api/items/${doesNot}/transitions`, { action: 'request_approval' }, { version: 1 });

    expect(resolve.status).toBe(409);
    expect(resolve.body.error.code).toBe('rule_violation');
    expect(ask.status).toBe(409);
    expect(ask.body.error.code).toBe('rule_violation');
  });

  it('decides approval from the item kind, ignoring what a reporter claims', async () => {
    const world = await createWorld();
    const payment = await createItem(world.member, world.teamId, { kind: 'payment', requiresApproval: false });
    const task = await createItem(world.member, world.teamId, { kind: 'task', requiresApproval: true });

    expect((await itemRow(payment.id)).requires_approval).toBe(true);
    expect((await itemRow(task.id)).requires_approval).toBe(false);
  });

  it('never lets someone approve or reject an item they own', async () => {
    const world = await createWorld();
    const id = await insertRawItem({
      teamId: world.teamId,
      reporterId: world.member.id,
      ownerId: world.lead2.id,
      status: 'pending_approval',
      requiresApproval: true,
      kind: 'payment',
    });

    const approve = await api(world.lead2).post(`/api/items/${id}/transitions`, { action: 'approve' }, { version: 1 });
    const reject = await api(world.lead2).post(`/api/items/${id}/transitions`, { action: 'reject', reason: 'Not good' }, { version: 1 });

    expect(approve.status).toBe(403);
    expect(reject.status).toBe(403);
    expect((await itemRow(id)).status).toBe('pending_approval');
  });

  it('never lets someone approve an item they reported', async () => {
    const world = await createWorld();
    const id = await insertRawItem({
      teamId: world.teamId,
      reporterId: world.lead2.id,
      ownerId: world.member.id,
      status: 'pending_approval',
      requiresApproval: true,
      kind: 'payment',
    });

    const approve = await api(world.lead2).post(`/api/items/${id}/transitions`, { action: 'approve' }, { version: 1 });
    expect(approve.status).toBe(403);

    const byOther = await api(world.lead).post(`/api/items/${id}/transitions`, { action: 'approve' }, { version: 1 });
    expect(byOther.status).toBe(200);
  });

  it('does not let plain members approve', async () => {
    const world = await createWorld();
    const id = await itemIn(world, 'pending_approval', true);
    const reply = await api(world.member2).post(`/api/items/${id}/transitions`, { action: 'approve' }, { version: 1 });
    expect(reply.status).toBe(403);
  });

  it('makes the owner resubmit after a rejection, with the reason on record', async () => {
    const world = await createWorld();
    const id = await itemIn(world, 'pending_approval', true);

    const rejected = await api(world.lead).post(`/api/items/${id}/transitions`, { action: 'reject', reason: 'Missing receipt' }, { version: 1 });
    expect(rejected.status).toBe(200);
    expect(rejected.body.item.status).toBe('in_progress');

    const events = await eventsFor(id);
    expect(events.at(-1)!.data.reason).toBe('Missing receipt');
  });
});

describe('who may move an item', () => {
  it('lets the owner and any lead or admin release an item, and keeps outsiders out', async () => {
    const world = await createWorld();

    const byOwner = await itemIn(world, 'in_progress', false);
    const released = await api(world.member2).post(`/api/items/${byOwner}/transitions`, { action: 'release' }, { version: 1 });
    expect(released.status).toBe(200);
    expect(released.body.item.owner).toBeNull();
    expect(released.body.item.status).toBe('open');

    const byAdmin = await itemIn(world, 'in_progress', false);
    expect((await api(world.admin).post(`/api/items/${byAdmin}/transitions`, { action: 'release' }, { version: 1 })).status).toBe(200);

    const guarded = await itemIn(world, 'in_progress', false);
    expect((await api(world.outsider).post(`/api/items/${guarded}/transitions`, { action: 'release' }, { version: 1 })).status).toBe(404);
  });

  it('keeps uninvolved members from moving an item, and lets the reporter confirm and close it', async () => {
    const world = await createWorld();
    const [uninvolved] = await createMembers(world.teamId, 1);
    const id = await itemIn(world, 'in_progress', false);

    const resolveByUninvolved = await api(uninvolved!).post(`/api/items/${id}/transitions`, { action: 'resolve' }, { version: 1 });
    expect(resolveByUninvolved.status).toBe(403);

    const resolvedByLead = await api(world.lead).post(`/api/items/${id}/transitions`, { action: 'resolve' }, { version: 1 });
    expect(resolvedByLead.status).toBe(200);

    const closeByUninvolved = await api(uninvolved!).post(`/api/items/${id}/transitions`, { action: 'close' }, { version: 2 });
    expect(closeByUninvolved.status).toBe(403);

    const closeByReporter = await api(world.member).post(`/api/items/${id}/transitions`, { action: 'close' }, { version: 2 });
    expect(closeByReporter.status).toBe(200);
    expect(closeByReporter.body.item.status).toBe('closed');
  });

  it('requires a real reason where one is needed', async () => {
    const world = await createWorld();
    const id = await itemIn(world, 'in_progress', false);

    for (const reason of [undefined, '', '   ', 'no']) {
      const reply = await api(world.lead).post(
        `/api/items/${id}/transitions`,
        reason === undefined ? { action: 'cancel' } : { action: 'cancel', reason },
        { version: 1 },
      );
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('reason_required');
    }
    expect((await itemRow(id)).status).toBe('in_progress');
  });

  it('refuses to reopen an item that has no owner to return it to', async () => {
    const world = await createWorld();
    const id = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'resolved', ownerId: null });
    const reply = await api(world.lead).post(`/api/items/${id}/transitions`, { action: 'reopen', reason: 'Came back' }, { version: 1 });
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe('rule_violation');
  });

  it('rejects an unknown action', async () => {
    const world = await createWorld();
    const id = await itemIn(world, 'in_progress', false);
    const reply = await api(world.lead).post(`/api/items/${id}/transitions`, { action: 'teleport' }, { version: 1 });
    expect(reply.status).toBe(400);
  });
});

describe('finished items', () => {
  it('locks closed and cancelled items against edits, assignment and priority changes', async () => {
    const world = await createWorld();
    for (const status of ['closed', 'cancelled'] as const) {
      const id = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status, ownerId: world.member2.id });

      const edit = await api(world.lead).patch(`/api/items/${id}`, { title: 'Reopened by stealth' }, { version: 1 });
      const assign = await api(world.lead).post(`/api/items/${id}/assign`, { ownerId: world.lead.id }, { version: 1 });
      const priority = await api(world.lead).post(`/api/items/${id}/priority`, { priority: 'urgent' }, { version: 1 });

      expect(edit.status).toBe(409);
      expect(edit.body.error.code).toBe('item_locked');
      expect(assign.status).toBe(409);
      expect(priority.status).toBe(409);
      expect((await itemRow(id)).version).toBe(1);
    }
  });

  it('only assigns to active members of the same team', async () => {
    const world = await createWorld();
    const id = await itemIn(world, 'in_progress', false);

    const outsider = await api(world.lead).post(`/api/items/${id}/assign`, { ownerId: world.outsider.id }, { version: 1 });
    expect(outsider.status).toBe(422);
    expect(outsider.body.error.code).toBe('invalid_assignee');

    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [world.member.id]);
    const inactive = await api(world.lead).post(`/api/items/${id}/assign`, { ownerId: world.member.id }, { version: 1 });
    expect(inactive.status).toBe(422);
  });

  it('turns an open item into an active one when it is assigned', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const reply = await api(world.lead).post(`/api/items/${item.id}/assign`, { ownerId: world.member2.id }, { version: 1 });

    expect(reply.body.item.status).toBe('in_progress');
    expect(reply.body.item.owner.id).toBe(world.member2.id);
    expect(reply.body.item.version).toBe(2);
  });
});

describe('database guarantees behind the workflow', () => {
  it('refuses an item whose owner does not match its status', async () => {
    const world = await createWorld();
    const open = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id });
    const active = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id, status: 'in_progress', ownerId: world.member2.id });

    await expect(pool.query(`UPDATE work_items SET owner_id = $2 WHERE id = $1`, [open, world.member2.id])).rejects.toThrow(/owner_matches_status/);
    await expect(pool.query(`UPDATE work_items SET owner_id = NULL WHERE id = $1`, [active])).rejects.toThrow(/owner_matches_status/);
  });

  it('refuses invalid statuses, priorities and kinds', async () => {
    const world = await createWorld();
    const id = await insertRawItem({ teamId: world.teamId, reporterId: world.member.id });

    await expect(pool.query(`UPDATE work_items SET status = 'done' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(pool.query(`UPDATE work_items SET priority = 'whenever' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(pool.query(`UPDATE work_items SET kind = 'rumour' WHERE id = $1`, [id])).rejects.toThrow();
  });

  it('never lets history be edited or deleted', async () => {
    const world = await createWorld();
    const item = await createItem(world.member, world.teamId);
    const [event] = await eventsFor(item.id);

    await expect(pool.query(`UPDATE work_item_events SET type = 'created' WHERE id = $1`, [event!.id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM work_item_events WHERE id = $1`, [event!.id])).rejects.toThrow(/append-only/);
  });
});
