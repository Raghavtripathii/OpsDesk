# Known Limitations

What OpsDesk does not do, or does less well than it should, and what we would do next. Items are ordered by how much they matter.

## Correctness gaps

**1. The idempotency record is written just after the business transaction, not inside it.**
If the API process dies after an item is created but before the key is marked complete, a retry that arrives more than 60 seconds later runs the request again. For edits, assignments, priority changes and workflow moves this is harmless: the retry carries the old `If-Match` version and gets `409`. For item creation it could create a duplicate. A repeat claim by the same person is harmless. Fix: write the key's response inside the same transaction as the change.

**2. The role check happens just before the transaction, not inside it.**
A mutation loads the caller's role, then opens the transaction and locks the item. If a team admin lowers someone's role in that few-millisecond window, the in-flight action can still succeed. The next request is checked against the new role. Fix: load the role inside the locked transaction.

**3. Live pings keep using the team list from when the stream opened.**
Someone removed from a team can keep receiving "item N changed" pings (ids only, no content) until their stream reconnects, which happens at least every 15 minutes. The refetch that follows is authorized normally, so no data leaks.

**4. Teams and users cannot be created through the API.**
`docs/ASSUMPTIONS.md` mentions organisation admins creating teams and users. The `is_org_admin` flag exists and is returned to the client, but no endpoint uses it. Teams and users come from the seed script. Only team membership (add a member, change a role) is available through the API.

## Performance

**5. A user in several teams pays for the size of those teams on every list request.**
Cursor pagination keeps deep pages as fast as the first page (measured: 19.3 ms for page 1 and 19.4 ms for page 40). But the first-page query for a user in two teams reads and joins every item of both teams (8,238 rows in the seeded data) before keeping the newest 26. It takes about 21 ms through the API, and the cost grows with the number of items in the user's teams. A user in one team takes about 5 ms. Measured details are in `PERFORMANCE.md`. Fix: choose the 26 ids first from the index, then join only those rows. In a hand test on the seeded data that shape ran in about 2 ms instead of 24 ms.

**6. Dashboard counts stop at 1000.**
This keeps them cheap. When a count reaches the cap, the dashboard shows it as "1000+" instead of an exact number.

**7. Search is basic.**
PostgreSQL full-text search with English stemming, ordered by recent activity (not relevance). It matches whole words and their stems, not partial words or typos, and does not search comments.

**8. Tables that only grow.**
`work_item_events` and `comments` are not partitioned or archived. Finished jobs (7 days) and idempotency keys (24 hours) are cleaned up by the worker. The seeded data has about 315,000 events and 150,000 comments and was measured; much larger histories were not tested.

## Background work

**9. One worker loop, no screen for failed jobs.**
The worker handles jobs one at a time and polls every second when idle. Its throughput was not measured. Jobs that fail five times become `dead` and stay in the table. To inspect them, run `npm run db:psql` and use:

```sql
SELECT id, type, attempts, last_error, finished_at FROM outbox_jobs WHERE status = 'dead' ORDER BY id DESC;
```

To retry one:

```sql
UPDATE outbox_jobs SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL WHERE id = 123;
```

**10. A job that runs longer than five minutes can be handed to a second worker.**
This is safe because the notification handler is idempotent, but a future handler must be written the same way.

**11. Seeded history has no notifications.**
The seed script loads events with the outbox switched off, so thousands of old events do not flood the queue. Only changes made after seeding create jobs and notifications.

## Security and operations

**12. Review-build security, not production security.**
No rate limiting on login, no HTTPS, no refresh or revocation of tokens (they last 8 hours; deactivating a user works immediately because the user is checked on every request), the token is kept in browser local storage, and `.env.example` contains a development secret. The API is only reachable through the Vite dev proxy, so there is no CORS setup.

**13. Docker Compose starts only the database.**
The API, worker and web app run with Node directly (`npm run dev`, `npm run worker`, `npm run dev:web`). A full containerised stack was not built.

**14. The web app has no automated tests.**
The server rules that matter (claims, versions, idempotency, workflow, authorization, worker, pagination, live stream) have 147 tests. The browser behaviour is checked by hand with `docs/DEMO_SCRIPT.md`.

**15. Seed dates are relative to the moment you seed.**
Due dates and "stale" ages are generated around the current time. Run `npm run seed` again if the Overdue and Stale views look empty after a long time.

## What we would build in another week

1. The single-query fix for item 5, then re-run `npm run bench`.
2. Write the idempotency result inside the business transaction (item 1) and load roles inside it (item 2).
3. A screen for dead jobs with a retry button.
4. Endpoints and screens for organisation admins to create teams and users.
5. Browser tests for the two-window race (Playwright).
6. A containerised API, worker and web image so `docker compose up` runs everything.
7. Per-team, per-user limits and login rate limiting.