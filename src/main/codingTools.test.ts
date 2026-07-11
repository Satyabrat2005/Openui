import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// codingTools.ts imports ./sandbox, which statically imports `electron` (app).
// Mock it so the module graph loads in the plain-node vitest environment. The
// argument-validation tests below cover branches that run BEFORE any sandbox
// (filesystem / child-process) call, so they need no real workspace; the
// end-to-end block at the bottom points OPENUI_WORKSPACE at a temp dir.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() }
}))

// write_file and edit_file fire these as side effects. Opening a real VS Code
// window from a unit test would be hostile, and snapshotting wants app state.
vi.mock('./editor', () => ({ maybeOpenEditorOnFirstWrite: vi.fn(async () => null) }))
vi.mock('./snapshots', () => ({ snapshotBeforeWrite: vi.fn(async () => {}) }))

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

describe('edit_file — argument validation', () => {
  it('requires a string path', async () => {
    const r = await executeCodingTool('edit_file', { old_string: 'a', new_string: 'b' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "path"/)
  })

  it('requires a non-empty old_string', async () => {
    const r = await executeCodingTool('edit_file', { path: 'a.js', old_string: '', new_string: 'b' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/non-empty string "old_string"/)
  })

  it('requires new_string, but accepts an empty one as a deletion', async () => {
    const r = await executeCodingTool('edit_file', { path: 'a.js', old_string: 'a' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "new_string"/)
  })
})

describe('search_code — argument validation', () => {
  it('requires a string pattern', async () => {
    const r = await executeCodingTool('search_code', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "pattern"/)
  })
})

describe('git — argument validation', () => {
  it('requires a string subcommand', async () => {
    const r = await executeCodingTool('git', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a string "subcommand"/)
  })
})

// Drive the real dispatcher against a real temp workspace: this is the exact path
// the autonomous agent takes, so it catches wiring mistakes (a tool missing from
// the registry, a schema name that does not match its executor) that
// argument-validation tests cannot.
describe('coding tools — end to end in a real workspace', () => {
  let ws: string

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'openui-coding-'))
    process.env.OPENUI_WORKSPACE = ws
  })

  afterEach(async () => {
    delete process.env.OPENUI_WORKSPACE
    await rm(ws, { recursive: true, force: true })
  })

  it('writes, searches, edits, and reads back the edit', async () => {
    const written = await executeCodingTool('write_file', {
      path: 'src/app.js',
      content: 'function greet() {\n  return "hi"\n}\n'
    })
    expect(written.ok).toBe(true)

    const found = await executeCodingTool('search_code', { pattern: 'function\\s+greet' })
    expect(found.ok).toBe(true)
    expect(found.output).toContain('src/app.js:1:')

    const edited = await executeCodingTool('edit_file', {
      path: 'src/app.js',
      old_string: 'return "hi"',
      new_string: 'return "hello"'
    })
    expect(edited.ok).toBe(true)
    expect(edited.output).toMatch(/Replaced 1 occurrence in src[/\\]app\.js/)

    const read = await executeCodingTool('read_file', { path: 'src/app.js' })
    expect(read.output).toContain('return "hello"')
    // The untouched lines survived — the whole point of edit_file over write_file.
    expect(read.output).toContain('function greet()')
  })

  it('surfaces an ambiguous edit as a failure instead of corrupting the file', async () => {
    await executeCodingTool('write_file', { path: 'd.js', content: 'x = 1\nx = 1\n' })
    const r = await executeCodingTool('edit_file', { path: 'd.js', old_string: 'x = 1', new_string: 'x = 2' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/appears 2 times/)
    const read = await executeCodingTool('read_file', { path: 'd.js' })
    expect(read.output).toBe('x = 1\nx = 1\n')
  })

  it('initialises a repo and commits, attributing the work to the agent', async () => {
    expect((await executeCodingTool('git', { subcommand: 'init' })).output).toContain('GIT OK')
    await executeCodingTool('write_file', { path: 'a.txt', content: 'hello\n' })
    expect((await executeCodingTool('git', { subcommand: 'add', args: ['.'] })).output).toContain('GIT OK')

    const commit = await executeCodingTool('git', {
      subcommand: 'commit',
      args: ['-m', 'Add a.txt']
    })
    expect(commit.output).toContain('GIT OK')

    const log = await executeCodingTool('git', { subcommand: 'log', args: ['--oneline'] })
    expect(log.output).toContain('Add a.txt')

    const author = await executeCodingTool('git', { subcommand: 'log', args: ['--format=%an <%ae>'] })
    expect(author.output).toContain('OpenUI Agent <agent@openui.local>')
  })

  it('treats a commit message as inert data, never as a shell command', async () => {
    await executeCodingTool('git', { subcommand: 'init' })
    await executeCodingTool('write_file', { path: 'b.txt', content: 'x\n' })
    await executeCodingTool('git', { subcommand: 'add', args: ['.'] })
    // Payloads for BOTH shells, because the test must discriminate on every
    // platform: `$(…)`, backticks and `;` are inert in cmd.exe, while `&` and `|`
    // are inert in sh. If any shell ever sits between us and git, one of these
    // fires and drops a file into the workspace.
    const evil = 'pwned $(touch owned1) `touch owned2` ; touch owned3 & echo x > owned4 | echo y > owned5'
    await executeCodingTool('git', { subcommand: 'commit', args: ['-m', evil] })

    const log = await executeCodingTool('git', { subcommand: 'log', args: ['--format=%s'] })
    expect(log.output).toContain(evil)

    const files = await executeCodingTool('list_files', {})
    expect(files.output).not.toContain('owned')
  })

  it('refuses to push, and says why', async () => {
    await executeCodingTool('git', { subcommand: 'init' })
    const r = await executeCodingTool('git', { subcommand: 'push', args: ['origin', 'main'] })
    expect(r.output).toContain('GIT FAILED')
    expect(r.output).toMatch(/not allowed/)
  })
})
