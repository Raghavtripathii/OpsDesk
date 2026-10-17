import { z } from 'zod';
import { AppError } from './errors.js';

export const limitSchema = z.coerce.number().int().min(1).max(100).default(25);

export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor<T>(raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new AppError(400, 'invalid_cursor', 'The cursor is not valid');
  }
}
