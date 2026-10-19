# Performance

Measured list and search timing on the seeded data, plus what the numbers do and do not show.

## Dataset

Created by `npm run seed` with the defaults:

| Table | Rows |
|---|---:|
| users | 2,005 |
| teams | 12 |
| memberships | 4,033 |
| work_items | 50,000 |
| comments | 150,000 |
| work_item_events | 315,006 |

The signed-in user for the benchmark is `lead@opsdesk.test`, who is in two teams (Customer Support and Payments Ops) containing 8,238 items together.

## How to repeat

```
npm run db:up
npm run migrate
npm run seed
npm run dev          # leave running in one terminal
npm run bench        # run in another terminal
```

`npm run bench` signs in, then sends each request 30 times, one after another, after 3 warm-up requests. Times include the HTTP round trip from the script to the API on the same machine. Settings: `BENCH_SAMPLES`, `BENCH_EMAIL`, `API_URL`, `BENCH_DEEP_PAGES`.

## Results

Measured on a 2 vCPU, 8 GB Linux container with PostgreSQL 16 installed directly (not in Docker), the API started with `npm run dev`, client and server on the same machine. **Re-run `npm run bench` on your own machine before the review and replace this table with your numbers**; Docker Desktop on Windows will give different absolute times.

| Request | p50 ms | p95 ms | max ms | Rows | Response bytes |
|---|---:|---:|---:|---:|---:|
| List, first page (all my teams) | 21.4 | 23.7 | 23.7 | 25+ | 12028 |
| List, one team | 5.0 | 7.2 | 8.6 | 25+ | 11989 |
| List, status + priority filter | 5.5 | 8.2 | 10.2 | 25+ | 12246 |
| List, owner filter | 10.7 | 16.8 | 26.5 | 20 | 9931 |
| View: assigned to me | 4.1 | 7.5 | 10.0 | 12 | 5952 |
| View: unassigned | 4.7 | 11.0 | 14.5 | 25+ | 11596 |
| View: overdue | 5.9 | 8.6 | 8.9 | 25+ | 12601 |
| View: stale | 5.1 | 5.9 | 7.5 | 25+ | 12268 |
| View: awaiting my approval | 5.6 | 7.5 | 8.2 | 25+ | 12796 |
| Search, common word ("refund") | 8.5 | 11.5 | 11.7 | 25+ | 12593 |
| Search, several words | 9.3 | 11.4 | 13.9 | 25+ | 12398 |
| Search, rare account number | 5.0 | 6.7 | 8.7 | 1 | 511 |
| Search + filters | 7.1 | 12.3 | 17.2 | 25+ | 12044 |
| Dashboard counts (attention) | 8.0 | 10.2 | 10.8 | - | 115 |
| Item detail | 3.2 | 4.2 | 4.6 | - | 542 |
| Item timeline, first page | 4.0 | 10.4 | 18.8 | 1 | 221 |
| Notifications | 3.1 | 7.3 | 7.9 | 0 | 70 |

`25+` means a full page of 25 and more available. The seed uses random numbers, so every seed gives slightly different team sizes and timings; the pattern between rows is what matters.

Cursor pagination, first page against the last page reached:

| Walk | Pages reached | Items read | First page ms | Last page ms |
|---|---:|---:|---:|---:|
| All items | 40 | 1000 | 19.3 | 19.4 |
| Search "refund" | 22 | 545 | 7.3 | 5.2 |

## What this shows

- Every list, filter, view, search and dashboard request answered in 25 ms or less at the 95th percentile, with at most 100 rows per response (default 25). The browser and the API never hold the whole dataset.
- Deep pages cost the same as the first page: page 40 took 19.4 ms against 19.3 ms for page 1. That is the reason for cursor (keyset) pagination instead of `OFFSET`, which would get slower with every page.
- Search uses the GIN index on `search_vector`. For "refund" (3,343 matching items across all teams, 545 in this user's teams) the plan combines the search index and the team index with a bitmap AND, then keeps the newest 26.
- The partial indexes behind the attention views (assigned to me, overdue, stale, awaiting approval, unassigned) keep those views as fast as plain lists.

## What this also shows: the slowest case, and why

The first-page list for a user in **two** teams (21 ms) is four times slower than for one team (5 ms). `EXPLAIN ANALYZE` of the real query shows why: PostgreSQL reads all 8,238 items of both teams, joins each to the team and both user tables, and only then sorts and keeps 26. It runs in about 24 ms, and that cost grows with the number of items in the user's teams, not with the page size.

A quick check on the same data (not yet in the code) shows the cure. Choose the 26 newest ids from the index first, then join only those rows:

| Query shape | Execution time |
|---|---:|
| Current: join everything, then sort and limit | 24.2 ms |
| Limit first, joining full rows | 10.9 ms |
| Limit first from the index only, then join 26 rows | about 1.5 to 1.9 ms |

This is the first thing to change if lists need to be faster. It is recorded as limitation 5 in `KNOWN_LIMITATIONS.md`.

## What breaks first at ten times the load

This is reasoning from the plans above, not a measurement.

1. **The multi-team list.** At ten times the items per team, the current shape would take roughly ten times as long (a couple of hundred milliseconds). It is the first thing to fix, and the fix is small.
2. **The worker.** One loop handles jobs one at a time. More workers can run side by side (`SKIP LOCKED`), so this scales by starting more of them, up to the point where the queue competes with user traffic in the same database.
3. **Live connections.** Every change loops over all connected clients in each API process. More API processes spread this out, since each one listens to Postgres itself.
4. **The database connection pool.** Each API process uses up to 20 connections.