# OpsDesk

An internal web app for coordinating operational work: requests, incidents, investigations and approvals. Every item shows what it is and why it exists, its state and importance, who is responsible, what happened before, and what needs attention next. Several people can act on the same work at the same time without overwriting each other.

Built for the Newtonite Software Engineering Challenge ("Operations Under Pressure").

- **Backend:** Node.js, TypeScript, Express, Zod, PostgreSQL 16
- **Async work:** transactional outbox table plus a separate worker process
- **Frontend:** React, TypeScript, Vite, TanStack Query
- **Live updates:** Server-Sent Events that tell the browser to refetch
- **Tests:** Vitest against a real PostgreSQL (147 tests)

## What to read

| Document | What it is |
|---|---|
| [`docs/ENGINEERING_DECISIONS.md`](docs/ENGINEERING_DECISIONS.md) | The decisions that matter, their trade-offs, and which test proves each |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Diagrams: components, what happens on a change, data model |
| [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) | What it does not do, and what we would build next |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Measured list and search timings on 50,000 items |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | A 15-minute walkthrough that shows every critical behaviour |
| [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) | The assumptions the brief left open, including the workflow table |

## Requirements

- Node.js 20 or newer
- Docker Desktop (it only runs the PostgreSQL database)

## Quick start

Run these from the project folder. Use the line for your shell where two are given.

**1. Create the settings file and install packages**

```
Copy-Item .env.example .env        # Windows PowerShell
cp .env.example .env               # macOS, Linux, Git Bash
npm install
```

**2. Start the database and prepare it**

```
npm run db:up
npm run migrate
npm run seed
```

`db:up` starts PostgreSQL in Docker on port 5433. If `migrate` says it cannot connect, wait a few seconds and run it again, the database needs a moment to start. `seed` creates 12 teams, about 2,000 users and 50,000 work items with comments and history, and takes about 20 seconds.

**3. Start the three processes, each in its own terminal**

```
npm run dev          # API on http://localhost:4000
npm run worker       # background worker (creates notifications)
npm run dev:web      # web app on http://localhost:5173
```

**4. Open http://localhost:5173 and sign in**

| Email | Password | Role |
|---|---|---|
| `lead@opsdesk.test` | `password123` | lead in Customer Support, member in Payments Ops |
| `member@opsdesk.test` | `password123` | member in Customer Support |
| `agent2@opsdesk.test` | `password123` | member in Customer Support |
| `admin@opsdesk.test` | `password123` | admin in Customer Support and Payments Ops |
| `outsider@opsdesk.test` | `password123` | member in Compliance only (cannot see Customer Support work) |

The seed also creates about 2,000 more users (`user0001@opsdesk.test` and so on) with the same password.

## See the critical behaviours

With the API running (`npm run dev`):

```
npm run demo:race     # claims, stale edits, retries, workflow rules, team isolation: PASS or FAIL
npm run bench         # list and search timing on the seeded data
```

For the browser side (two windows racing on one item, the worker, failure and recovery) follow [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Run the tests

The database must be running (`npm run db:up`). One command:

```
npm test
```

It creates a separate database called `opsdesk_test` on the same server, applies the migrations to it, and runs all tests against it. Your development data is never touched. The tests refuse to run against any database whose name does not contain `test`.

Other checks:

```
npm run typecheck     # server and web
npm run build:web     # type check and production build of the web app
```

## Common tasks

| Task | Command |
|---|---|
| Start over with an empty database | `npm run db:reset`, then `npm run migrate` and `npm run seed` |
| Open a database prompt | `npm run db:psql` |
| Stop the database | `npm run db:down` |
| Fewer or more rows in the seed | set `SEED_USERS` and `SEED_ITEMS`, for example `SEED_ITEMS=5000` |

## Settings

Read from `.env` in the project folder (copied from `.env.example`).

| Name | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://opsdesk:opsdesk@localhost:5433/opsdesk` | Connection to PostgreSQL |
| `JWT_SECRET` | `dev-only-secret-change-me` | Signs login tokens; at least 16 characters |
| `PORT` | `4000` | API port |
| `POSTGRES_PORT` | `5433` | Port Docker publishes the database on |

If you change `POSTGRES_PORT` or the database name, change `DATABASE_URL` to match. To point the tests at a different database, set the environment variable `TEST_DATABASE_URL` in your shell (it is not read from `.env`); its name must contain `test`.

## How the API behaves

All routes are under `/api`. Send `Authorization: Bearer <token>` (get one from `POST /api/auth/login`). Errors always look like `{"error": {"code", "message", "details"}}`.

| Route | Purpose |
|---|---|
| `POST /auth/login`, `GET /auth/me` | Sign in; current user and team roles |
| `GET /items` | List with `view`, `teamId`, `status`, `priority`, `kind`, `ownerId`, `q` (search), `limit`, `cursor` |
| `GET /items/:id`, `GET /items/:id/events` | Item with allowed actions; paged history |
| `POST /teams/:teamId/items` | Create an item |
| `POST /items/:id/claim` | Atomic claim; exactly one concurrent claimer wins |
| `PATCH /items/:id`, `POST /items/:id/assign`, `/priority`, `/transitions` | Changes; need an `If-Match` version |
| `POST /items/:id/comments` | Comment (never causes an edit conflict) |
| `GET /attention` | Counts for the dashboard |
| `GET /notifications`, `POST /notifications/read` | Notifications |
| `GET /stream` | Server-Sent Events: tells the browser what to refetch |
| `GET`, `POST /teams/:teamId/members` | List members; add or change a member (team admins) |

Headers that matter:

- `If-Match: "<version>"` is required to change an item. A stale version returns `409 version_conflict` with the current item. A missing one returns `428`.
- `Idempotency-Key: <8 to 200 characters>` on any `POST` or `PATCH` makes a repeat return the original response instead of acting twice.

## Project layout

```
server/
  migrations/        schema, indexes, triggers (applied in order)
  src/
    routes/          HTTP endpoints
    services/        business operations and database access
    domain/          workflow rules and list query builder
    auth/            roles, permissions, passwords, tokens
    middleware/      authentication, idempotency, If-Match, team access
    jobs/            background job handlers
    worker.ts        the background worker
    seed.ts          demo data
  scripts/           race-demo.ts and benchmark.ts
  tests/             automated tests
web/src/             React app: pages, components, API client, live updates
docs/                decisions, architecture, limitations, performance, demo script
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `migrate` or `seed` cannot connect | The database is not ready or not running. Run `npm run db:up`, wait a few seconds, and retry |
| Port 5433 already in use | Set `POSTGRES_PORT` and `DATABASE_URL` in `.env` to another port, then `npm run db:up` |
| `Invalid environment configuration` | `.env` is missing. Copy it from `.env.example` |
| Notifications never appear | The worker is not running. Start it with `npm run worker` |
| The Overdue or Stale views are empty | Seed dates are relative to the day you seeded. Run `npm run seed` again |
| `npm test` says it refuses to run | The test database name must contain `test` (the default `opsdesk_test` does) |
| The web app shows network errors | The API is not running on port 4000 (`npm run dev`) |