import { pool } from './db.js';
import { handlers } from './jobs/handlers.js';
import { purgeExpiredKeys } from './services/idempotencyStore.js';
import { claimJobs, markDone, markFailed, pruneFinishedJobs, requeueStuckJobs, type Job } from './services/outbox.js';

const idleDelayMs = 1000;
const errorDelayMs = 5000;
const stuckCheckEveryMs = 30_000;
const cleanupEveryMs = 10 * 60_000;

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJob(job: Job) {
  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
    await handler(job.payload);
    await markDone(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = await markFailed(job, err);
    console.error(`job ${job.id} (${job.type}) failed on attempt ${job.attempts}/${job.maxAttempts}: ${message} -> ${outcome}`);
  }
}

async function main() {
  console.log('worker started');
  let lastStuckCheck = 0;
  let lastCleanup = Date.now();

  while (!stopping) {
    try {
      const now = Date.now();

      if (now - lastStuckCheck >= stuckCheckEveryMs) {
        lastStuckCheck = now;
        const requeued = await requeueStuckJobs();
        if (requeued > 0) console.log(`recovered ${requeued} stuck job(s)`);
      }

      if (now - lastCleanup >= cleanupEveryMs) {
        lastCleanup = now;
        const [jobs, keys] = await Promise.all([pruneFinishedJobs(), purgeExpiredKeys()]);
        if (jobs + keys > 0) console.log(`cleanup removed ${jobs} finished job(s) and ${keys} expired key(s)`);
      }

      const jobs = await claimJobs();
      for (const job of jobs) await runJob(job);
      if (jobs.length === 0) await sleep(idleDelayMs);
    } catch (err) {
      console.error('worker loop error', err);
      await sleep(errorDelayMs);
    }
  }

  await pool.end();
  console.log('worker stopped');
}

function stop() {
  stopping = true;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
