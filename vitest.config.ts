import { defineConfig } from 'vitest/config'

// Unit tests run in a plain Node environment against the TypeScript source.
// Anything that touches Electron, native modules (better-sqlite3), or the
// network is mocked at the test boundary — these are fast, deterministic unit
// tests of pure logic, not integration tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
    // Vitest's 5s default is measured wall-clock while every test FILE runs in
    // parallel, so it is really a budget for "this test's work PLUS whatever
    // the other workers are doing". The suite now includes files that do real
    // document I/O (xlsx/pptx/docx/PDF rendering and parsing), and under that
    // contention slow-but-correct tests — including cheap ones like loadEnv's
    // dynamic import — could exceed 5s and fail as timeouts on a loaded
    // machine. Raising the ceiling only gives correct work room to finish: it
    // can never turn a passing test into a failing one, and an actually broken
    // test still fails on its assertion rather than here. The heaviest files
    // (pdf/mailmerge) raise it further with vi.setConfig.
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
