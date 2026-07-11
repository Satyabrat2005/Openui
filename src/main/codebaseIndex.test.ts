import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// sandbox.ts (imported transitively) statically pulls in electron's `app`; mock
// it so the module graph loads under plain node.
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

import {
  parseGitignore,
  makeIgnoreFilter,
  isSourceFile,
  collectSourceFiles,
  searchCodebaseSemantic,
  ensureCodebaseIndexed,
  reindexFileInCodebase,
  setCodebaseIndexRootForTests
} from './codebaseIndex'

describe('parseGitignore + makeIgnoreFilter', () => {
  it('ignores a directory pattern at any depth', () => {
    const ignore = makeIgnoreFilter(parseGitignore('dist/\n'))
    expect(ignore('dist', true)).toBe(true)
    expect(ignore('pkg/dist', true)).toBe(true)
    expect(ignore('src/app.ts', false)).toBe(false)
  })

  it('ignores a glob extension pattern', () => {
    const ignore = makeIgnoreFilter(parseGitignore('*.log\n'))
    expect(ignore('debug.log', false)).toBe(true)
    expect(ignore('logs/debug.log', false)).toBe(true)
    expect(ignore('app.ts', false)).toBe(false)
  })

  it('honours a root anchor', () => {
    const ignore = makeIgnoreFilter(parseGitignore('/secret.txt\n'))
    expect(ignore('secret.txt', false)).toBe(true)
    expect(ignore('nested/secret.txt', false)).toBe(false)
  })

  it('supports negation re-including a path', () => {
    const ignore = makeIgnoreFilter(parseGitignore('*.env\n!keep.env\n'))
    expect(ignore('prod.env', false)).toBe(true)
    expect(ignore('keep.env', false)).toBe(false)
  })

  it('skips comments and blank lines', () => {
    expect(parseGitignore('# a comment\n\n   \n')).toHaveLength(0)
  })

  it('always skips node_modules and dot-dirs regardless of rules', () => {
    const ignore = makeIgnoreFilter([])
    expect(ignore('node_modules/react/index.js', false)).toBe(true)
    expect(ignore('.git/config', false)).toBe(true)
    expect(ignore('src/index.ts', false)).toBe(false)
  })
})

describe('isSourceFile', () => {
  it('recognises source extensions and rejects others', () => {
    expect(isSourceFile('src/a.ts')).toBe(true)
    expect(isSourceFile('src/a.py')).toBe(true)
    expect(isSourceFile('README.md')).toBe(true)
    expect(isSourceFile('logo.png')).toBe(false)
    expect(isSourceFile('data.bin')).toBe(false)
  })
})

describe('collectSourceFiles', () => {
  let ws: string
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'openui-cbidx-'))
  })
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it('walks source files, honouring .gitignore and the built-in skips', async () => {
    await mkdir(join(ws, 'src'), { recursive: true })
    await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(ws, 'dist'), { recursive: true })
    await writeFile(join(ws, '.gitignore'), 'dist/\n*.log\n')
    await writeFile(join(ws, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(ws, 'src', 'b.py'), 'b = 1\n')
    await writeFile(join(ws, 'README.md'), '# hi\n')
    await writeFile(join(ws, 'debug.log'), 'noise\n')
    await writeFile(join(ws, 'node_modules', 'pkg', 'x.js'), 'module.exports = {}\n')
    await writeFile(join(ws, 'dist', 'bundle.js'), 'var x\n')

    const files = (await collectSourceFiles(ws)).sort()
    expect(files).toEqual(['README.md', 'src/a.ts', 'src/b.py'])
  })
})

describe('graceful degradation (no native module / Ollama here)', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openui-cbidx-root-'))
    setCodebaseIndexRootForTests(root)
  })
  afterEach(async () => {
    setCodebaseIndexRootForTests(null)
    await rm(root, { recursive: true, force: true })
  })

  it('search returns ok:false with no results rather than throwing', async () => {
    const res = await searchCodebaseSemantic('where is auth handled?')
    expect(res.ok).toBe(false)
    expect(res.results).toEqual([])
  })

  it('ensureCodebaseIndexed always returns a well-formed status, never throws', async () => {
    const status = await ensureCodebaseIndexed()
    // Environment-independent: with the native module present it may build a
    // (possibly empty) index ('built') or reuse one ('cached'); without it, or
    // when embedding is unavailable, it reports a known non-ok reason. The
    // guarantee is that it never throws and never falsely claims success.
    if (status.ok) expect(['built', 'cached']).toContain(status.reason)
    else expect(['unavailable', 'embed_failed']).toContain(status.reason)
  })

  it('reindexFileInCodebase never throws on the write path', async () => {
    await expect(reindexFileInCodebase('src/whatever.ts')).resolves.toBeUndefined()
  })
})
