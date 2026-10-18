import { pool } from '../db.js';

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export const batchSize = 20;
export const stuckAfterMinutes = 5;
export const finishedRetentionDays = 7;

const backoffBaseSeconds = 5;
const backoffCapSeconds = 300;

export function backoffSeconds(attempts: number): number {
  const exponential = Math.min(backoffCapSeconds, backoffBaseSeconds * 2 ** (attempts - 1));
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

export async function claimJobs(limit: number = batchSize): Promise<Job[]> {
  const { rows } = await pool.query<{
    id: number;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(
    `UPDATE outbox_jobs
     SET status = 'processing', locked_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id
       FROM outbox_jobs
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, payload, attempts, max_attempts`,
    [limit],
  );

  return rows
    .map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }))
    .sort((a, b) => a.id - b.id);
}

export async function markDone(jobId: number): Promise<void> {
  await pool.query(
    `UPDATE outbox_jobs
     SET status = 'done', finished_at = now(), locked_at = NULL, last_error = NULL
     WHERE id = $1 AND status = 'processing'`,
    [jobId],
  );
}

export async function markFailed(job: Job, error: unknown): Promise<'retry' | 'dead'> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);

  if (job.attempts >= job.maxAttempts) {
    await pool.query(
      `UPDATE outbox_jobs
       SET status = 'dead', finished_at = now(), locked_at = NULL, last_error = $2
       WHERE id = $1 AND status = 'processing'`,
      [job.id, message],
    );
    return 'dead';
  }

  await pool.query(
    `UPDATE outbox_jobs
     SET status = 'pending', locked_at = NULL, last_error = $2,
         run_at = now() + make_interval(secs => $3::double precision)
     WHERE id = $1 AND status = 'processing'`,
    [job.id, message, backoffSeconds(job.attempts)],
  );
  return 'retry';
}

export async function requeueStuckJobs(): Promise<number> {
  const result = await pool.query(
    `UPDATE outbox_jobs
     SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
         locked_at = NULL,
         last_error = 'The worker stopped before finishing this job'
     WHERE status = 'processing' AND locked_at < now() - interval '${stuckAfterMinutes} minutes'`,
  );
  return result.rowCount ?? 0;
}

export async function pruneFinishedJobs(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM outbox_jobs
     WHERE status = 'done' AND finished_at < now() - interval '${finishedRetentionDays} days'`,
  );
  return result.rowCount ?? 0;
}
