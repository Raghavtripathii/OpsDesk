import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { authenticate, currentUser } from '../middleware/authenticate.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

const dummyHash = hashPassword('placeholder-password');

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const { rows } = await pool.query<{
    id: number;
    name: string;
    email: string;
    password_hash: string;
    is_org_admin: boolean;
  }>('SELECT id, name, email, password_hash, is_org_admin FROM users WHERE lower(email) = $1 AND is_active', [email]);

  const user = rows[0];
  const valid = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
  if (!user || !valid) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');

  res.json({
    token: signToken(user.id),
    user: { id: user.id, name: user.name, email: user.email, isOrgAdmin: user.is_org_admin },
  });
});

authRouter.get('/me', authenticate, async (req, res) => {
  const user = currentUser(req);
  const { rows } = await pool.query(
    `SELECT m.team_id AS "teamId", t.name AS "teamName", m.role
     FROM memberships m
     JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = $1
     ORDER BY t.name`,
    [user.id],
  );
  res.json({ user, teams: rows });
});
