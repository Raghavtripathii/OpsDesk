import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { roleCan, type Permission, type Role } from './permissions.js';

export async function getTeamRole(userId: number, teamId: number): Promise<Role | null> {
  const { rows } = await pool.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2',
    [userId, teamId],
  );
  return rows[0]?.role ?? null;
}

export async function authorizeTeam(userId: number, teamId: number, permission: Permission): Promise<Role> {
  const role = await getTeamRole(userId, teamId);
  if (!role) throw new AppError(404, 'not_found', 'Not found');
  if (!roleCan(role, permission)) throw new AppError(403, 'forbidden', 'Your role does not allow this action');
  return role;
}
