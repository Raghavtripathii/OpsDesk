import { defineConfig } from 'vitest/config';
import { testDatabaseUrl, testJwtSecret } from './tests/testDatabase.js';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: testDatabaseUrl,
      JWT_SECRET: testJwtSecret,
      NODE_ENV: 'test',
    },
  },
});
