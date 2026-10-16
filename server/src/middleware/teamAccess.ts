import type { NextFunction, Request, Response } from 'express';
import { authorizeTeam } from '../auth/access.js';
import type { Permission } from '../auth/permissions.js';
import { AppError } from '../errors.js';
import { currentUser } from './authenticate.js';

export function requireTeamPermission(permission: Permission) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const teamId = Number(req.params.teamId);
    if (!Number.isInteger(teamId) || teamId <= 0) throw new AppError(404, 'not_found', 'Not found');
    req.teamRole = await authorizeTeam(currentUser(req).id, teamId, permission);
    next();
  };
}
