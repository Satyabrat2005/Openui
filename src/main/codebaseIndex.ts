/**
 * codebaseIndex.ts — a semantic index scoped to the ACTIVE project's source tree (Task §1).
 *
 * rag.ts indexes the user's personal knowledge base. This is a second index, the
 * same HNSW + local-embedding machinery, but pointed at the code the autonomous
 * loop is working on — so instead of grepping for a literal string, the agent can
 * ask "where is auth token refresh handled?" and get back ranked chunks.
 *
 * Design:
 *   • Per-project store under userData/codebase-index/<slug>/ (bin + meta.json),
 *     mirroring rag.ts's vector_index.bin pattern but keyed by project so two
 *     projects don't share one index.
 *   • Incremental: reindexFileInCodebase() re-embeds ONLY a changed file (diffed
 *     by content hash), marking the file's old vectors deleted and adding the new
 *     ones — no full re-index on every write.
 *   • Respects .gitignore plus a built-in skip set (node_modules, dot-dirs, dist…)
 *     and only indexes recognised source extensions.
 *   • Degrades gracefully: with no hnswlib-node, no built index, or Ollama down,
 *     the search returns { ok: false } and the caller falls back to search_code.
 *
 * All embedding/HNSW primitives come from embeddings.ts (shared with rag.ts).
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { getWorkspaceDir, getActiveProject } from './sandbox'
import { VECTOR_DIM, chunkText, embedText, loadHnsw, type ChunkMeta } from './embeddings'

/** Cap the index so a giant repo can't blow past memory / the initial-build time budget. */
const MAX_CHUNKS = 20_000
/** Skip files larger than this — usually generated bundles, not code worth indexing. */
const MAX_SOURCE_BYTES = 256 * 1024

/** Extensions we treat as indexable source. Kept broad but excludes binaries. */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cs', '.php', '.swift', '.kt', '.scala',
  '.vue', '.svelte', '.css', '.scss', '.less', '.html', '.md', '.json', '.yml', '.yaml', '.sql', '.sh'
])

/** Directories always skipped, regardless of .gitignore. */
const ALWAYS_SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.cache', 'vendor', '__pycache__'
])

// ── types ───────────────────────────────────────────────────────────────────────

interface FileEntry {
  hash: string
  labels: number[]
}

interface IndexMeta {
  dim: number
  nextLabel: number
  files: Record<string, FileEntry>
  /** label → chunk metadata (sparse: deleted labels are removed). */
  chunks: Record<string, ChunkMeta>
}

interface LiveIndex {
  slug: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  index: any
  meta: IndexMeta
}

export interface CodebaseChunk {
  text: string
  source: string
  score: number
}

export interface CodebaseSearchResult {
  ok: boolean
  /** Why search could not run, when ok === false. */
  reason?: 'unavailable' | 'empty' | 'embed_failed'
  results: CodebaseChunk[]
}

// ── module state ────────────────────────────────────────────────────────────────

/** The loaded index for the current slug, cached so search/reindex don't re-read the bin. */
let live: LiveIndex | null = null
let rootOverride: string | null = null
/** Guards against two overlapping full rebuilds of the same project. */
let building = false

/** Test seam: relocate the index root (pass null to restore default). */
export function setCodebaseIndexRootForTests(dir: string | null): void {
  rootOverride = dir
  live = null
  building = false
}

function indexRoot(): string {
  if (rootOverride) return rootOverride
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'codebase-index')
}

function currentSlug(): string {
  return getActiveProject() ?? 'workspace'
}

function slugDir(slug: string): string {
  const safe = slug.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'workspace'
  return join(indexRoot(), safe)
}

function slugPaths(slug: string): { dir: string; bin: string; meta: string } {
  const dir = slugDir(slug)
  return { dir, bin: join(dir, 'vector_index.bin'), meta: join(dir, 'meta.json') }
}

function hashContent(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function toRel(relOrAbs: string): string {
  // Normalise to forward-slash workspace-relative, matching how chunk.source is stored.
  return relOrAbs.split(sep).join('/')
}

// ── .gitignore ──────────────────────────────────────────────────────────────────

/** A compiled ignore rule from one .gitignore line. */
interface IgnoreRule {
  re: RegExp
  negated: boolean
  dirOnly: boolean
}

/**
 * Parse .gitignore text into rules. v1 semantics: comments/blank lines skipped,
 * `!` negation, trailing `/` = directory-only, leading `/` = root-anchored,
 * `*`/`**`/`?` globs. Good enough for the node_modules/dist/*.log patterns real
 * repos use; exotic patterns fall through to the built-in skip set + extension
 * filter, so a miss never floods the index.
 */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    const anchored = line.startsWith('/')
    if (anchored) line = line.slice(1)

    const body = gitignoreGlobToRegExp(line)
    // Anchored patterns match from the workspace root; unanchored match a path
    // segment at any depth.
    const source = anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`
    rules.push({ re: new RegExp(source), negated, dirOnly })
  }
  return rules
}

function gitignoreGlobToRegExp(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++ // consume the slash after ** so **/x works
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  return out
}

/**
 * Build a predicate telling whether a workspace-relative path should be ignored.
 * Combines the built-in skip set with the project's .gitignore rules.
 */
export function makeIgnoreFilter(rules: IgnoreRule[]): (relPath: string, isDir: boolean) => boolean {
  return (relPath: string, isDir: boolean): boolean => {
    const segments = relPath.split('/')
    if (segments.some((s) => ALWAYS_SKIP_DIR.has(s))) return true
    // Dot-directories (.git already covered, but also .venv, .idea…) are skipped.
    if (segments.some((s, i) => s.startsWith('.') && (i < segments.length - 1 || isDir))) return true

    let ignored = false
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue
      if (rule.re.test(relPath)) ignored = !rule.negated
    }
    return ignored
  }
}

export function isSourceFile(relPath: string): boolean {
  return SOURCE_EXT.has(extname(relPath).toLowerCase())
}

/**
 * Walk the workspace collecting indexable source files (workspace-relative,
 * forward-slash). Respects .gitignore + the built-in skips + extension allowlist.
 */
export async function collectSourceFiles(workspace: string): Promise<string[]> {
  let ignoreFilter: (relPath: string, isDir: boolean) => boolean
  try {
    const gitignore = await readFile(join(workspace, '.gitignore'), 'utf8')
    ignoreFilter = makeIgnoreFilter(parseGitignore(gitignore))
  } catch {
    ignoreFilter = makeIgnoreFilter([])
  }

  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = toRel(relative(workspace, abs))
      if (ignoreFilter(rel, entry.isDirectory())) continue
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile() && isSourceFile(rel)) {
        try {
          const info = await stat(abs)
          if (info.size <= MAX_SOURCE_BYTES) found.push(rel)
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  await walk(workspace)
  return found
}

// ── index persistence ─────────────────────────────────────────────────────────

async function persist(l: LiveIndex): Promise<void> {
  const paths = slugPaths(l.slug)
  await mkdir(paths.dir, { recursive: true })
  l.index.writeIndex(paths.bin)
  await writeFile(paths.meta, JSON.stringify(l.meta), 'utf8')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadLive(Hnsw: any): Promise<LiveIndex | null> {
  const slug = currentSlug()
  if (live && live.slug === slug) return live
  const paths = slugPaths(slug)
  if (!existsSync(paths.bin) || !existsSync(paths.meta)) {
    live = null
    return null
  }
  try {
    const meta = JSON.parse(await readFile(paths.meta, 'utf8')) as IndexMeta
    const index = new Hnsw('cosine', meta.dim ?? VECTOR_DIM)
    index.readIndex(paths.bin)
    live = { slug, index, meta }
    return live
  } catch {
    live = null
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureCapacity(index: any, label: number): void {
  const max = index.getMaxElements()
  if (label >= max) index.resizeIndex(Math.max(label + 1, max * 2))
}

// ── public API ────────────────────────────────────────────────────────────────

export interface IndexStatus {
  ok: boolean
  reason?: 'unavailable' | 'cached' | 'built' | 'embed_failed'
  files?: number
  chunks?: number
}

/**
 * Ensure the active project has a codebase index, building it once if absent.
 * Idempotent and safe to fire-and-forget from project activation. When the
 * native module is missing or Ollama is down, it returns a non-ok status and the
 * loop simply keeps using search_code.
 */
export async function ensureCodebaseIndexed(): Promise<IndexStatus> {
  const Hnsw = loadHnsw()
  if (!Hnsw) return { ok: false, reason: 'unavailable' }
  const slug = currentSlug()
  const paths = slugPaths(slug)
  if (existsSync(paths.bin) && existsSync(paths.meta)) {
    return { ok: true, reason: 'cached' }
  }
  if (building) return { ok: true, reason: 'cached' }
  building = true
  try {
    return await rebuildAll(Hnsw, slug)
  } catch {
    return { ok: false, reason: 'embed_failed' }
  } finally {
    building = false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rebuildAll(Hnsw: any, slug: string): Promise<IndexStatus> {
  const workspace = getWorkspaceDir()
  const files = await collectSourceFiles(workspace)

  // First pass: read + chunk, capping total chunks.
  const perFile: { rel: string; hash: string; chunks: ChunkMeta[] }[] = []
  let total = 0
  for (const rel of files) {
    if (total >= MAX_CHUNKS) break
    let content: string
    try {
      content = await readFile(join(workspace, rel), 'utf8')
    } catch {
      continue
    }
    const chunks = chunkText(content, rel)
    if (!chunks.length) continue
    perFile.push({ rel, hash: hashContent(content), chunks })
    total += chunks.length
  }

  const index = new Hnsw('cosine', VECTOR_DIM)
  index.initIndex(Math.max(total, 16))
  const meta: IndexMeta = { dim: VECTOR_DIM, nextLabel: 0, files: {}, chunks: {} }

  // Second pass: embed + add. An Ollama failure aborts the whole build (the
  // caller catches and reports embed_failed); no partial index is persisted.
  for (const { rel, hash, chunks } of perFile) {
    const labels: number[] = []
    for (const c of chunks) {
      const vec = await embedText(c.text)
      const label = meta.nextLabel++
      index.addPoint(vec, label)
      meta.chunks[label] = c
      labels.push(label)
    }
    meta.files[rel] = { hash, labels }
  }

  const l: LiveIndex = { slug, index, meta }
  await persist(l)
  live = l
  return { ok: true, reason: 'built', files: perFile.length, chunks: total }
}

/**
 * Re-embed a single file after it was written/edited. Diffs by content hash and
 * no-ops when unchanged; marks the file's old vectors deleted and adds the new
 * ones. Fire-and-forget from the write path — never throws, and silently does
 * nothing when the index/native module/Ollama is unavailable.
 */
export async function reindexFileInCodebase(relPath: string): Promise<void> {
  const Hnsw = loadHnsw()
  if (!Hnsw) return
  try {
    const l = await loadLive(Hnsw)
    if (!l) return // no index yet — ensureCodebaseIndexed builds the initial one
    const rel = toRel(relPath)
    if (!isSourceFile(rel)) return

    const abs = join(getWorkspaceDir(), rel)
    let content: string | null = null
    try {
      content = await readFile(abs, 'utf8')
    } catch {
      content = null // deleted
    }

    const existing = l.meta.files[rel]
    if (content !== null && existing && existing.hash === hashContent(content)) return

    // Drop the file's previous vectors.
    if (existing) {
      for (const label of existing.labels) {
        try {
          l.index.markDelete(label)
        } catch {
          /* already gone */
        }
        delete l.meta.chunks[label]
      }
      delete l.meta.files[rel]
    }

    if (content === null) {
      await persist(l)
      return
    }

    const chunks = chunkText(content, rel)
    const labels: number[] = []
    for (const c of chunks) {
      let vec: number[]
      try {
        vec = await embedText(c.text)
      } catch {
        return // Ollama down mid-update — leave the file de-indexed rather than half-indexed
      }
      const label = l.meta.nextLabel++
      ensureCapacity(l.index, label)
      l.index.addPoint(vec, label)
      l.meta.chunks[label] = c
      labels.push(label)
    }
    l.meta.files[rel] = { hash: hashContent(content), labels }
    await persist(l)
  } catch {
    // Never propagate into the write path.
  }
}

/**
 * Semantic search over the active project's index. Returns ranked chunks, or
 * { ok: false } with a reason so the caller can fall back to search_code.
 */
export async function searchCodebaseSemantic(query: string, topK = 6): Promise<CodebaseSearchResult> {
  const Hnsw = loadHnsw()
  if (!Hnsw) return { ok: false, reason: 'unavailable', results: [] }
  const l = await loadLive(Hnsw)
  if (!l) return { ok: false, reason: 'empty', results: [] }

  const count = l.index.getCurrentCount()
  if (!count) return { ok: false, reason: 'empty', results: [] }

  let qvec: number[]
  try {
    qvec = await embedText(query)
  } catch {
    return { ok: false, reason: 'embed_failed', results: [] }
  }

  const k = Math.min(topK, count)
  const res = l.index.searchKnn(qvec, k)
  const results: CodebaseChunk[] = []
  for (let i = 0; i < res.neighbors.length; i++) {
    const meta = l.meta.chunks[res.neighbors[i]]
    if (!meta) continue // tombstoned label
    results.push({
      text: meta.text,
      source: meta.source,
      score: parseFloat((1 - res.distances[i]).toFixed(4))
    })
  }
  return { ok: true, results }
}
