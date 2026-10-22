import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests spin up Postgres-in-WASM (PGlite); the first boot is slow.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
