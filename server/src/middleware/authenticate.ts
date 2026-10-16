import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../auth/tokens.js';
import { pool } from '../db.js';
import { AppError } from '../errors.js';

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new AppError(401, 'unauthenticated', 'Sign in required');

  const userId = verifyToken(token);
  if (userId === null) throw new AppError(401, 'invalid_token', 'Session is invalid or expired');

  const { rows } = await pool.query<{ id: number; email: string; name: string; is_org_admin: boolean }>(
    'SELECT id, email, name, is_org_admin FROM users WHERE id = $1 AND is_active',
    [userId],
  );
  const user = rows[0];
  if (!user) throw new AppError(401, 'invalid_token', 'Session is invalid or expired');

  req.user = { id: user.id, email: user.email, name: user.name, isOrgAdmin: user.is_org_admin };
  next();
}

export function currentUser(req: Request) {
  if (!req.user) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return req.user;
}
