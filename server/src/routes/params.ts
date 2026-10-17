import type { Request } from 'express';
import { AppError } from '../errors.js';

export function itemIdFrom(req: Request): number {
  const id = Number(req.params.itemId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(404, 'not_found', 'Work item not found');
  return id;
}
