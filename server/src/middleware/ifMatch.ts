import type { Request, Response } from 'express';
import { AppError } from '../errors.js';

export function expectedVersionFrom(req: Request): number {
  const header = req.header('if-match');
  if (!header) {
    throw new AppError(428, 'precondition_required', 'Send the version you are changing in an If-Match header');
  }

  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  const version = match?.[1];
  if (!version) {
    throw new AppError(400, 'invalid_if_match', 'If-Match must be the item version, for example "3"');
  }

  return Number(version);
}

export function setEtag(res: Response, version: number) {
  res.setHeader('ETag', `"${version}"`);
}
