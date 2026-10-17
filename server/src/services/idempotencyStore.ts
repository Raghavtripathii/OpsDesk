import { pool } from '../db.js';

export const abandonedAfterSeconds = 60;
export const retentionHours = 24;

export interface StoredKey {
  requestHash: string;
  state: 'in_progress' | 'completed';
  responseStatus: number | null;
  responseBody: unknown;
  abandoned: boolean;
}

export async function claimKey(userId: number, key: string, requestHash: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [userId, key, requestHash],
  );
  return result.rowCount === 1;
}

export async function readKey(userId: number, key: string): Promise<StoredKey | null> {
  const { rows } = await pool.query<{
    request_hash: string;
    state: 'in_progress' | 'completed';
    response_status: number | null;
    response_body: unknown;
    abandoned: boolean;
  }>(
    `SELECT request_hash, state, response_status, response_body,
            created_at < now() - interval '${abandonedAfterSeconds} seconds' AS abandoned
     FROM idempotency_keys
     WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    requestHash: row.request_hash,
    state: row.state,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    abandoned: row.abandoned,
  };
}

export async function takeOverKey(userId: number, key: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE idempotency_keys
     SET created_at = now()
     WHERE user_id = $1 AND key = $2 AND state = 'in_progress'
       AND created_at < now() - interval '${abandonedAfterSeconds} seconds'`,
    [userId, key],
  );
  return result.rowCount === 1;
}

export async function completeKey(userId: number, key: string, status: number, body: unknown): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
     SET state = 'completed', response_status = $3, response_body = $4::jsonb
     WHERE user_id = $1 AND key = $2`,
    [userId, key, status, JSON.stringify(body ?? null)],
  );
}

export async function releaseKey(userId: number, key: string): Promise<void> {
  await pool.query(
    `DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND state = 'in_progress'`,
    [userId, key],
  );
}

export async function purgeExpiredKeys(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - interval '${retentionHours} hours'`,
  );
  return result.rowCount ?? 0;
}
