import { defineConfig } from 'vitest/config'

/**
 * Config for the safety gate v2 prompt GENERATOR only — a generator, not a
 * unit test, so it lives outside the root suite's `src/**` discovery.
 *
 *   python scripts/finetune/safety-gate/v2/author_cases.py
 *   npx vitest run --config scripts/finetune/safety-gate/v2/vitest.gen.config.ts
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: process.cwd(),
    include: ['scripts/finetune/safety-gate/v2/generate_prompts_v2.test.ts'],
    globals: false,
    testTimeout: 300_000,
    hookTimeout: 120_000
  }
})
