import { getTeamScope, type TeamScope } from '../auth/teamScope.js';
import { pool } from '../db.js';
import { attentionCap, buildCountQuery, type ListView } from '../domain/itemQuery.js';

async function countView(view: ListView, userId: number, scope: TeamScope, extra: string[] = []) {
  const { text, values } = buildCountQuery(view, userId, scope, extra);
  const { rows } = await pool.query<{ total: number }>(text, values);
  return rows[0]?.total ?? 0;
}

export async function getAttentionSummary(userId: number) {
  const scope = await getTeamScope(userId);

  const [assignedToMe, overdue, unassignedUrgent, awaitingApproval, stale] = await Promise.all([
    countView('mine', userId, scope),
    countView('overdue', userId, scope),
    countView('unassigned', userId, scope, [`i.priority = 'urgent'`]),
    countView('awaiting_approval', userId, scope),
    countView('stale', userId, scope),
  ]);

  return {
    cap: attentionCap,
    counts: { assignedToMe, overdue, unassignedUrgent, awaitingApproval, stale },
  };
}
