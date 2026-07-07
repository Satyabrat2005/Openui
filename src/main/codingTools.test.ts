import { describe, it, expect, vi } from 'vitest'

// codingTools.ts imports ./sandbox, which statically imports `electron` (app).
// Mock it so the module graph loads in the plain-node vitest environment. These
// tests cover the pure argument-validation branches that run BEFORE any sandbox
// (filesystem / child-process) call, so no real workspace is needed.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

import { executeCodingTool } from './codingTools'

describe('executeCodingTool — dispatch guardrails', () => {
  it('reports an unknown coding tool', async () => {
    const r = await executeCodingTool('no_such_tool', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Unknown coding tool/)
  })

  it('rejects non-object arguments', async () => {
    const r = await executeCodingTool('write_file', [] as unknown as Record<string, unknown>)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/expected an object/)
  })
})

describe('write_file — argument validation', () => {
  it('requires a string path', async () => {
    const r = await executeCodingTool('write_file', { content: 'hello' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "path"/)
  })
})

describe('read_file — argument validation', () => {
  it('requires a string path', async () => {
    const r = await executeCodingTool('read_file', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "path"/)
  })
})

describe('run_script — argument validation', () => {
  it('requires a string script name', async () => {
    const r = await executeCodingTool('run_script', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "script"/)
  })
})
