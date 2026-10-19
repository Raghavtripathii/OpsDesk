# Engineering Decisions

Six decisions shaped OpsDesk. Each one says what we chose, what it costs, what we rejected, and which test proves it. The brief asked for at least three critical behaviours; we built six, and every one of them is listed here and covered by the automated tests (`npm test`, 147 tests).

| Critical behaviour | Decision | Main test file |
|---|---|---|
| C1 Atomic claim, one winner | 2 | `tests/concurrency.test.ts` |
| C2 Stale write rejection | 2 | `tests/versioning.test.ts`, `tests/concurrency.test.ts` |
| C3 Idempotent retries | 3 | `tests/idempotency.test.ts` |
| C4 Workflow rules enforced by the server | 5 | `tests/workflow.test.ts` |
| C5 Resource-level authorization | 4 | `tests/authorization.test.ts` |
| C6 Reliable async processing, safe if run twice | 1 | `tests/outbox.test.ts` |

You can watch C1, C2, C3, C4 and C5 happen against a running server with `npm run demo:race`.

---

## 1. PostgreSQL only, with the outbox in the same database

**Decision.** There is no message broker. Background work is a table, `outbox_jobs`. A database trigger on `work_item_events` inserts one job for every event, in the same transaction that wrote the event. A separate worker process (`npm run worker`) claims jobs with `FOR UPDATE SKIP LOCKED`, runs the handler, and marks the job done.

**Why.**
- The change and the promise to notify about it commit together or not at all. There is no window where an item changed but the job was lost, and no job exists for a change that rolled back.
- Because the trigger sits on the events table, every code path that records history queues its job automatically. A developer cannot forget to enqueue. (`tests/outbox.test.ts`: "queues exactly one job per real action, whichever code path made the event".)
- Delivery is at-least-once. The handler is written to be safe when run twice: the job has a unique `dedupe_key` (`item_event:<eventId>`) and each notification has a unique `(user_id, dedupe_key)`, with `ON CONFLICT DO NOTHING`. At-least-once plus an idempotent handler gives the same result as exactly-once. (`tests/outbox.test.ts`: "delivers once even when two workers handle the same event at the same moment".)
- Failure handling is plain SQL: a failed job goes back to `pending` with exponential backoff (5 s doubling, capped at 300 s, with plus or minus 25 percent jitter). After `max_attempts` (5) it becomes `dead` and keeps `last_error`. A job stuck in `processing` for more than 5 minutes (a crashed worker) is put back by `requeueStuckJobs`. Finished jobs are deleted after 7 days.
- One system to run, back up and reason about.

**What it costs.**
- The worker polls once a second when idle, so a notification can arrive up to about a second late.
- The queue shares the primary database. A very high job rate would compete with user traffic. We have not measured the worker's throughput.
- If a handler runs longer than 5 minutes it may be handed to a second worker. This is safe only because handlers are idempotent.

**Rejected.** Redis, RabbitMQ or Kafka. They add a second system and a second failure mode (the database commits but the publish fails), and the "write the change and publish the message" problem is exactly what the outbox exists to avoid. We would move to a broker only when job volume outgrows what one Postgres can queue.

**Code.** `server/migrations/003_outbox_triggers.sql`, `server/src/services/outbox.ts`, `server/src/worker.ts`, `server/src/jobs/`.

---

## 2. Version numbers (optimistic concurrency) instead of long-held locks

**Decision.** Every work item has an integer `version` that goes up by one on every change. A client changing an item must send the version it saw in an `If-Match` header. Inside one short transaction the server locks the item row (`SELECT ... FOR UPDATE`), compares the version, applies the change, writes the history events, and commits. A mismatch returns `409 version_conflict` together with the current item, so the client can show the truth without another request. A missing header returns `428`.

Claiming is the one exception: it is a single conditional statement, `UPDATE ... WHERE id = $1 AND status = 'open' AND owner_id IS NULL`. The database lets exactly one concurrent claim match. The others get `409 already_claimed` with the owner's name. A repeat claim by the person who already won succeeds and changes nothing.

**Why.**
- Nobody holds a lock while a person thinks. The lock lasts only for the length of one transaction.
- Two people editing from the same screen cannot silently overwrite each other. Last-write-wins would lose data without any sign.
- The conflict response contains everything the interface needs to recover, so the web app shows a banner and the latest data instead of an error page.
- Comments do not change the version. Discussion never causes an edit conflict. (`tests/concurrency.test.ts`: ten simultaneous comments, no conflicts, no version change.)
- Claim needs no version because "who got there first" is the whole question; forcing the user to retry a claim after someone else claimed would be pointless.

**What it costs.**
- A user who loses a race must look at the new state and try again. That is the point, but it is one more step.
- A very hot item serialises its writers on the row lock. This is fine for human-speed work and would not be fine for counters.
- Clients must remember to send the header. The server enforces it with `428`, so forgetting fails loudly.

**Rejected.**
- Pessimistic locks held across a user session ("checked out" items): they strand work when someone closes a tab.
- Last-write-wins: simplest, but loses updates.
- `SERIALIZABLE` transactions with automatic retries: correct, but the error a person sees is a generic failure instead of a specific "someone else changed this".

**Code.** `server/src/services/itemMutations.ts` (`runMutation`), `server/src/services/itemService.ts` (`claimItem`), `server/src/middleware/ifMatch.ts`.

---

## 3. Idempotency keys stored in the database

**Decision.** Any `POST` or `PATCH` may carry an `Idempotency-Key` header (8 to 200 safe characters). The key is stored in `idempotency_keys` with the user, a hash of the request (method, URL, `If-Match`, body), and later the response status and body. The web app sends a fresh key for every user action and reuses it when it retries after a network failure.

How the server treats a repeat:

| Situation | Result |
|---|---|
| Same user, same key, same request, first one finished | The stored response is replayed, header `Idempotent-Replayed: true`, nothing is done again |
| Same key, first request still running | The repeat waits up to 3 seconds for the result, then answers `409 request_in_progress` with `Retry-After` |
| Same key, different request | `422 idempotency_key_reuse`, nothing is done |
| First request failed with a 5xx | The key is released so a retry can really run |
| First request failed with a 4xx | The failure is stored and replayed (the same request would fail the same way) |
| First request was abandoned (process died) for over 60 seconds | A retry takes the key over and runs |
| Different user, same key | Independent. Keys are scoped to the user |

Keys are deleted after 24 hours by the worker.

**Why.** A user on a bad connection cannot know whether a request succeeded. Retrying must be safe. Keeping keys in Postgres means the check works across several API processes with no extra infrastructure, and survives a restart. A primary key on `(user_id, key)` plus `INSERT ... ON CONFLICT DO NOTHING` decides who owns a key, so five identical requests sent at the same instant create one item. (`tests/idempotency.test.ts`.)

**What it costs.**
- One extra write on the key row at the start and another at the end of every keyed request.
- The key is optional on the server. A client that never sends one gets no protection. The web app always sends one.
- The key is recorded just after the business transaction commits, not inside it. If the API process dies in that gap, the key stays `in_progress`, and a retry after 60 seconds runs the action again. For edits this is harmless because the old `If-Match` version no longer matches and the server answers `409`. For item creation it could create a second item. See `KNOWN_LIMITATIONS.md`.

**Rejected.** An in-memory map (lost on restart, wrong with more than one API process), Redis (a new system), and making the key mandatory (it would break simple API clients; `If-Match` already protects most writes).

**Code.** `server/src/middleware/idempotency.ts`, `server/src/services/idempotencyStore.ts`.

---

## 4. Per-team roles and resource-level authorization

**Decision.** A role belongs to a membership, not to a user: one person can be `member` in one team and `lead` in another. The permission table is one small file (`server/src/auth/permissions.ts`) mapping each role to the actions it may perform. Authorization is decided on the server for every request, starting from the resource:

- For an item, the server joins the item to the caller's membership in the item's team. No membership means `404`, exactly as if the item did not exist, so nobody can probe for other teams' items. A membership with too low a role means `403`.
- List, search, counts and the live stream are limited in SQL by `team_id = ANY(the caller's teams)`. There is no "fetch then filter".
- Rules that depend on the item and the person together live in `domain/workflow.ts`. For example nobody can approve or reject an item they own or reported.
- Being an organisation admin (`is_org_admin`) gives no access to a team's work. (`tests/authorization.test.ts`.)
- The web app only shows the actions the server lists in `allowedActions`, but hiding a button is a courtesy. Removing the button changes nothing about what the server accepts.

**Why.** The brief asks for several teams, mixed roles, and "not every user can do every action". Every item route (read, claim, edit, assign, priority, transitions, comments, timeline) starts by loading the item through the caller's membership (`loadItemForUser`), so a route cannot hand back or change an item the caller has no right to. The tests cover the matrix of role by action by team.

**What it costs.**
- One membership lookup per request. We did not cache it, so a role change takes effect on the next request (tested: "applies a change of role immediately"). With a cache we would need an invalidation story.
- The token holds only the user id, never roles. Tokens last 8 hours. Deactivating a user (`is_active = false`) takes effect immediately because it is checked on every request.
- The stream (SSE) learns a user's teams when it connects. Someone removed from a team can still receive "item X changed" pings, with no content, until the stream reconnects (at most 15 minutes). The refetch that follows is authorized normally, so nothing leaks.

**Rejected.** Global roles (cannot express "lead here, member there"), roles embedded in the token (stale for up to 8 hours), and checking permissions only in the interface.

**Code.** `server/src/auth/`, `server/src/middleware/teamAccess.ts`, `server/src/services/itemService.ts` (`loadItemForUser`), `server/src/domain/workflow.ts`.

---

## 5. What is synchronous and what is asynchronous

**Decision.** Everything that decides whether an action is allowed, and everything that must be true when the response arrives, happens inside the request. Everything that merely reacts to a committed change happens afterwards.

| Synchronous, inside the request | Asynchronous, after commit |
|---|---|
| Authentication and team authorization | Creating notifications for owner, reporter, approvers (worker) |
| Input validation (Zod on every endpoint) | Clean-up of finished jobs and old idempotency keys (worker) |
| Version check, atomic claim | Telling browsers that something changed (Postgres `NOTIFY`, then Server-Sent Events) |
| Workflow rules (`checkTransition`): allowed from this status, by this person, with a reason where required, approval rule | |
| The state change and its history event, in one transaction | |
| Recording the idempotency result | |

Workflow rules are a table in code, not scattered `if` statements. Clients ask for an action (`approve`, `close`, ...), never for a raw status. The server checks who is asking, the current status and any extra rule, so an invalid transition is impossible rather than merely discouraged. Whether an item needs approval is decided by the server from its kind (payment and compliance); the reporter cannot turn it off. A database `CHECK` constraint also refuses an item whose owner does not match its status, and a trigger makes `work_item_events` append-only, so history cannot be edited or deleted even by buggy code.

**Live updates carry no data.** The stream sends "item 42 changed" (ids and type only). The browser invalidates its cached queries and refetches through the normal, authorized API. This avoids stale or leaked payloads, and a missed message costs nothing: after any reconnect the server sends `resync` and the client refetches everything it shows. Because `NOTIFY` fires only on commit, a rolled-back change announces nothing. (`tests/realtime.test.ts`.)

**What it costs.** Every change causes a burst of refetches (the client batches them in 250 ms windows). That is more requests than pushing data, in exchange for simpler and safer behaviour. Notifications are never instant (see Decision 1).

**Rejected.** Doing notification work inside the request (a slow or failing notification would fail the user's action), WebSockets (two-way channel we do not need), and pushing full item data over the stream (needs per-event authorization and can go stale).

**Code.** `server/src/domain/workflow.ts`, `server/src/services/realtime.ts`, `server/src/routes/stream.ts`, `web/src/realtime/useRealtime.ts`.

---

## 6. What we intentionally did not build

Time was 48 hours, so we chose a smaller system that is provably correct over a wider one that is not.

| Not built | Why |
|---|---|
| Drag-and-drop boards, file uploads, dark mode, mobile layout polish | Not asked for; none of them prove correctness |
| Real email delivery | Notifications are stored and shown in the app; sending email adds a provider, not a design question |
| Single sign-on | Email and password with hashed passwords (scrypt) and signed tokens is enough to show the access model |
| Endpoints to create teams and users | Teams and users come from the seed script; only team membership can be managed through the API |
| Moving an item to another team | Would need a defined rule for history, owners and permissions |
| Relevance-ranked search | Search is ordered by recent activity so cursor paging stays stable |
| Dead-letter screen | Dead jobs are inspected with SQL (see `KNOWN_LIMITATIONS.md`) |
| Browser tests for the web app | The server rules that matter are tested; the web app is checked by hand using the demo script |
| Rate limiting, HTTPS, production deployment files | Out of scope for a review build |

A longer list with the reasoning for each is in `KNOWN_LIMITATIONS.md`.