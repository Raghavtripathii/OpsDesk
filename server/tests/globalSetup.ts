import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { testDatabaseUrl, testJwtSecret } from './testDatabase.js';

export default async function setup() {
  const target = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(target.pathname.slice(1));

  if (!/^[a-z0-9_]+$/.test(databaseName) || !databaseName.includes('test')) {
    throw new Error(`Refusing to run tests against database "${databaseName}". Its name must contain "test".`);
  }

  const admin = new URL(testDatabaseUrl);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }

  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl, JWT_SECRET: testJwtSecret },
    stdio: 'inherit',
  });
}
