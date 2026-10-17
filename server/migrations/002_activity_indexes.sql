DROP INDEX work_items_team_status_updated_idx;
DROP INDEX work_items_team_updated_idx;
DROP INDEX work_items_owner_active_idx;
DROP INDEX work_items_due_active_idx;
DROP INDEX work_items_stale_idx;
DROP INDEX work_items_approval_idx;

CREATE INDEX work_items_team_activity_idx ON work_items (team_id, last_activity_at DESC, id DESC);
CREATE INDEX work_items_owner_active_idx ON work_items (owner_id, last_activity_at DESC, id DESC) WHERE status IN ('in_progress', 'pending_approval');
CREATE INDEX work_items_due_active_idx ON work_items (due_at, id) WHERE due_at IS NOT NULL AND status IN ('open', 'in_progress', 'pending_approval');
CREATE INDEX work_items_stale_idx ON work_items (last_activity_at, id) WHERE status IN ('open', 'in_progress');
CREATE INDEX work_items_approval_idx ON work_items (team_id, last_activity_at DESC, id DESC) WHERE status = 'pending_approval';
CREATE INDEX work_items_unassigned_idx ON work_items (team_id, last_activity_at DESC, id DESC) WHERE status = 'open';
