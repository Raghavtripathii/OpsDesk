export {};

const baseUrl = process.env.API_URL ?? 'http://localhost:4000';
const email = process.env.BENCH_EMAIL ?? 'lead@opsdesk.test';
const password = process.env.DEMO_PASSWORD ?? 'password123';
const samples = Number(process.env.BENCH_SAMPLES ?? 30);
const warmups = 3;
const deepPages = Number(process.env.BENCH_DEEP_PAGES ?? 40);

interface Result {
  name: string;
  p50: number;
  p95: number;
  max: number;
  bytes: number;
  rows: string;
}

let token = '';

async function get(path: string): Promise<{ body: any; ms: number; bytes: number }> {
  const started = performance.now();
  const res = await fetch(baseUrl + path, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  const ms = performance.now() - started;
  if (res.status !== 200) throw new Error(`GET ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  return { body: JSON.parse(text), ms, bytes: Buffer.byteLength(text) };
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1);
  return ordered[Math.max(0, index)] as number;
}

function describeRows(body: any): string {
  if (Array.isArray(body.items)) return `${body.items.length}${body.nextCursor ? '+' : ''}`;
  if (Array.isArray(body.events)) return `${body.events.length}${body.nextCursor ? '+' : ''}`;
  if (Array.isArray(body.notifications)) return `${body.notifications.length}`;
  return '-';
}

async function measure(name: string, path: string): Promise<Result> {
  for (let i = 0; i < warmups; i += 1) await get(path);

  const times: number[] = [];
  let bytes = 0;
  let rows = '-';
  for (let i = 0; i < samples; i += 1) {
    const reply = await get(path);
    times.push(reply.ms);
    bytes = reply.bytes;
    rows = describeRows(reply.body);
  }

  return { name, p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: Math.max(...times), bytes, rows };
}

async function walk(path: string, pages: number): Promise<{ first: number; last: number; reached: number; items: number }> {
  let cursor: string | null = null;
  let first = 0;
  let last = 0;
  let reached = 0;
  let items = 0;

  for (let page = 1; page <= pages; page += 1) {
    const url: string = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
    const reply = await get(url);
    if (page === 1) first = reply.ms;
    last = reply.ms;
    reached = page;
    items += reply.body.items.length;
    cursor = reply.body.nextCursor;
    if (!cursor) break;
  }

  return { first, last, reached, items };
}

function fixed(value: number): string {
  return value.toFixed(1);
}

async function main() {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);

  if (!login || login.status !== 200) {
    throw new Error(`Could not sign in as ${email} at ${baseUrl}. Is the API running and the database seeded?`);
  }
  token = ((await login.json()) as { token: string }).token;

  const me = (await get('/api/auth/me')).body;
  const scopeSize = await get('/api/items?view=all&limit=1');
  const firstItem = scopeSize.body.items[0];
  if (!firstItem) throw new Error('No items visible to this user. Run "npm run seed" first.');

  const scenarios: Array<[string, string]> = [
    ['List, first page (all my teams)', '/api/items?view=all&limit=25'],
    ['List, one team', `/api/items?view=all&limit=25&teamId=${me.teams[0].teamId}`],
    ['List, status + priority filter', '/api/items?view=all&limit=25&status=open,in_progress&priority=urgent,high'],
    ['List, owner filter', `/api/items?view=all&limit=25&ownerId=${me.user.id}`],
    ['View: assigned to me', '/api/items?view=mine&limit=25'],
    ['View: unassigned', '/api/items?view=unassigned&limit=25'],
    ['View: overdue', '/api/items?view=overdue&limit=25'],
    ['View: stale', '/api/items?view=stale&limit=25'],
    ['View: awaiting my approval', '/api/items?view=awaiting_approval&limit=25'],
    ['Search, common word ("refund")', '/api/items?view=all&limit=25&q=refund'],
    ['Search, several words', '/api/items?view=all&limit=25&q=chargeback%20dispute%20evidence'],
    ['Search, rare account number', '/api/items?view=all&limit=25&q=account%201007'],
    ['Search + filters', '/api/items?view=all&limit=25&q=payout&status=open,in_progress&priority=urgent,high,medium'],
    ['Dashboard counts (attention)', '/api/attention'],
    ['Item detail', `/api/items/${firstItem.id}`],
    ['Item timeline, first page', `/api/items/${firstItem.id}/events?limit=30`],
    ['Notifications', '/api/notifications?limit=20'],
  ];

  console.log(`OpsDesk list and search timing against ${baseUrl}`);
  console.log(`Signed in as ${email}, who can see ${me.teams.length} team(s). ${samples} samples per request after ${warmups} warm-ups, one at a time.\n`);

  const results: Result[] = [];
  for (const [name, path] of scenarios) results.push(await measure(name, path));

  console.log('| Request | p50 ms | p95 ms | max ms | Rows | Response bytes |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const r of results) {
    console.log(`| ${r.name} | ${fixed(r.p50)} | ${fixed(r.p95)} | ${fixed(r.max)} | ${r.rows} | ${r.bytes} |`);
  }

  const deepAll = await walk('/api/items?view=all&limit=25', deepPages);
  const deepSearch = await walk('/api/items?view=all&limit=25&q=refund', deepPages);

  console.log('\nCursor pagination: time of the first page against the last page reached');
  console.log('| Walk | Pages reached | Items read | First page ms | Last page ms |');
  console.log('|---|---:|---:|---:|---:|');
  console.log(`| All items | ${deepAll.reached} | ${deepAll.items} | ${fixed(deepAll.first)} | ${fixed(deepAll.last)} |`);
  console.log(`| Search "refund" | ${deepSearch.reached} | ${deepSearch.items} | ${fixed(deepSearch.first)} | ${fixed(deepSearch.last)} |`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});