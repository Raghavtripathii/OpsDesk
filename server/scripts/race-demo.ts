export {};

const baseUrl = process.env.API_URL ?? 'http://localhost:4000';
const password = process.env.DEMO_PASSWORD ?? 'password123';
const claimers = Number(process.env.RACE_CLAIMERS ?? 10);
const duplicateRequests = Number(process.env.RACE_DUPLICATES ?? 5);

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

interface Session {
  email: string;
  token: string;
}

interface Call {
  version?: number;
  key?: string;
}

let passed = 0;
let failed = 0;

function section(title: string) {
  console.log(`\n${title}`);
}

function check(label: string, ok: boolean, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function request(session: Session | null, method: string, path: string, body?: unknown, call: Call = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session) headers.authorization = `Bearer ${session.token}`;
  if (call.version !== undefined) headers['if-match'] = `"${call.version}"`;
  if (call.key) headers['idempotency-key'] = call.key;

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function login(email: string): Promise<Session> {
  const res = await request(null, 'POST', '/api/auth/login', { email, password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email} (${res.status}). Did you run "npm run seed"?`);
  }
  return { email, token: res.body.token };
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function same(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function newItem(session: Session, teamId: number, overrides: Record<string, unknown> = {}) {
  const res = await request(session, 'POST', `/api/teams/${teamId}/items`, {
    title: `[race-demo] ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`,
    kind: 'task',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`Could not create item: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.item as { id: number; version: number; title: string; requiresApproval: boolean };
}

async function claimRace(member: Session, teamId: number, racers: Session[]) {
  section(`1. Atomic claim: ${racers.length} people claim the same item at the same instant`);

  const item = await newItem(member, teamId);
  const replies = await Promise.all(racers.map((racer) => request(racer, 'POST', `/api/items/${item.id}/claim`)));

  const winners = replies.filter((reply) => reply.status === 200 && reply.body.changed === true);
  const losers = replies.filter((reply) => reply.status === 409 && reply.body.error?.code === 'already_claimed');
  const other = replies.length - winners.length - losers.length;

  check('exactly one request won', winners.length === 1, `${winners.length} winners`);
  check('every other request was told who owns the item', losers.length === racers.length - 1, `${losers.length} losers`);
  check('no request failed in any other way', other === 0, `${other} unexpected`);

  const final = await request(member, 'GET', `/api/items/${item.id}`);
  const winnerId = winners[0]?.body.item.owner.id;
  check('the stored owner is the winner', final.body.item.owner?.id === winnerId);
  check('the item version went up by exactly one', final.body.item.version === item.version + 1, `v${item.version} -> v${final.body.item.version}`);

  const timeline = await request(member, 'GET', `/api/items/${item.id}/events?limit=50`);
  const ownerEvents = timeline.body.events.filter((event: { type: string }) => event.type === 'owner_changed');
  check('history holds exactly one ownership change', ownerEvents.length === 1, `${ownerEvents.length} events`);
}

async function staleWrite(member: Session, teamId: number, first: Session, second: Session) {
  section('2. Version check: two leads edit the same version at the same instant');

  const item = await newItem(member, teamId);
  const replies = await Promise.all([
    request(first, 'PATCH', `/api/items/${item.id}`, { title: '[race-demo] edit from first lead' }, { version: item.version }),
    request(second, 'PATCH', `/api/items/${item.id}`, { title: '[race-demo] edit from second lead' }, { version: item.version }),
  ]);

  const statuses = sorted(replies.map((reply) => reply.status));
  check('one edit accepted and one rejected', same(statuses, [200, 409]), `statuses ${statuses.join(', ')}`);

  const rejected = replies.find((reply) => reply.status === 409);
  const accepted = replies.find((reply) => reply.status === 200);
  check('the rejection is a version_conflict', rejected?.body.error?.code === 'version_conflict');
  check('the rejection carries the current item so the client can recover', rejected?.body.error?.details?.current?.id === item.id);

  const final = await request(member, 'GET', `/api/items/${item.id}`);
  check('the stored title is the accepted edit, nothing was overwritten', final.body.item.title === accepted?.body.item.title);
  check('the item version went up by exactly one', final.body.item.version === item.version + 1, `v${item.version} -> v${final.body.item.version}`);

  const stale = await request(first, 'PATCH', `/api/items/${item.id}`, { title: '[race-demo] late edit' }, { version: item.version });
  check('a later edit with the old version is rejected', stale.status === 409);

  const missing = await request(first, 'PATCH', `/api/items/${item.id}`, { title: '[race-demo] no version' });
  check('an edit with no version is refused outright', missing.status === 428, `status ${missing.status}`);
}

async function idempotentRetry(member: Session, teamId: number) {
  section(`3. Idempotency: the same create request is sent ${duplicateRequests} times at once`);

  const key = `race-demo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const title = `[race-demo] idempotent ${key}`;
  const payload = { title, kind: 'task' };

  const replies = await Promise.all(
    Array.from({ length: duplicateRequests }, () => request(member, 'POST', `/api/teams/${teamId}/items`, payload, { key })),
  );

  const created = replies.filter((reply) => reply.status === 201);
  const ids = new Set(created.map((reply) => reply.body.item.id));
  const replayed = replies.filter((reply) => reply.headers.get('idempotent-replayed') === 'true');

  check('every request got the same success response', created.length === duplicateRequests, `${created.length} of ${duplicateRequests}`);
  check('they all point at one item', ids.size === 1, `${ids.size} distinct items`);
  check('all but one were replays of the stored response', replayed.length === duplicateRequests - 1, `${replayed.length} replays`);

  const found = await request(member, 'GET', `/api/items?view=all&q=${encodeURIComponent(key)}&limit=10`);
  check('the database holds exactly one such item', found.body.items.length === 1, `${found.body.items.length} rows`);

  const again = await request(member, 'POST', `/api/teams/${teamId}/items`, payload, { key });
  check('retrying later returns the original response', again.status === 201 && again.headers.get('idempotent-replayed') === 'true');

  const reuse = await request(member, 'POST', `/api/teams/${teamId}/items`, { title: 'something else', kind: 'task' }, { key });
  check('reusing the key for a different request is refused', reuse.status === 422, `status ${reuse.status}`);
}

async function workflowRules(member: Session, actor: Session, teamId: number) {
  section('4. Workflow rules are decided by the server');

  const plain = await newItem(member, teamId);
  const closeOpen = await request(actor, 'POST', `/api/items/${plain.id}/transitions`, { action: 'close' }, { version: plain.version });
  check('closing an item that is still open is refused', closeOpen.status === 409 && closeOpen.body.error.code === 'invalid_transition');

  const payment = await newItem(member, teamId, { kind: 'payment', requiresApproval: false });
  check('a payment item needs approval even though the client said it does not', payment.requiresApproval === true);
  const claimed = await request(actor, 'POST', `/api/items/${payment.id}/claim`);
  const resolve = await request(
    actor,
    'POST',
    `/api/items/${payment.id}/transitions`,
    { action: 'resolve' },
    { version: claimed.body.item.version },
  );
  check('resolving an item that needs approval is refused', resolve.status === 409 && resolve.body.error.code === 'rule_violation');

  const selfApprove = await request(
    actor,
    'POST',
    `/api/items/${payment.id}/transitions`,
    { action: 'request_approval' },
    { version: claimed.body.item.version },
  );
  check('the owner can send it for approval', selfApprove.status === 200 && selfApprove.body.item.status === 'pending_approval');

  const approveOwn = await request(
    actor,
    'POST',
    `/api/items/${payment.id}/transitions`,
    { action: 'approve' },
    { version: selfApprove.body.item.version },
  );
  check('the owner cannot approve their own item', approveOwn.status === 403, `status ${approveOwn.status}`);
}

async function teamIsolation(member: Session, teamId: number, outsider: Session) {
  section('5. Authorization: a user from another team cannot see or touch the item');

  const item = await newItem(member, teamId);
  const read = await request(outsider, 'GET', `/api/items/${item.id}`);
  const claim = await request(outsider, 'POST', `/api/items/${item.id}/claim`);
  const edit = await request(outsider, 'PATCH', `/api/items/${item.id}`, { title: 'hijack' }, { version: item.version });
  const comment = await request(outsider, 'POST', `/api/items/${item.id}/comments`, { body: 'hello' });
  const search = await request(outsider, 'GET', `/api/items?view=all&q=${encodeURIComponent(item.title)}&limit=10`);

  check('reading it returns 404', read.status === 404);
  check('claiming it returns 404', claim.status === 404);
  check('editing it returns 404', edit.status === 404);
  check('commenting on it returns 404', comment.status === 404);
  check('it does not appear in their search results', search.status === 200 && search.body.items.length === 0);

  const stillOpen = await request(member, 'GET', `/api/items/${item.id}`);
  check('the item is unchanged', stillOpen.body.item.status === 'open' && stillOpen.body.item.version === item.version);
}

async function main() {
  console.log(`OpsDesk critical-behaviour demo against ${baseUrl}`);

  const health = await request(null, 'GET', '/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    throw new Error(`The API is not reachable at ${baseUrl}. Start it with "npm run dev".`);
  }

  const [member, lead, admin, outsider] = await Promise.all([
    login('member@opsdesk.test'),
    login('lead@opsdesk.test'),
    login('admin@opsdesk.test'),
    login('outsider@opsdesk.test'),
  ]);

  const me = await request(member, 'GET', '/api/auth/me');
  const team = (me.body.teams as Array<{ teamId: number; teamName: string }>).find((entry) => entry.teamName === 'Customer Support');
  if (!team) throw new Error('The demo member is not in Customer Support. Re-run "npm run seed".');

  const roster = await request(member, 'GET', `/api/teams/${team.teamId}/members?limit=100`);
  const emails = (roster.body.members as Array<{ email: string }>)
    .map((entry) => entry.email)
    .filter((email) => email !== 'member@opsdesk.test');
  const racerEmails = ['member@opsdesk.test', ...emails].slice(0, claimers);
  const racers = await Promise.all(racerEmails.map(login));

  await claimRace(member, team.teamId, racers);
  await staleWrite(member, team.teamId, lead, admin);
  await idempotentRetry(member, team.teamId);
  await workflowRules(member, admin, team.teamId);
  await teamIsolation(member, team.teamId, outsider);

  console.log(`\n${passed} checks passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});