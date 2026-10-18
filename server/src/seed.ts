import { hashPassword } from './auth/password.js';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';

const userTotal = Number(process.env.SEED_USERS ?? 2000);
const itemTotal = Number(process.env.SEED_ITEMS ?? 50000);
const demoPassword = 'password123';

const teamNames = [
  'Customer Support',
  'Payments Ops',
  'Compliance',
  'Platform Engineering',
  'Site Reliability',
  'Finance Ops',
  'Fraud Review',
  'Security',
  'Data Platform',
  'Mobile Engineering',
  'Growth Operations',
  'Vendor Management',
];

const firstNames = ['Aarav', 'Priya', 'Rohan', 'Neha', 'Vikram', 'Ananya', 'Kabir', 'Isha', 'Arjun', 'Meera', 'Sam', 'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Drew', 'Quinn'];
const lastNames = ['Sharma', 'Verma', 'Gupta', 'Singh', 'Patel', 'Iyer', 'Nair', 'Reddy', 'Khan', 'Das', 'Smith', 'Brown', 'Lee', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Clark', 'Lewis', 'Walker'];

type Role = 'member' | 'lead' | 'admin';

interface SeedUser {
  email: string;
  name: string;
  orgAdmin: boolean;
  memberships: Array<{ team: string; role: Role }>;
}

const demoUsers: SeedUser[] = [
  {
    email: 'admin@opsdesk.test',
    name: 'Asha Admin',
    orgAdmin: true,
    memberships: [
      { team: 'Customer Support', role: 'admin' },
      { team: 'Payments Ops', role: 'admin' },
    ],
  },
  {
    email: 'lead@opsdesk.test',
    name: 'Leo Lead',
    orgAdmin: false,
    memberships: [
      { team: 'Customer Support', role: 'lead' },
      { team: 'Payments Ops', role: 'member' },
    ],
  },
  {
    email: 'member@opsdesk.test',
    name: 'Maya Member',
    orgAdmin: false,
    memberships: [{ team: 'Customer Support', role: 'member' }],
  },
  {
    email: 'agent2@opsdesk.test',
    name: 'Aiden Agent',
    orgAdmin: false,
    memberships: [{ team: 'Customer Support', role: 'member' }],
  },
  {
    email: 'outsider@opsdesk.test',
    name: 'Olivia Outsider',
    orgAdmin: false,
    memberships: [{ team: 'Compliance', role: 'member' }],
  },
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function pickRole(): Role {
  const roll = Math.random();
  if (roll < 0.8) return 'member';
  if (roll < 0.95) return 'lead';
  return 'admin';
}

function generatedUsers(count: number): SeedUser[] {
  const users: SeedUser[] = [];
  for (let i = 1; i <= count; i += 1) {
    const teamCount = 1 + Math.floor(Math.random() * 3);
    const chosen = new Set<string>();
    while (chosen.size < teamCount) chosen.add(pick(teamNames));
    users.push({
      email: `user${String(i).padStart(4, '0')}@opsdesk.test`,
      name: `${firstNames[i % firstNames.length]} ${lastNames[(i * 7 + Math.floor(i / 20)) % lastNames.length]}`,
      orgAdmin: false,
      memberships: [...chosen].map((team) => ({ team, role: pickRole() })),
    });
  }
  return users;
}

const insertItemsSql = `
WITH team_members AS MATERIALIZED (
  SELECT team_id, array_agg(user_id ORDER BY user_id) AS ids
  FROM memberships
  GROUP BY team_id
),
team_pool AS MATERIALIZED (
  SELECT array_agg(team_id ORDER BY team_id) AS ids FROM team_members
),
catalog AS (
  SELECT
    ARRAY[
      'Refund not received after cancellation',
      'Customer cannot log in after password reset',
      'Duplicate charge on monthly invoice',
      'Payout stuck in pending for 48 hours',
      'Chargeback dispute needs evidence review',
      'API latency spike on checkout service',
      'Database failover did not complete',
      'Elevated error rate on notification service',
      'Annual access review for finance systems',
      'Data deletion request from EU customer',
      'Vendor security questionnaire overdue',
      'Approve contractor laptop purchase',
      'Update runbook for on-call handover',
      'Reconcile settlement report with ledger',
      'Migrate legacy report to new dashboard'
    ] AS titles,
    ARRAY[
      'customer_issue', 'customer_issue', 'payment', 'payment', 'payment',
      'incident', 'incident', 'incident',
      'compliance', 'compliance', 'compliance',
      'task', 'task', 'task', 'task'
    ] AS kinds
),
gen AS MATERIALIZED (
  SELECT
    g,
    (SELECT ids FROM team_pool)[1 + floor(random() * cardinality((SELECT ids FROM team_pool)))::int] AS team_id,
    random() AS r_status,
    random() AS r_priority,
    random() AS r_title,
    random() AS r_approval,
    random() AS r_due,
    random() AS r_age,
    random() AS r_reporter,
    random() AS r_owner
  FROM generate_series(1, $1::int) AS g
),
shaped AS MATERIALIZED (
  SELECT
    gen.g,
    gen.team_id,
    tm.ids AS member_ids,
    1 + floor(gen.r_title * 15)::int AS title_no,
    CASE
      WHEN gen.r_status < 0.20 THEN 'open'
      WHEN gen.r_status < 0.50 THEN 'in_progress'
      WHEN gen.r_status < 0.58 THEN 'pending_approval'
      WHEN gen.r_status < 0.75 THEN 'resolved'
      WHEN gen.r_status < 0.92 THEN 'closed'
      ELSE 'cancelled'
    END AS status,
    CASE
      WHEN gen.r_priority < 0.07 THEN 'urgent'
      WHEN gen.r_priority < 0.30 THEN 'high'
      WHEN gen.r_priority < 0.80 THEN 'medium'
      ELSE 'low'
    END AS priority,
    gen.r_approval,
    gen.r_due,
    gen.r_reporter,
    gen.r_owner,
    now() - gen.r_age * 120 * interval '1 day' AS created_at
  FROM gen
  JOIN team_members tm ON tm.team_id = gen.team_id
),
timed AS MATERIALIZED (
  SELECT shaped.*, shaped.created_at + random() * (now() - shaped.created_at) AS updated_at
  FROM shaped
)
INSERT INTO work_items (
  team_id, title, description, kind, status, priority, requires_approval,
  reporter_id, owner_id, due_at, created_at, updated_at, last_activity_at
)
SELECT
  s.team_id,
  c.titles[s.title_no] || ' - account ' || (1000 + (s.g::bigint * 7919) % 9000),
  'Raised through the shared queue. Needs investigation, a clear owner and a recorded outcome.',
  c.kinds[s.title_no],
  s.status,
  s.priority,
  s.status = 'pending_approval' OR (s.r_approval < 0.4 AND c.kinds[s.title_no] IN ('payment', 'compliance')),
  s.member_ids[1 + floor(s.r_reporter * cardinality(s.member_ids))::int],
  CASE
    WHEN s.status = 'open' THEN NULL
    WHEN s.status = 'cancelled' AND s.r_owner < 0.5 THEN NULL
    ELSE s.member_ids[1 + floor(s.r_owner * cardinality(s.member_ids))::int]
  END,
  CASE WHEN s.r_due < 0.65 THEN now() + (s.r_due / 0.65 * 40 - 25) * interval '1 day' END,
  s.created_at,
  s.updated_at,
  s.updated_at
FROM timed s
CROSS JOIN catalog c
`;

const insertCommentsSql = `
INSERT INTO comments (item_id, author_id, body, created_at)
SELECT
  i.id,
  tm.ids[1 + floor(random() * cardinality(tm.ids))::int],
  (ARRAY[
    'Looking into this now.',
    'Waiting on a reply from the customer.',
    'Escalated to the platform team.',
    'Confirmed the issue, working on a fix.',
    'Needs approval before we proceed.',
    'Followed up, no response yet.'
  ])[1 + floor(random() * 6)::int],
  i.created_at + random() * (i.updated_at - i.created_at)
FROM work_items i
JOIN (
  SELECT team_id, array_agg(user_id ORDER BY user_id) AS ids
  FROM memberships
  GROUP BY team_id
) tm ON tm.team_id = i.team_id
CROSS JOIN LATERAL generate_series(1, floor(random() * 4)::int) AS n
`;

const insertEventsSql = `
INSERT INTO work_item_events (item_id, actor_id, type, data, created_at)
SELECT item_id, actor_id, type, data, created_at
FROM (
  SELECT id AS item_id, reporter_id AS actor_id, 'created' AS type,
    jsonb_build_object('kind', kind, 'priority', priority) AS data, created_at
  FROM work_items
  UNION ALL
  SELECT id, reporter_id, 'owner_changed',
    jsonb_build_object('from', NULL, 'to', owner_id),
    created_at + (updated_at - created_at) * 0.10
  FROM work_items WHERE owner_id IS NOT NULL
  UNION ALL
  SELECT id, COALESCE(owner_id, reporter_id), 'status_changed',
    jsonb_build_object('from', 'open', 'to', 'in_progress'),
    created_at + (updated_at - created_at) * 0.20
  FROM work_items WHERE status IN ('in_progress', 'pending_approval', 'resolved', 'closed')
  UNION ALL
  SELECT id, COALESCE(owner_id, reporter_id), 'status_changed',
    jsonb_build_object('from', 'in_progress', 'to', 'pending_approval'),
    created_at + (updated_at - created_at) * 0.50
  FROM work_items
  WHERE status = 'pending_approval' OR (requires_approval AND status IN ('resolved', 'closed'))
  UNION ALL
  SELECT id, COALESCE(owner_id, reporter_id), 'status_changed',
    jsonb_build_object('from', CASE WHEN requires_approval THEN 'pending_approval' ELSE 'in_progress' END, 'to', 'resolved'),
    created_at + (updated_at - created_at) * 0.70
  FROM work_items WHERE status IN ('resolved', 'closed')
  UNION ALL
  SELECT id, COALESCE(owner_id, reporter_id), 'status_changed',
    jsonb_build_object('from', 'resolved', 'to', 'closed'),
    created_at + (updated_at - created_at) * 0.90
  FROM work_items WHERE status = 'closed'
  UNION ALL
  SELECT id, COALESCE(owner_id, reporter_id), 'status_changed',
    jsonb_build_object('from', 'open', 'to', 'cancelled'),
    created_at + (updated_at - created_at) * 0.80
  FROM work_items WHERE status = 'cancelled'
  UNION ALL
  SELECT id, reporter_id, 'priority_changed',
    jsonb_build_object('from', 'medium', 'to', priority),
    created_at + (updated_at - created_at) * 0.30
  FROM work_items WHERE id % 5 = 0 AND priority <> 'medium'
  UNION ALL
  SELECT item_id, author_id, 'comment_added',
    jsonb_build_object('commentId', id),
    created_at
  FROM comments
) e
ORDER BY created_at, item_id
`;

async function seed() {
  if (config.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database');
  }

  const started = Date.now();
  const passwordHash = await hashPassword(demoPassword);
  const users = [...demoUsers, ...generatedUsers(userTotal)];

  await withTransaction(async (client) => {
    await client.query(
      'TRUNCATE notifications, outbox_jobs, idempotency_keys, comments, work_item_events, work_items, memberships, teams, users RESTART IDENTITY CASCADE',
    );

    const teamRows = await client.query<{ id: number; name: string }>(
      `INSERT INTO teams (name)
       SELECT name FROM unnest($1::text[]) WITH ORDINALITY AS t(name, n) ORDER BY n
       RETURNING id, name`,
      [teamNames],
    );
    const teamIds = new Map(teamRows.rows.map((team) => [team.name, team.id]));

    const userRows = await client.query<{ id: number; email: string }>(
      `INSERT INTO users (email, name, password_hash, is_org_admin)
       SELECT email, name, $3::text, org_admin
       FROM unnest($1::text[], $2::text[], $4::boolean[]) WITH ORDINALITY AS u(email, name, org_admin, n)
       ORDER BY n
       RETURNING id, email`,
      [users.map((u) => u.email), users.map((u) => u.name), passwordHash, users.map((u) => u.orgAdmin)],
    );
    const userIds = new Map(userRows.rows.map((user) => [user.email, user.id]));

    const memberUsers: number[] = [];
    const memberTeams: number[] = [];
    const memberRoles: Role[] = [];
    for (const user of users) {
      for (const membership of user.memberships) {
        const userId = userIds.get(user.email);
        const teamId = teamIds.get(membership.team);
        if (userId === undefined || teamId === undefined) throw new Error('Seed data is inconsistent');
        memberUsers.push(userId);
        memberTeams.push(teamId);
        memberRoles.push(membership.role);
      }
    }

    await client.query(
      `INSERT INTO memberships (user_id, team_id, role)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[])`,
      [memberUsers, memberTeams, memberRoles],
    );

    await client.query("SET LOCAL opsdesk.skip_outbox = 'on'");
    await client.query(insertItemsSql, [itemTotal]);
    await client.query(insertCommentsSql);
    await client.query(insertEventsSql);
  });

  await pool.query('ANALYZE');

  const counts = await pool.query<{ table: string; total: number }>(`
    SELECT 'users' AS "table", count(*) AS total FROM users
    UNION ALL SELECT 'teams', count(*) FROM teams
    UNION ALL SELECT 'memberships', count(*) FROM memberships
    UNION ALL SELECT 'work_items', count(*) FROM work_items
    UNION ALL SELECT 'comments', count(*) FROM comments
    UNION ALL SELECT 'work_item_events', count(*) FROM work_item_events
  `);

  for (const row of counts.rows) console.log(`${row.table}: ${row.total}`);
  console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`demo accounts (password ${demoPassword}):`);
  for (const user of demoUsers) console.log(`  ${user.email}`);
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
