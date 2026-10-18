export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://opsdesk:opsdesk@localhost:5433/opsdesk_test';

export const testJwtSecret = 'test-secret-for-automated-tests';
