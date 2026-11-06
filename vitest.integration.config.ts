import { defineConfig } from 'vitest/config';

/**
 * Integration tests: real Postgres, run via `npm run test:integration`. Kept out of
 * the default `npm test` so unit tests stay fast and need no external services.
 * Requires a database at DATABASE_URL (default matches docker-compose.yml).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    // DB connect + queries need more headroom than pure unit tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A single DB means tests must not run in parallel across files.
    fileParallelism: false,
  },
});
