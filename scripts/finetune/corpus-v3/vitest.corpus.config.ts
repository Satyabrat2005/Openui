import { defineConfig } from 'vitest/config'

/**
 * Config for the Splen-4B corpus v3 GENERATOR only — a generator, not a
 * unit test, so it lives outside the root suite's `src/**` discovery.
 *
 *   python scripts/finetune/corpus-v3/author_corpus.py
 *   npx vitest run --config scripts/finetune/corpus-v3/vitest.corpus.config.ts
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: process.cwd(),
    include: ['scripts/finetune/corpus-v3/generate_corpus_v3.test.ts'],
    globals: false,
    testTimeout: 300_000,
    hookTimeout: 120_000
  }
})
