import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { signToken } from '../src/auth/tokens.js';
import { pool } from '../src/db.js';
import { claimJobs, markDone, markFailed } from '../src/services/outbox.js';
import { handlers } from '../src/jobs/handlers.js';

if (!/test/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Tests must run against a database whose name contains "test"');
}

export interface TestUser {
  id: number;
  name: string;
  token: string;
}

export interface World {
  teamId: number;
  otherTeamId: number;
  member: TestUser;
  member2: TestUser;
  lead: TestUser;
  lead2: TestUser;
  admin: TestUser;
  outsider: TestUser;
}

export interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

export interface CallOptions {
  version?: number | string;
  key?: string;
  headers?: Record<string, string>;
}

const state = { baseUrl: '' };
let passwordHash: string | null = null;

export function useServer() {
  let server: Server;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  return state;
}

export function useDatabase() {
  afterAll(async () => {
    await pool.end();
  });
}

export function api(user?: TestUser) {
  async function call(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
    if (user) headers.authorization = `Bearer ${user.token}`;
    if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
    if (options.key) headers['idempotency-key'] = options.key;

    const res = await fetch(state.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  return {
    get: (path: string, options?: CallOptions) => call('GET', path, undefined, options),
    post: (path: string, body?: unknown, options?: CallOptions) => call('POST', path, body, options),
    patch: (path: string, body?: unknown, options?: CallOptions) => call('PATCH', path, body, options),
  };
}

export async function createUser(label: string, tag: string = randomUUID().slice(0, 8)): Promise<TestUser> {
  passwordHash ??= await hashPassword('password-not-used-in-tests');
  const name = `${label} ${tag}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [`${label.toLowerCase().replace(/\s+/g, '.')}.${tag}@test.local`, name, passwordHash],
  );
  const id = rows[0]!.id;
  return { id, name, token: signToken(id) };
}

export async function addMember(userId: number, teamId: number, role: 'member' | 'lead' | 'admin') {
  await pool.query(
    `INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, teamId, role],
  );
}

export async function createWorld(): Promise<World> {
  const tag = randomUUID().slice(0, 8);

  const teams = await pool.query<{ id: number }>(
    `INSERT INTO teams (name) VALUES ($1), ($2) RETURNING id`,
    [`Team A ${tag}`, `Team B ${tag}`],
  );
  const teamId = teams.rows[0]!.id;
  const otherTeamId = teams.rows[1]!.id;

  const [member, member2, lead, lead2, admin, outsider] = await Promise.all(
    ['Maya Member', 'Mick Member', 'Leo Lead', 'Lena Lead', 'Asha Admin', 'Olivia Outsider'].map((label) =>
      createUser(label, tag),
    ),
  ) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];

  await addMember(member.id, teamId, 'member');
  await addMember(member2.id, teamId, 'member');
  await addMember(lead.id, teamId, 'lead');
  await addMember(lead2.id, teamId, 'lead');
  await addMember(admin.id, teamId, 'admin');
  await addMember(outsider.id, otherTeamId, 'member');

  return { teamId, otherTeamId, member, member2, lead, lead2, admin, outsider };
}

export async function createMembers(teamId: number, count: number): Promise<TestUser[]> {
  const tag = randomUUID().slice(0, 8);
  const users = await Promise.all(Array.from({ length: count }, (_, i) => createUser(`Bulk ${i}`, tag)));
  for (const user of users) await addMember(user.id, teamId, 'member');
  return users;
}

export async function createItem(
  user: TestUser,
  teamId: number,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const res = await api(user).post(`/api/teams/${teamId}/items`, {
    title: `Test item ${randomUUID().slice(0, 8)}`,
    kind: 'task',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`Could not create item: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.item;
}

export interface RawItem {
  teamId: number;
  reporterId: number;
  ownerId?: number | null;
  status?: string;
  kind?: string;
  priority?: string;
  requiresApproval?: boolean;
  title?: string;
  description?: string;
  dueAt?: string | null;
  lastActivityAt?: string;
}

export async function insertRawItem(raw: RawItem): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO work_items
       (team_id, title, description, kind, status, priority, requires_approval, reporter_id, owner_id, due_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()))
     RETURNING id`,
    [
      raw.teamId,
      raw.title ?? `Raw item ${randomUUID().slice(0, 8)}`,
      raw.description ?? '',
      raw.kind ?? 'task',
      raw.status ?? 'open',
      raw.priority ?? 'medium',
      raw.requiresApproval ?? false,
      raw.reporterId,
      raw.ownerId ?? null,
      raw.dueAt ?? null,
      raw.lastActivityAt ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function itemRow(itemId: number) {
  const { rows } = await pool.query(`SELECT * FROM work_items WHERE id = $1`, [itemId]);
  return rows[0]!;
}

export async function eventsFor(itemId: number) {
  const { rows } = await pool.query(`SELECT * FROM work_item_events WHERE item_id = $1 ORDER BY id`, [itemId]);
  return rows as Array<{ id: number; type: string; actor_id: number | null; data: Record<string, any> }>;
}

export async function countRows(table: string, where: string, values: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
  return rows[0]!.n;
}

export async function drainQueue(maxRounds = 20): Promise<number> {
  let processed = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const jobs = await claimJobs();
    if (jobs.length === 0) return processed;
    for (const job of jobs) {
      try {
        const handler = handlers[job.type];
        if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
        await handler(job.payload);
        await markDone(job.id);
      } catch (err) {
        await markFailed(job, err);
      }
      processed += 1;
    }
  }
  return processed;
}

export function uniqueTitle(prefix = 'Item'): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}
