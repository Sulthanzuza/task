import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests share one Postgres container, so they must not run in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    setupFiles: ['test/setup.ts'],
  },
});
