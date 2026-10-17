import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors.js';
import { claimKey, completeKey, readKey, releaseKey, takeOverKey } from '../services/idempotencyStore.js';
import { currentUser } from './authenticate.js';
import { setEtag } from './ifMatch.js';

const keyPattern = /^[A-Za-z0-9_.:-]{8,200}$/;
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const waitStepMs = 100;
const waitLimitMs = 3000;

function fingerprint(req: Request): string {
  return createHash('sha256')
    .update([req.method, req.originalUrl, req.header('if-match') ?? '', JSON.stringify(req.body ?? null)].join('\n'))
    .digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replay(res: Response, status: number, body: unknown) {
  res.setHeader('Idempotent-Replayed', 'true');
  const version = (body as { item?: { version?: unknown } } | null)?.item?.version;
  if (typeof version === 'number') setEtag(res, version);
  res.status(status).json(body);
}

async function acquire(userId: number, key: string, hash: string, res: Response): Promise<boolean> {
  const deadline = Date.now() + waitLimitMs;

  for (;;) {
    if (await claimKey(userId, key, hash)) return true;

    const stored = await readKey(userId, key);
    if (!stored) continue;

    if (stored.requestHash !== hash) {
      throw new AppError(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used for a different request');
    }

    if (stored.state === 'completed' && stored.responseStatus !== null) {
      replay(res, stored.responseStatus, stored.responseBody);
      return false;
    }

    if (stored.abandoned && (await takeOverKey(userId, key))) return true;

    if (Date.now() >= deadline) {
      res.setHeader('Retry-After', '1');
      throw new AppError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed');
    }

    await sleep(waitStepMs);
  }
}

function recordOutcome(res: Response, userId: number, key: string) {
  const send = res.json.bind(res);

  res.json = (body?: unknown) => {
    const status = res.statusCode;
    const settled = status >= 500 ? releaseKey(userId, key) : completeKey(userId, key, status, body);

    settled
      .catch((err: unknown) => {
        console.error('Could not record idempotent response', err);
      })
      .finally(() => {
        send(body);
      });

    return res;
  };
}

export async function idempotency(req: Request, res: Response, next: NextFunction) {
  if (safeMethods.has(req.method)) {
    next();
    return;
  }

  const key = req.header('idempotency-key');
  if (!key) {
    next();
    return;
  }

  if (!keyPattern.test(key)) {
    throw new AppError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be 8 to 200 characters: letters, digits, dot, dash, underscore or colon',
    );
  }

  const userId = currentUser(req).id;
  const owned = await acquire(userId, key, fingerprint(req), res);
  if (!owned) return;

  recordOutcome(res, userId, key);
  next();
}
