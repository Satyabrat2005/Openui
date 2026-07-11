/**
 * codebaseMap.ts — a lightweight symbol + import/export map of the project (Task §2).
 *
 * Semantic search (codebaseIndex.ts) finds the right AREA by meaning; this map
 * answers the precise structural questions a multi-file refactor keeps asking:
 * "where is `refreshToken` defined?" and "who calls it?" — without re-grepping
 * the whole tree on every turn. It is built once on project activation and
 * updated incrementally on each write, same trigger as the semantic re-index.
 *
 * v1 is a regex extractor, not a full parser (per tasks.md §2): it recognises
 * top-level function/class/const/interface/type/enum declarations for JS/TS and
 * def/class for Python, plus relative import edges. That is enough to power
 * find_definition and find_usages; it is intentionally not a type-aware index.
 *
 * The extractor functions are pure (string in, structs out) and unit-tested with
 * fixtures; only the map builder touches the filesystem.
 */
import { readFile } from 'node:fs/promises'
import { join, sep, posix } from 'node:path'
import { getWorkspaceDir, getActiveProject, searchSandbox, readSandboxRegion } from './sandbox'
import { collectSourceFiles, isSourceFile } from './codebaseIndex'

export type SymbolKind = 'function' | 'class' | 'const' | 'interface' | 'type' | 'enum'

export interface SymbolDecl {
  name: string
  kind: SymbolKind
  /** Workspace-relative, forward-slash path. */
  file: string
  /** 1-based line. */
  line: number
}

// Declaration patterns, most-specific first so `export const enum` is an enum,
// not a const. First match per line wins.
const JS_PATTERNS: { re: RegExp; kind: SymbolKind }[] = [
  { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^\s*type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: 'type' },
  { re: /^\s*export\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^\s*(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
  { re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'const' }
]

const PY_PATTERNS: { re: RegExp; kind: SymbolKind }[] = [
  { re: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
  { re: /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/, kind: 'class' }
]

/** Extract top-level declarations from one file's source (pure). */
export function extractSymbols(source: string, path: string): SymbolDecl[] {
  const patterns = path.endsWith('.py') ? PY_PATTERNS : JS_PATTERNS
  const out: SymbolDecl[] = []
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind } of patterns) {
      const m = lines[i].match(re)
      if (m) {
        out.push({ name: m[1], kind, file: path, line: i + 1 })
        break
      }
    }
  }
  return out
}

/** Extract module import specifiers from one file's source (pure). */
export function extractImports(source: string, path: string): string[] {
  const specs = new Set<string>()
  if (path.endsWith('.py')) {
    for (const m of source.matchAll(/^\s*from\s+([.\w]+)\s+import\b/gm)) specs.add(m[1])
    for (const m of source.matchAll(/^\s*import\s+([.\w]+)/gm)) specs.add(m[1])
    return [...specs]
  }
  for (const m of source.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1])
  for (const m of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1])
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1])
  for (const m of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1])
  return [...specs]
}

/**
 * Resolve a relative import specifier to a known workspace file, trying the
 * usual extension + index candidates. Bare-module specifiers (packages) and
 * anything not in `known` resolve to null. Pure — `known` is passed in.
 */
export function resolveImport(spec: string, fromPath: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec))
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}.py`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`, `${base}/__init__.py`
  ]
  for (const c of candidates) if (known.has(c)) return c
  return null
}

// ── stateful map ────────────────────────────────────────────────────────────────

interface MapState {
  slug: string
  files: Set<string>
  /** symbol name → declarations. */
  symbols: Map<string, SymbolDecl[]>
  /** file → the workspace files it imports. */
  fileImports: Map<string, string[]>
  /** file → the workspace files that import it. */
  importedBy: Map<string, string[]>
}

let state: MapState | null = null

/** Test seam: drop the in-memory map. */
export function resetCodebaseMapForTests(): void {
  state = null
}

function currentSlug(): string {
  return getActiveProject() ?? 'workspace'
}

function toRel(p: string): string {
  return p.split(sep).join('/')
}

/** Build (or rebuild) the whole map for the active project. In-memory only. */
export async function buildCodebaseMap(): Promise<{ files: number; symbols: number }> {
  const workspace = getWorkspaceDir()
  const slug = currentSlug()
  const files = await collectSourceFiles(workspace)
  const known = new Set(files)
  const symbols = new Map<string, SymbolDecl[]>()
  const fileImports = new Map<string, string[]>()
  const importedBy = new Map<string, string[]>()
  let symCount = 0

  for (const rel of files) {
    let content: string
    try {
      content = await readFile(join(workspace, rel), 'utf8')
    } catch {
      continue
    }
    for (const decl of extractSymbols(content, rel)) {
      const arr = symbols.get(decl.name) ?? []
      arr.push(decl)
      symbols.set(decl.name, arr)
      symCount++
    }
    const resolved: string[] = []
    for (const spec of extractImports(content, rel)) {
      const target = resolveImport(spec, rel, known)
      if (!target) continue
      resolved.push(target)
      const back = importedBy.get(target) ?? []
      back.push(rel)
      importedBy.set(target, back)
    }
    fileImports.set(rel, resolved)
  }

  state = { slug, files: known, symbols, fileImports, importedBy }
  return { files: files.length, symbols: symCount }
}

async function ensureMap(): Promise<MapState> {
  if (state && state.slug === currentSlug()) return state
  await buildCodebaseMap()
  return state as MapState
}

/**
 * Update just one file's entries after it was written/edited. No-op until the
 * map has been built for the current project (activation builds it). Never
 * throws — safe to fire-and-forget from the write path.
 */
export async function updateCodebaseMapForFile(relPath: string): Promise<void> {
  try {
    if (!state || state.slug !== currentSlug()) return
    const rel = toRel(relPath)
    if (!isSourceFile(rel)) return
    const s = state

    // Drop this file's old symbols.
    for (const [name, decls] of s.symbols) {
      const kept = decls.filter((d) => d.file !== rel)
      if (kept.length) s.symbols.set(name, kept)
      else s.symbols.delete(name)
    }
    // Drop this file's old import edges.
    for (const target of s.fileImports.get(rel) ?? []) {
      const back = (s.importedBy.get(target) ?? []).filter((f) => f !== rel)
      if (back.length) s.importedBy.set(target, back)
      else s.importedBy.delete(target)
    }
    s.fileImports.delete(rel)

    let content: string | null = null
    try {
      content = await readFile(join(getWorkspaceDir(), rel), 'utf8')
    } catch {
      content = null // deleted
    }
    if (content === null) {
      s.files.delete(rel)
      return
    }
    s.files.add(rel)

    for (const decl of extractSymbols(content, rel)) {
      const arr = s.symbols.get(decl.name) ?? []
      arr.push(decl)
      s.symbols.set(decl.name, arr)
    }
    const resolved: string[] = []
    for (const spec of extractImports(content, rel)) {
      const target = resolveImport(spec, rel, s.files)
      if (!target) continue
      resolved.push(target)
      const back = s.importedBy.get(target) ?? []
      if (!back.includes(rel)) back.push(rel)
      s.importedBy.set(target, back)
    }
    s.fileImports.set(rel, resolved)
  } catch {
    // Never propagate into the write path.
  }
}

// ── query API (backs the find_definition / find_usages tools) ────────────────────

export interface DefinitionResult {
  ok: boolean
  defs: { file: string; line: number; kind: SymbolKind; snippet?: string }[]
}

export async function findDefinition(symbol: string): Promise<DefinitionResult> {
  const s = await ensureMap()
  const decls = (s.symbols.get(symbol) ?? []).slice(0, 10)
  const defs: DefinitionResult['defs'] = []
  for (const d of decls) {
    const region = await readSandboxRegion(d.file, d.line, 4)
    defs.push({ file: d.file, line: d.line, kind: d.kind, snippet: region.ok ? region.snippet : undefined })
  }
  return { ok: defs.length > 0, defs }
}

export interface UsageResult {
  ok: boolean
  usages: { file: string; line: number; text: string }[]
  /** Import-graph context, e.g. where the symbol's defining file is imported. */
  note?: string
}

export async function findUsages(symbol: string): Promise<UsageResult> {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    return { ok: false, usages: [], note: 'symbol must be a plain identifier' }
  }
  const s = await ensureMap()
  const matches = await searchSandbox(`\\b${symbol}\\b`, { maxResults: 60 })
  const defs = s.symbols.get(symbol) ?? []
  const defSites = new Set(defs.map((d) => `${d.file}:${d.line}`))
  const usages = matches
    .filter((m) => !defSites.has(`${m.file}:${m.line}`))
    .map((m) => ({ file: m.file, line: m.line, text: m.text }))

  let note: string | undefined
  const defFiles = [...new Set(defs.map((d) => d.file))]
  if (defFiles.length) {
    const importers = new Set<string>()
    for (const f of defFiles) for (const imp of s.importedBy.get(f) ?? []) importers.add(imp)
    note = `Defined in ${defFiles.join(', ')}` + (importers.size ? `; imported by ${importers.size} file(s).` : '.')
  }
  return { ok: usages.length > 0, usages, note }
}
