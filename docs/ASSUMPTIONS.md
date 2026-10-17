# Assumptions

The brief leaves many decisions open on purpose. These are the ones this solution makes.

## Users and scale

- A few thousand registered users, hundreds to a few thousand active at once, many teams.
- Tens of thousands of active work items and a history that only grows.
- One PostgreSQL instance, one API service and one or more workers. No multi-region setup.

## Work items

- An item belongs to exactly one team. Moving it to another team is out of scope.
- Every item has a kind: customer issue, incident, payment, compliance, or task.
- Every item has a priority: low, medium, high, or urgent. The reporter sets an initial priority. Only leads and admins change it afterwards.
- Every item has an optional due date, a reporter (the creator) and at most one owner.
- Items are never hard-deleted. They end as closed or cancelled, so history stays complete.
- Whether an item needs approval is decided by the server from its kind (payment and compliance). The reporter cannot switch it off.
- Closed and cancelled items cannot be edited.

## Workflow

States: open, in_progress, pending_approval, resolved, closed, cancelled.

Clients request actions, not raw statuses. The server checks who is asking, the current status, and any extra rule.

| Action | From | To | Who | Extra rule |
|---|---|---|---|---|
| claim | open | in_progress | any member | item must be unowned |
| assign | open, in_progress, pending_approval | in_progress if it was open | lead, admin | assignee must be an active member of the team |
| release | in_progress | open | owner, lead, admin | clears the owner |
| request_approval | in_progress | pending_approval | owner, lead, admin | item must need approval |
| resolve | in_progress | resolved | owner, lead, admin | item must not need approval |
| approve | pending_approval | resolved | lead, admin | not the owner, not the reporter |
| reject | pending_approval | in_progress | lead, admin | not the owner, not the reporter; reason required |
| close | resolved | closed | reporter, lead, admin | |
| reopen | resolved | in_progress | reporter, lead, admin | reason required; item needs an owner |
| cancel | open, in_progress | cancelled | reporter, lead, admin | reason required |

closed and cancelled are final.

## Roles and access

- Roles are per team: member, lead, admin.
- A user may belong to several teams with a different role in each.
- A small number of organisation admins can create teams and users.
- A user can only see and act on items of teams they belong to. For anyone else, an item or team does not exist (404), so nothing leaks.
- Members: view, create, comment, claim unowned items, edit items they own or reported.
- Leads: everything a member can do, plus edit any item, assign, change priority, and approve.
- Admins: everything a lead can do, plus manage team membership.
- Nobody can approve or reject an item they own or reported.

## Concurrency

- Every item carries a version number that increases on each change.
- Every change to an item (edit, assign, priority, workflow action) must send the version the user saw in an If-Match header. The server locks the item row, compares versions, and applies the change in one transaction.
- A change with an old version is rejected with 409 and the current item, so no one silently overwrites someone else.
- Claiming is decided by the database in a single conditional update. The first request wins and the others are told who owns the item. Repeating a claim you already won succeeds without changing anything.
- Comments do not change the item version, so discussion never causes edit conflicts.
- Mutating requests accept an idempotency key. Repeating a request with the same key returns the original result.

## History

- Every important change creates an append-only event: who, what, previous value, new value, and when. Events are never edited or deleted.
- Comments are append-only and are not versioned.

## Lists and search

- Lists are ordered by recent activity and use cursor pagination, never page numbers.
- Search ranks by recent activity, not by relevance, to keep paging stable.
- Dashboard counts stop at 1000 to keep them cheap on large data.

## Attention rules

- Overdue: a due date in the past on an item that is not resolved, closed, or cancelled.
- Stale: an open or in_progress item with no activity for 7 days.
- Needs my approval: pending_approval items in teams where I am a lead or admin, excluding items I own or reported.

## Asynchronous work

- Notifications are stored in the database and shown in the app. Email delivery is simulated by the worker and not built.
- Jobs are written in the same transaction as the change that caused them. The worker retries failures with backoff and moves repeated failures to a dead state.
- Handlers must be safe to run twice.

## Authentication

- Email and password with hashed passwords and signed tokens. No single sign-on.
- All timestamps are stored in UTC.

## Out of scope

Drag-and-drop boards, file attachments, real email delivery, single sign-on, moving items between teams, and mobile-specific layouts.
