# Assumptions

The brief leaves many decisions open on purpose. These are the ones this solution makes.

## Users and scale

- A few thousand registered users, hundreds to a few thousand active at once, many teams.
- Tens of thousands of active work items and a history that only grows.
- One PostgreSQL instance, one API service and one or more workers. No multi-region setup.

## Work items

- An item belongs to exactly one team. Moving it to another team is out of scope.
- Every item has a kind: customer issue, incident, payment, compliance, or task.
- Every item has a priority: low, medium, high, or urgent.
- Every item has an optional due date, a reporter (the creator) and at most one owner.
- Items are never hard-deleted. They end as closed or cancelled, so history stays complete.
- Some items are flagged as needing approval before they can be resolved.

## Workflow

States: open, in_progress, pending_approval, resolved, closed, cancelled.

- open to in_progress: someone claims or is assigned the item.
- in_progress to open: the owner releases it.
- in_progress to resolved: allowed only if the item does not need approval.
- in_progress to pending_approval: required when the item needs approval.
- pending_approval to resolved: an approver approves.
- pending_approval to in_progress: an approver rejects, with a reason.
- resolved to closed or back to in_progress (reopen).
- open or in_progress to cancelled, with a reason.
- closed and cancelled are final.

Claiming an unowned open item sets the owner and moves it to in_progress in one atomic step.

## Roles and access

- Roles are per team: member, lead, admin.
- A user may belong to several teams with a different role in each.
- A small number of organisation admins can create teams and users.
- A user can only see and act on items of teams they belong to.
- Members: view, create, comment, claim unowned items, update items they own.
- Leads: everything a member can do, plus reassign, change priority, and approve.
- Admins: everything a lead can do, plus manage team membership.
- Nobody can approve an item they own or reported.

## Concurrency

- Two people can change the same item. Every item carries a version number. A write that
  uses an old version is rejected with the current state, so no one silently overwrites
  someone else.
- Claiming is decided by the database in a single conditional update. The first request
  wins and the others are told who owns the item.
- Mutating requests accept an idempotency key. Repeating a request with the same key
  returns the original result.

## History

- Every important change creates an append-only event: who, what, previous value, new value,
  and when. Events are never edited or deleted.
- Comments are append-only and are not versioned.

## Attention rules

- Overdue: a due date in the past on an item that is not resolved, closed, or cancelled.
- Stale: an open or in_progress item with no activity for 7 days.
- Needs my approval: pending_approval items in teams where I am a lead or admin, excluding
  items I own or reported.

## Asynchronous work

- Notifications are stored in the database and shown in the app. Email delivery is
  simulated by the worker and not built.
- Jobs are written in the same transaction as the change that caused them. The worker
  retries failures with backoff and moves repeated failures to a dead state.
- Handlers must be safe to run twice.

## Authentication

- Email and password with hashed passwords and signed tokens. No single sign-on.
- All timestamps are stored in UTC.

## Out of scope

Drag-and-drop boards, file attachments, real email delivery, single sign-on, moving items
between teams, and mobile-specific layouts.