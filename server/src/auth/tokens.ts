import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(userId: number): string {
  return jwt.sign({}, config.JWT_SECRET, { subject: String(userId), expiresIn: '8h' });
}

export function verifyToken(token: string): number | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || !decoded.sub) return null;
    const userId = Number(decoded.sub);
    return Number.isInteger(userId) ? userId : null;
  } catch {
    return null;
  }
}
