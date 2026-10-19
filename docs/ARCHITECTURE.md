# Architecture

OpsDesk is three processes and one database.

```mermaid
flowchart TB
  subgraph Browser
    UI["React app<br/>TanStack Query cache"]
  end

  subgraph "API process (Express)"
    MW["authenticate -> idempotency -> team permission"]
    RT["Item routes<br/>list, search, claim, edit, workflow, comments"]
    SSE["Stream endpoint<br/>Server-Sent Events"]
    LIS["Postgres listener<br/>(LISTEN)"]
  end

  subgraph "Worker process"
    WK["Job loop<br/>claim, run, retry, dead-letter"]
  end

  subgraph "PostgreSQL 16"
    T[("work_items<br/>work_item_events<br/>comments<br/>memberships")]
    O[("outbox_jobs")]
    N[("notifications")]
    K[("idempotency_keys")]
  end

  UI -->|"HTTP + Bearer token<br/>If-Match, Idempotency-Key"| MW
  MW --> RT
  RT -->|"one transaction:<br/>row lock, change, event"| T
  T -.->|"trigger on event insert<br/>(same transaction)"| O
  T -.->|"pg_notify on commit"| LIS
  LIS --> SSE
  SSE -->|"item_changed, notification, resync<br/>(ids only, no data)"| UI
  MW <--> K
  WK -->|"FOR UPDATE SKIP LOCKED"| O
  WK -->|"insert, ON CONFLICT DO NOTHING"| N
  UI -.->|"refetch after a ping"| RT
```

Solid arrows are requests the process makes. Dotted arrows happen inside the database or are triggered by it.

## What happens on a change

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as API
  participant D as PostgreSQL
  participant W as Worker

  B->>A: POST /api/items/42/transitions<br/>If-Match: "3", Idempotency-Key: k1
  A->>D: claim key k1 (insert, on conflict do nothing)
  A->>D: BEGIN, SELECT item FOR UPDATE
  alt stored version is not 3
    A->>D: ROLLBACK
    A-->>B: 409 version_conflict + current item
  else version matches
    A->>A: checkTransition(action, actor, item)
    A->>D: UPDATE item (version = 4), INSERT event
    D->>D: trigger inserts outbox job
    A->>D: COMMIT (pg_notify is delivered now)
    A->>D: store response under key k1
    A-->>B: 200 item at version 4
  end
  D-->>A: NOTIFY item_events
  A-->>B: SSE item_changed (ids only)
  B->>A: GET /api/items/42 (refetch)
  W->>D: claim job, SKIP LOCKED
  W->>D: insert notifications, ON CONFLICT DO NOTHING
  W->>D: mark job done
  D-->>A: NOTIFY user_notifications
  A-->>B: SSE notification
```

## Data model

```mermaid
erDiagram
  users ||--o{ memberships : "has"
  teams ||--o{ memberships : "has"
  teams ||--o{ work_items : "owns"
  users ||--o{ work_items : "reports or owns"
  work_items ||--o{ work_item_events : "history, append-only"
  work_items ||--o{ comments : "has"
  work_item_events ||--o| outbox_jobs : "one job per event"
  users ||--o{ notifications : "receives"
  users ||--o{ idempotency_keys : "scopes"

  memberships {
    bigint user_id PK
    bigint team_id PK
    text role "member, lead or admin"
  }
  work_items {
    bigint id PK
    bigint team_id
    text status
    text priority
    bigint owner_id
    integer version
    tsvector search_vector "GIN indexed"
    timestamptz last_activity_at "list sort key"
  }
  outbox_jobs {
    bigint id PK
    text status "pending, processing, done, dead"
    integer attempts
    text dedupe_key UK
  }
```

## Components

| Part | Where | Job |
|---|---|---|
| API | `server/src/app.ts`, `routes/`, `services/` | Authentication, authorization, validation, all state changes |
| Workflow rules | `server/src/domain/workflow.ts` | One table of allowed actions, who may do them and extra rules |
| List queries | `server/src/domain/itemQuery.ts` | Builds filtered, searched, keyset-paged queries |
| Worker | `server/src/worker.ts`, `jobs/`, `services/outbox.ts` | Turns events into notifications, retries, dead-letters, clean-up |
| Live stream | `server/src/services/realtime.ts`, `routes/stream.ts` | Forwards Postgres `NOTIFY` to connected browsers |
| Web app | `web/src/` | Dashboard, list, detail, optimistic updates, conflict banner |
| Migrations | `server/migrations/` | Schema, indexes, triggers; applied under an advisory lock |

## Why the shape looks like this

- All correctness lives in Postgres and the API transaction. The worker and the stream can fail, restart or run twice without breaking data.
- The browser never trusts a live ping as data: every ping is followed by a normal, authorized fetch.
- Adding a second API process needs no other change. Each one listens to Postgres itself, and idempotency keys, jobs and versions all live in the database.