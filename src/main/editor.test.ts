/**
 * editor.test.ts — auto-open behaviour for the build agent's project folder.
 *
 * The properties worth pinning down: a build opens at most ONE window however
 * many files it writes, an unarmed (unattended) run opens nothing, and a
 * machine without VS Code still gets its folder shown rather than an error.
 *
 * Electron's shell and the child_process spawn are mocked, so nothing launches.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const h = vi.hoisted(() => ({
  openPath: vi.fn(async (_p: string) => ''),
  spawn: vi.fn(),
  execFile: vi.fn(),
  access: vi.fn(async (_p: string) => undefined as unknown),
  readdir: vi.fn(async (_p: string) => [] as string[])
}))

vi.mock('electron', () => ({ shell: { openPath: h.openPath } }))
// execFile/readdir are unused by these tests (only the named-editor handoff
// path calls them, via appIndex.ts/powershell.ts) but must exist: editor.ts
// now imports that path, and Vitest's module mock requires every named export
// it reads.
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: h.execFile }))
vi.mock('node:fs/promises', () => ({ access: h.access, readdir: h.readdir }))

import { armEditorAutoOpen, disarmEditorAutoOpen, maybeOpenEditorOnFirstWrite, openInEditor } from './editor'

/** A child process that reports a successful spawn. */
function spawnsOk(): EventEmitter & { unref: () => void } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  queueMicrotask(() => child.emit('spawn'))
  return child
}

/** A child process that fails to launch (e.g. `code` is not on PATH). */
function spawnsError(): EventEmitter & { unref: () => void } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  queueMicrotask(() => child.emit('error', new Error('ENOENT')))
  return child
}

const DIR = 'C:\\Users\\Jane Doe\\OpenUI Projects\\snake-game'

beforeEach(() => {
  vi.clearAllMocks()
  disarmEditorAutoOpen()
  h.openPath.mockResolvedValue('')
  h.access.mockResolvedValue(undefined)
  h.spawn.mockImplementation(() => spawnsOk())
})

describe('maybeOpenEditorOnFirstWrite', () => {
  it('opens nothing when not armed (the unattended runner never steals focus)', async () => {
    expect(await maybeOpenEditorOnFirstWrite(DIR)).toBeNull()
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.openPath).not.toHaveBeenCalled()
  })

  it('opens exactly one window no matter how many files the build writes', async () => {
    armEditorAutoOpen()
    expect(await maybeOpenEditorOnFirstWrite(DIR)).toBe('vscode')
    expect(await maybeOpenEditorOnFirstWrite(DIR)).toBeNull()
    expect(await maybeOpenEditorOnFirstWrite(DIR)).toBeNull()
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('disarms even when the launch fails, so a broken editor cannot retry-loop', async () => {
    h.spawn.mockImplementation(() => spawnsError())
    h.openPath.mockRejectedValueOnce(new Error('boom'))
    armEditorAutoOpen()
    expect(await maybeOpenEditorOnFirstWrite(DIR)).toBe('failed')
    expect(await maybeOpenEditorOnFirstWrite(DIR)).toBeNull()
  })

  it('re-arms for the next build session', async () => {
    armEditorAutoOpen()
    await maybeOpenEditorOnFirstWrite(DIR)
    armEditorAutoOpen()
    expect(await maybeOpenEditorOnFirstWrite(DIR)).toBe('vscode')
    expect(h.spawn).toHaveBeenCalledTimes(2)
  })
})

describe('openInEditor', () => {
  it('passes the directory as a single argv entry, never through a shell', async () => {
    await openInEditor(DIR)
    const [exe, args, opts] = h.spawn.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(exe).toMatch(/Code\.exe$|^code$/)
    // The path has a space in it; a shell spawn would split it.
    expect(args).toContain(DIR)
    expect(opts).not.toHaveProperty('shell', true)
    expect(opts).toMatchObject({ detached: true })
  })

  it('falls back to the file browser when VS Code is not installed', async () => {
    h.access.mockRejectedValue(new Error('ENOENT'))
    h.spawn.mockImplementation(() => spawnsError())
    expect(await openInEditor(DIR)).toBe('file-browser')
    expect(h.openPath).toHaveBeenCalledWith(DIR)
  })

  it('falls back when VS Code is present but refuses to launch', async () => {
    h.spawn.mockImplementation(() => spawnsError())
    expect(await openInEditor(DIR)).toBe('file-browser')
    expect(h.openPath).toHaveBeenCalledWith(DIR)
  })

  it('reports failure when the file browser also refuses', async () => {
    h.spawn.mockImplementation(() => spawnsError())
    h.openPath.mockResolvedValue('no application associated')
    expect(await openInEditor(DIR)).toBe('failed')
  })
})
