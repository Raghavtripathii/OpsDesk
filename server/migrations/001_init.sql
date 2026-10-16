CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  is_org_admin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE teams (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id bigint NOT NULL REFERENCES users (id),
  team_id bigint NOT NULL REFERENCES teams (id),
  role text NOT NULL CHECK (role IN ('member', 'lead', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);

CREATE INDEX memberships_team_idx ON memberships (team_id);

CREATE TABLE work_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id bigint NOT NULL REFERENCES teams (id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  kind text NOT NULL CHECK (kind IN ('customer_issue', 'incident', 'payment', 'compliance', 'task')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'pending_approval', 'resolved', 'closed', 'cancelled')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  requires_approval boolean NOT NULL DEFAULT false,
  reporter_id bigint NOT NULL REFERENCES users (id),
  owner_id bigint REFERENCES users (id),
  due_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', description), 'B')
  ) STORED,
  CONSTRAINT work_items_owner_matches_status CHECK (
    (status = 'open' AND owner_id IS NULL)
    OR (status IN ('in_progress', 'pending_approval') AND owner_id IS NOT NULL)
    OR status IN ('resolved', 'closed', 'cancelled')
  )
);

CREATE INDEX work_items_team_status_updated_idx ON work_items (team_id, status, updated_at DESC, id DESC);
CREATE INDEX work_items_team_updated_idx ON work_items (team_id, updated_at DESC, id DESC);
CREATE INDEX work_items_owner_active_idx ON work_items (owner_id, updated_at DESC) WHERE status IN ('in_progress', 'pending_approval');
CREATE INDEX work_items_due_active_idx ON work_items (due_at) WHERE due_at IS NOT NULL AND status IN ('open', 'in_progress', 'pending_approval');
CREATE INDEX work_items_stale_idx ON work_items (last_activity_at) WHERE status IN ('open', 'in_progress');
CREATE INDEX work_items_approval_idx ON work_items (team_id, updated_at DESC) WHERE status = 'pending_approval';
CREATE INDEX work_items_search_idx ON work_items USING gin (search_vector);

CREATE TABLE work_item_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES work_items (id),
  actor_id bigint REFERENCES users (id),
  type text NOT NULL CHECK (type IN ('created', 'status_changed', 'owner_changed', 'priority_changed', 'due_date_changed', 'details_edited', 'comment_added')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_item_events_item_idx ON work_item_events (item_id, id DESC);

CREATE FUNCTION forbid_event_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'work_item_events is append-only';
END
$$;

CREATE TRIGGER work_item_events_append_only
  BEFORE UPDATE OR DELETE ON work_item_events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_changes();

CREATE TABLE comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES work_items (id),
  author_id bigint NOT NULL REFERENCES users (id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX comments_item_idx ON comments (item_id, id);

CREATE TABLE idempotency_keys (
  user_id bigint NOT NULL REFERENCES users (id),
  key text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE outbox_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX outbox_jobs_ready_idx ON outbox_jobs (run_at, id) WHERE status = 'pending';
CREATE INDEX outbox_jobs_processing_idx ON outbox_jobs (locked_at) WHERE status = 'processing';

CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  item_id bigint REFERENCES work_items (id),
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
