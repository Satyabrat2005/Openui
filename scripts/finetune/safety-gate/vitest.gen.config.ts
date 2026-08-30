import { defineConfig } from 'vitest/config'

/**
 * Config for the safety-gate prompt GENERATOR only.
 *
 * Mirrors scripts/benchmark/vitest.gen.config.ts: the root vitest.config.ts
 * restricts discovery to `src/**`, which correctly keeps this file — a
 * generator that writes prompts, not a test — out of the unit suite. Run it
 * explicitly:
 *
 *   npx vitest run --config scripts/finetune/safety-gate/vitest.gen.config.ts
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: process.cwd(),
    include: ['scripts/finetune/safety-gate/generate_safety_prompts.test.ts'],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
