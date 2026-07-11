import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

import {
  extractSymbols,
  extractImports,
  resolveImport,
  buildCodebaseMap,
  updateCodebaseMapForFile,
  findDefinition,
  findUsages,
  resetCodebaseMapForTests
} from './codebaseMap'

describe('extractSymbols', () => {
  it('finds JS/TS declarations with the right kind and line', () => {
    const src = [
      'export function alpha() {}', // 1
      'class Beta {}', // 2
      'export const gamma = () => 1', // 3
      'export interface Delta {}', // 4
      'type Epsilon = string', // 5
      'export enum Zeta { A }' // 6
    ].join('\n')
    const syms = extractSymbols(src, 'src/x.ts')
    expect(syms).toEqual([
      { name: 'alpha', kind: 'function', file: 'src/x.ts', line: 1 },
      { name: 'Beta', kind: 'class', file: 'src/x.ts', line: 2 },
      { name: 'gamma', kind: 'const', file: 'src/x.ts', line: 3 },
      { name: 'Delta', kind: 'interface', file: 'src/x.ts', line: 4 },
      { name: 'Epsilon', kind: 'type', file: 'src/x.ts', line: 5 },
      { name: 'Zeta', kind: 'enum', file: 'src/x.ts', line: 6 }
    ])
  })

  it('treats "export const enum" as an enum, not a const', () => {
    expect(extractSymbols('export const enum E { A }', 'a.ts')[0].kind).toBe('enum')
  })

  it('extracts Python def/class', () => {
    const syms = extractSymbols('def handler(req):\n    pass\nclass Model:\n    pass\n', 'app.py')
    expect(syms).toEqual([
      { name: 'handler', kind: 'function', file: 'app.py', line: 1 },
      { name: 'Model', kind: 'class', file: 'app.py', line: 3 }
    ])
  })
})

describe('extractImports', () => {
  it('handles import/from, side-effect, dynamic import and require', () => {
    const src = [
      "import { a } from './a'",
      "import './styles.css'",
      "export { z } from './z'",
      "const m = require('./legacy')",
      "const d = await import('./dyn')"
    ].join('\n')
    expect(extractImports(src, 'src/i.ts').sort()).toEqual(
      ['./a', './dyn', './legacy', './styles.css', './z'].sort()
    )
  })

  it('handles Python import forms', () => {
    expect(extractImports('from .models import X\nimport utils\n', 'app.py').sort()).toEqual(
      ['.models', 'utils'].sort()
    )
  })
})

describe('resolveImport', () => {
  const known = new Set(['src/a.ts', 'src/util/index.ts', 'src/b.py'])
  it('resolves a relative specifier through extension candidates', () => {
    expect(resolveImport('./a', 'src/main.ts', known)).toBe('src/a.ts')
  })
  it('resolves a directory to its index file', () => {
    expect(resolveImport('./util', 'src/main.ts', known)).toBe('src/util/index.ts')
  })
  it('returns null for bare package specifiers', () => {
    expect(resolveImport('react', 'src/main.ts', known)).toBeNull()
  })
  it('returns null when nothing matches', () => {
    expect(resolveImport('./missing', 'src/main.ts', known)).toBeNull()
  })
})

describe('map queries over a real workspace', () => {
  let ws: string
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'openui-cbmap-'))
    process.env.OPENUI_WORKSPACE = ws
    resetCodebaseMapForTests()
  })
  afterEach(async () => {
    delete process.env.OPENUI_WORKSPACE
    resetCodebaseMapForTests()
    await rm(ws, { recursive: true, force: true })
  })

  it('finds a definition and its usages across files', async () => {
    await mkdir(join(ws, 'src'), { recursive: true })
    await writeFile(join(ws, 'src', 'auth.ts'), 'export function refreshToken() {\n  return 1\n}\n')
    await writeFile(
      join(ws, 'src', 'client.ts'),
      "import { refreshToken } from './auth'\nrefreshToken()\nconst x = refreshToken() + 1\n"
    )
    await buildCodebaseMap()

    const def = await findDefinition('refreshToken')
    expect(def.ok).toBe(true)
    expect(def.defs[0]).toMatchObject({ file: 'src/auth.ts', line: 1, kind: 'function' })

    const usages = await findUsages('refreshToken')
    expect(usages.ok).toBe(true)
    // Both call sites in client.ts, not the declaration line in auth.ts.
    const files = usages.usages.map((u) => u.file)
    expect(files).toContain('src/client.ts')
    expect(usages.usages.some((u) => u.file === 'src/auth.ts' && u.line === 1)).toBe(false)
    expect(usages.note).toMatch(/imported by/)
  })

  it('reflects an incremental update after a file changes', async () => {
    await mkdir(join(ws, 'src'), { recursive: true })
    await writeFile(join(ws, 'src', 'a.ts'), 'export const oldName = 1\n')
    await buildCodebaseMap()
    expect((await findDefinition('oldName')).ok).toBe(true)

    await writeFile(join(ws, 'src', 'a.ts'), 'export const newName = 1\n')
    await updateCodebaseMapForFile('src/a.ts')

    expect((await findDefinition('oldName')).ok).toBe(false)
    expect((await findDefinition('newName')).ok).toBe(true)
  })
})
