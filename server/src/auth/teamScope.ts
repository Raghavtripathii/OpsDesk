import { pool } from '../db.js';
import { roleCan, type Role } from './permissions.js';

export interface TeamScope {
  teamIds: number[];
  approverTeamIds: number[];
}

export async function getTeamScope(userId: number): Promise<TeamScope> {
  const { rows } = await pool.query<{ team_id: number; role: Role }>(
    'SELECT team_id, role FROM memberships WHERE user_id = $1',
    [userId],
  );
  return {
    teamIds: rows.map((row) => row.team_id),
    approverTeamIds: rows.filter((row) => roleCan(row.role, 'item:approve')).map((row) => row.team_id),
  };
}
