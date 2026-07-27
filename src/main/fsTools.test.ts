import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

// tools.ts statically imports electron. In the plain-node vitest environment it
// isn't available, so we mock it at the module boundary — but unlike tools.test
// (which stubs clipboard/shell), these tests exercise read/write_clipboard and
// delete_file for real, so the mock backs them with observable behaviour:
//  • clipboard is an in-memory string the two tools read/write
//  • shell.trashItem actually removes the target, so "was it deleted?" is real
let clipboardText = ''
const trashItem = vi.fn(async (p: string) => {
  await rm(p, { recursive: true, force: true })
})
vi.mock('electron', () => ({
  app: { getPath: () => homedir(), getName: () => 'OpenUI' },
  desktopCapturer: {},
  clipboard: {
    readText: () => clipboardText,
    writeText: (t: string) => {
      clipboardText = t
    }
  },
  shell: { openPath: vi.fn(async () => ''), trashItem: (p: string) => trashItem(p) },
  systemPreferences: {},
  dialog: {},
  BrowserWindow: class {}
}))
vi.mock('./telemetry/posthog', () => ({ trackEvent: () => {} }))

import { executeTool } from './tools'

const RUN = { tier: 'free' as const, bypassHitl: true }

// Every mutating fs tool is confined to the home tree, so the sandbox lives
// under $HOME (mirrors the create_folder happy-path test in tools.test.ts).
let dir: string
const roots: string[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(homedir(), 'openui-fs-test-'))
  roots.push(dir)
})
afterEach(async () => {
  clipboardText = ''
  trashItem.mockClear()
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('write_file → read_file round-trip', () => {
  it('writes real bytes and reads the exact content back', async () => {
    const p = join(dir, 'notes.txt')
    const body = 'line one\nline two — with unicode ✓\n'
    const w = await executeTool('write_file', { path: p, content: body }, RUN)
    expect(w).toMatchObject({ ok: true })
    // The bytes are actually on disk, not just an ok:true.
    expect(await readFile(p, 'utf8')).toBe(body)

    const r = await executeTool('read_file', { path: p }, RUN)
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toBe(body)
  })

  it('creates missing parent folders when writing', async () => {
    const p = join(dir, 'deep', 'nested', 'a.txt')
    const w = await executeTool('write_file', { path: p, content: 'hi' }, RUN)
    expect(w).toMatchObject({ ok: true })
    expect(existsSync(p)).toBe(true)
  })

  it('read_file reports "(file is empty)" for a zero-byte file, not a crash', async () => {
    const p = join(dir, 'empty.txt')
    await writeFile(p, '', 'utf8')
    const r = await executeTool('read_file', { path: p }, RUN)
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toBe('(file is empty)')
  })

  it('read_file refuses a directory and points at list_directory', async () => {
    const r = await executeTool('read_file', { path: dir }, RUN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/list_directory/)
  })

  it('read_file surfaces a clear not-found error for a ghost path', async () => {
    const r = await executeTool('read_file', { path: join(dir, 'ghost.txt') }, RUN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/read_file failed/)
  })

  it('write_file refuses a path outside the home tree', async () => {
    const outside = process.platform === 'win32' ? 'C:\\openui-fs-outside.txt' : '/openui-fs-outside.txt'
    const r = await executeTool('write_file', { path: outside, content: 'x' }, RUN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/home folder/)
  })
})

describe('list_directory', () => {
  it('lists real files and folders with type tags', async () => {
    await writeFile(join(dir, 'file-a.txt'), 'a', 'utf8')
    await mkdir(join(dir, 'sub'))
    const r = await executeTool('list_directory', { path: dir }, RUN)
    expect(r).toMatchObject({ ok: true })
    const out = (r as { output: string }).output
    expect(out).toMatch(/\[file\] file-a\.txt/)
    expect(out).toMatch(/\[dir\] {2}sub/)
  })

  it('reports an empty directory rather than erroring', async () => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const r = await executeTool('list_directory', { path: empty }, RUN)
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toMatch(/is empty/)
  })
})

describe('copy_file', () => {
  it('copies real bytes to a new path, leaving the source in place', async () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'copy.txt')
    await writeFile(src, 'payload', 'utf8')
    const r = await executeTool('copy_file', { source: src, destination: dst }, RUN)
    expect(r).toMatchObject({ ok: true })
    expect(await readFile(dst, 'utf8')).toBe('payload')
    expect(existsSync(src)).toBe(true) // copy, not move
  })

  it('refuses to copy a folder', async () => {
    const sub = join(dir, 'folder')
    await mkdir(sub)
    const r = await executeTool('copy_file', { source: sub, destination: join(dir, 'x') }, RUN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/folders is not supported/)
  })
})

describe('move_file', () => {
  it('renames a file: destination appears, source disappears', async () => {
    const src = join(dir, 'before.txt')
    const dst = join(dir, 'after.txt')
    await writeFile(src, 'movable', 'utf8')
    const r = await executeTool('move_file', { source: src, destination: dst }, RUN)
    expect(r).toMatchObject({ ok: true })
    expect(existsSync(src)).toBe(false)
    expect(await readFile(dst, 'utf8')).toBe('movable')
  })

  it('creates the destination parent folder on the way', async () => {
    const src = join(dir, 'x.txt')
    const dst = join(dir, 'newdir', 'x.txt')
    await writeFile(src, '1', 'utf8')
    const r = await executeTool('move_file', { source: src, destination: dst }, RUN)
    expect(r).toMatchObject({ ok: true })
    expect(existsSync(dst)).toBe(true)
  })
})

describe('delete_file', () => {
  it('routes through the Recycle Bin (shell.trashItem), not a hard unlink', async () => {
    const p = join(dir, 'trash-me.txt')
    await writeFile(p, 'bye', 'utf8')
    const r = await executeTool('delete_file', { path: p }, RUN)
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toMatch(/Recycle Bin/)
    // It called trashItem with the resolved path — the recoverable delete path,
    // never fs.unlink. Our mock backs trashItem with a real removal.
    expect(trashItem).toHaveBeenCalledTimes(1)
    expect(trashItem.mock.calls[0][0]).toBe(p)
    expect(existsSync(p)).toBe(false)
  })

  it('surfaces a clear not-found error before touching the trash', async () => {
    const r = await executeTool('delete_file', { path: join(dir, 'ghost.txt') }, RUN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/delete_file failed/)
    expect(trashItem).not.toHaveBeenCalled()
  })
})

describe('clipboard round-trip', () => {
  it('write_clipboard then read_clipboard returns the same text', async () => {
    const w = await executeTool('write_clipboard', { text: 'copied-value' }, RUN)
    expect(w).toMatchObject({ ok: true })
    expect(clipboardText).toBe('copied-value')

    const r = await executeTool('read_clipboard', {}, RUN)
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toBe('copied-value')
  })

  it('write_clipboard rejects empty text', async () => {
    const r = await executeTool('write_clipboard', { text: '' }, RUN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/non-empty/)
  })

  it('read_clipboard reports an empty clipboard rather than crashing', async () => {
    clipboardText = ''
    const r = await executeTool('read_clipboard', {}, RUN)
    expect(r).toMatchObject({ ok: true })
    expect((r as { output: string }).output).toBe('(clipboard is empty)')
  })
})
