import { defineConfig } from 'vitest/config'

/**
 * Config for the benchmark's prompt GENERATOR only.
 *
 * The root vitest.config.ts restricts discovery to `src/**` — correct for the
 * unit suite, and it deliberately keeps this generator out of it (it writes
 * files and is not a test of anything). Run the generator explicitly:
 *
 *   npx vitest run --config scripts/benchmark/vitest.gen.config.ts
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: process.cwd(),
    include: ['scripts/benchmark/generate_prompts.test.ts'],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
