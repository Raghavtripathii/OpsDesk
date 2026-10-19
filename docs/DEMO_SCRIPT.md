# Demo Script

A 15-minute walkthrough for the review. Everything here runs on the seeded data. The demo accounts all use the password `password123`.

| Account | Role |
|---|---|
| `admin@opsdesk.test` | admin in Customer Support and Payments Ops, also an organisation admin |
| `lead@opsdesk.test` | lead in Customer Support, member in Payments Ops |
| `member@opsdesk.test` (Maya) | member in Customer Support |
| `agent2@opsdesk.test` (Aiden) | member in Customer Support |
| `outsider@opsdesk.test` | member in Compliance only |

## Before you start

1. Database, migrations and seed are done (`npm run db:up`, `npm run migrate`, `npm run seed`).
2. Three terminals are running: `npm run dev`, `npm run worker`, `npm run dev:web`.
3. Open two different browser sessions side by side: one normal window and one private (incognito) window, both at `http://localhost:5173`. Sign in as Maya (`member@opsdesk.test`) in the first and as Leo (`lead@opsdesk.test`) in the second.
4. Keep a fourth terminal free for the commands below.

## Part 1. The product in two minutes (as Maya)

1. **Dashboard.** Point out the cards: assigned to me, overdue, unassigned and urgent, awaiting my approval, stale. These answer "what needs attention next". A count at the cap shows as `1000+`.
2. **All work.** Open the list. Scroll to the bottom: more items load by cursor, 25 at a time. The browser never holds the whole dataset (the seed has 50,000 items).
3. **Filter and search.** Filter by status and priority, then search for `refund`. Results stay fast and stay inside Maya's team.
4. **Item detail.** Open any item. Show who owns it, who reported it, status, priority, due date, the version number, and the timeline of everything that happened (history is append-only).

## Part 2. Two windows racing (C1 and C2, in the browser)

Live updates normally refresh the second window within a fraction of a second, which makes a race hard to show by hand. So switch the live stream off in the second window first. We checked this procedure in a real browser.

1. In the **second window** (Leo), open Chrome DevTools, press `Ctrl+Shift+P`, type *Show Network request blocking*, press Enter, click **Add pattern** and enter `*/api/stream*`. Reload the page. The pill at the top changes from *Live* to *Reconnecting...*. This window now changes only when you act in it.
2. In the **first window** (Maya) click **New item**, give it any title, and create it. You land on the item. Copy its address.
3. Paste the address into the second window. Both windows now show the same unassigned item and a **Claim this item** button.

The app refetches stale data when a window regains focus, and data counts as stale after 15 seconds. So do each of the two races below quickly, within about 15 seconds of loading the page in the second window. If the second window already shows the new state before you click, you were too slow: create a fresh item and try again.

**Claim race (C1).**

4. Click **Claim this item** in Maya's window. It becomes hers.
5. Immediately click **Claim this item** in Leo's window, which still shows an unassigned item. The screen first updates optimistically, then the server refuses. The change rolls back, a message appears, "Too late: Maya Member already owns this item.", and the window shows Maya as the owner. Both windows now agree.

**Stale edit (C2).**

6. In Maya's window create another item. Paste its address into Leo's window and wait for it to load.
7. In Leo's window click **Edit details** and type a new title, but do not save yet.
8. In Maya's window click **Edit details**, type a different title, and save. The version number goes up to 2.
9. In Leo's window press save. A warning banner appears, "Someone else changed this item first." The screen shows Maya's version, Leo's change was not saved, and what he typed is still in the form so he can review it and try again.
10. Remove the blocked pattern and reload both windows: the pill shows *Live* again. Make a change in one window and watch the other update on its own.

What to say: the database, not the browser, decides the winner, and a losing client always ends up showing the truth.

## Part 3. The same, without a browser (C1, C2, C3, C4, C5)

In the fourth terminal:

```
npm run demo:race
```

It prints a pass or fail line for every check: ten people claiming at once (one winner, one history entry), two leads editing the same version (one accepted, one `409` with the current item), five identical creates with one key (one item, four replays), forbidden workflow moves, and a user from another team getting `404` on read, claim, edit, comment and search. It creates a few items titled `[race-demo]` and is safe to run again.

## Part 4. Workflow and approval (C4)

1. As Maya create an item of kind **Payment**. Show the **Needs approval** tag: the server decided this from the kind.
2. Sign in as `lead@opsdesk.test` in the second window, open the item, and **Claim this item**. Only the actions the server allows are shown; there is no **Resolve** button, only **Request approval**.
3. Click **Request approval**. The status becomes *pending approval*. Lead cannot approve (they own the item): no **Approve** button.
4. Sign in as `admin@opsdesk.test` and open the same item. **Approve** and **Reject** are available (reject asks for a reason). Approve it. Then as Maya, **Close** the resolved item.
5. Open the timeline: every step is recorded with who and when.

## Part 5. Authorization (C5)

1. Sign in as `member@opsdesk.test`. On an item owned by someone else there is no **Assign** and no priority control.
2. Sign in as `outsider@opsdesk.test` and paste the address of a Customer Support item. The page says **Item not found**. The API returns `404`, not `403`, so the item's existence is not revealed.
3. Maya is not in Payments Ops. Her API requests for a Payments Ops item also return `404`, whatever the screen shows. Hiding buttons is not the protection; the server is.

## Part 6. The worker (C6)

Notifications are made by the worker after the change commits. In the fourth terminal, open the database prompt:

```
npm run db:psql
```

**Work queues while the worker is down.**

1. Stop the worker terminal with `Ctrl+C`.
2. As Leo, claim an item. As Maya, add a comment to it. Both actions succeed at once.
3. In `psql` run:

```sql
SELECT id, type, status, attempts FROM outbox_jobs ORDER BY id DESC LIMIT 5;
```

   The newest jobs are `pending`. Nobody has been notified yet.
4. Start the worker again (`npm run worker`). Within a second the jobs become `done`, and Leo's bell shows Maya's comment (and updates live).

**A crashed worker is recovered.** A real crash happens in milliseconds, so simulate the state a crash leaves behind: a job marked `processing` long ago.

```sql
INSERT INTO outbox_jobs (type, payload, status, attempts, locked_at)
SELECT 'item_event', jsonb_build_object('eventId', max(id)), 'processing', 1, now() - interval '10 minutes'
FROM work_item_events;
```

Within 30 seconds the worker prints `recovered 1 stuck job(s)` and finishes it. The tests (`tests/outbox.test.ts`) cover the real thing: a recovered job finishes once, and never duplicates a notification.

**Failure, retry and dead letter.**

```sql
INSERT INTO outbox_jobs (type, payload, max_attempts) VALUES ('no_such_handler', '{}', 2);
SELECT id, status, attempts, run_at, last_error FROM outbox_jobs ORDER BY id DESC LIMIT 1;
```

The worker logs the failure, the job returns to `pending` with a later `run_at` (backoff), and after its second attempt it becomes `dead` with the error kept in `last_error`. Healthy jobs keep flowing meanwhile.

## Part 7. Show the evidence (2 minutes)

```
npm test
npm run bench
```

`npm test` runs 147 tests against a clean test database (created automatically). `npm run bench` prints the list and search timings in `docs/PERFORMANCE.md`.

## Review-day questions and short answers

**What happens if two people claim at the same instant?**
One conditional `UPDATE ... WHERE status = 'open' AND owner_id IS NULL` runs in the database. Only one request can match it. The other gets `409 already_claimed` with the winner's name, and history holds exactly one ownership change. Test: ten simultaneous claimers, run repeatedly.

**What happens if the worker crashes halfway through a job?**
The job stays `processing` with a `locked_at` time. After five minutes `requeueStuckJobs` puts it back to `pending` (or `dead` if it has used all five attempts). Because notifications have a unique key per event, running the job again cannot create duplicates.

**What happens if a user submits the same request twice?**
With the same `Idempotency-Key` the second request gets the stored response (`Idempotent-Replayed: true`) and does nothing. Five simultaneous identical requests create one item. Even without a key, edits and workflow moves carry `If-Match`, so a repeat after success gets `409`.

**How does a user in team A get blocked from team B's items?**
Every item is loaded through the caller's membership in the item's team. No membership returns `404`. Lists, search, counts and live updates are limited in SQL to the caller's teams. Being an organisation admin changes nothing. Test: `authorization.test.ts`.

**Why Postgres, and why not a message broker?**
The change and the job must commit together. In the same database a trigger does that for free, and the queue, retries, backoff and dead state are ordinary SQL. A broker adds a second system and the "database committed but publish failed" problem. We would switch when job volume outgrows one database.

**What breaks first at ten times the load?**
The list query for users in several teams: it joins every item in their teams before limiting to a page, 21 ms today. A measured fix (pick ids first, then join) takes it to about 2 ms. After that the single worker loop (start more workers) and the live-connection fan-out (add API processes).

**What would we build in another week?**
See the end of `KNOWN_LIMITATIONS.md`: fix the list query, put the idempotency record inside the transaction, a dead-job screen, endpoints for creating teams and users, browser tests for the two-window race, and a full Docker image.