/**
 * rag.ts — Local Knowledge Base (RAG) for OpenUI.
 *
 * Indexes local .txt and .pdf files into an HNSWLIB vector index stored in the
 * user-data directory.  Embeddings are generated locally via Ollama
 * (nomic-embed-text), so no document content leaves the machine.
 *
 * Public surface:
 *   indexDirectory(dirPath)       — scan dir, embed chunks, persist index
 *   searchLocalKnowledge(query)   — embed query, return top-K matching chunks
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { app } from 'electron'

const EMBED_MODEL = 'nomic-embed-text'
const VECTOR_DIM = 768          // nomic-embed-text output dimension
const CHUNK_SIZE = 512          // characters per chunk
const CHUNK_OVERLAP = 64        // overlap between consecutive chunks
const MAX_INDEX_ELEMENTS = 10_000

// ── paths ─────────────────────────────────────────────────────────────────────

function indexPath(): string {
  return join(app.getPath('userData'), 'vector_index.bin')
}

function metaPath(): string {
  return join(app.getPath('userData'), 'vector_index.json')
}

// ── types ─────────────────────────────────────────────────────────────────────

interface ChunkMeta {
  text: string
  source: string
  chunkIndex: number
}

export interface SearchResult {
  text: string
  source: string
  score: number
}

// ── text utilities ─────────────────────────────────────────────────────────────

function chunkText(text: string, source: string): ChunkMeta[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const chunks: ChunkMeta[] = []
  let start = 0
  let idx = 0
  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE, normalized.length)
    const chunk = normalized.slice(start, end).trim()
    if (chunk.length > 20) {
      chunks.push({ text: chunk, source, chunkIndex: idx++ })
    }
    if (end === normalized.length) break
    start += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return chunks
}

// ── embedding ─────────────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('ollama')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = mod.default ?? mod
  const res = await client.embeddings({ model: EMBED_MODEL, prompt: text })
  const vec: number[] = res.embedding
  if (!Array.isArray(vec) || vec.length !== VECTOR_DIM) {
    throw new Error(
      `Unexpected embedding dimension: got ${Array.isArray(vec) ? vec.length : typeof vec}, ` +
        `expected ${VECTOR_DIM}. Is Ollama running with the ${EMBED_MODEL} model pulled?`
    )
  }
  return vec
}

// ── HNSWLIB helpers ───────────────────────────────────────────────────────────

/**
 * Message surfaced when the native vector-index module is missing. The Windows
 * trial build ships without `hnswlib-node` because it cannot be compiled against
 * Electron's ABI on the build runner, so RAG is unavailable there.
 */
export const RAG_UNAVAILABLE_MSG =
  'Local knowledge base (RAG) is not available in this build — it currently ships on macOS only.'

/**
 * Returns the `HierarchicalNSW` constructor, or `null` when `hnswlib-node` is
 * not present in this build. Callers must degrade gracefully on `null` rather
 * than crashing the main process.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadHnsw(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('hnswlib-node')
    return mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW ?? null
  } catch {
    return null
  }
}

// ── public API ────────────────────────────────────────────────────────────────

export interface IndexResult {
  indexed: number
  chunks: number
  error?: string
}

/**
 * Walk `dirPath`, read every .txt and .pdf file, split each into overlapping
 * chunks, embed them with Ollama, and persist the HNSWLIB index plus a JSON
 * metadata sidecar to the user-data directory.
 *
 * Safe to call multiple times — each call rebuilds the index from scratch so
 * stale documents are removed automatically.
 */
export async function indexDirectory(dirPath: string): Promise<IndexResult> {
  // ── 0. Native vector index available? ──────────────────────────────────────
  if (!loadHnsw()) {
    return { indexed: 0, chunks: 0, error: RAG_UNAVAILABLE_MSG }
  }

  // ── 1. Collect supported files ─────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let entries: any[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    return {
      indexed: 0,
      chunks: 0,
      error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const files: string[] = entries
    .filter((e) => e.isFile() && ['.txt', '.pdf'].includes(extname(e.name).toLowerCase()))
    .map((e: { name: string }) => join(dirPath, e.name))

  if (files.length === 0) {
    return { indexed: 0, chunks: 0, error: 'No .txt or .pdf files found in the directory.' }
  }

  // ── 2. Parse files into chunks ─────────────────────────────────────────────
  const allChunks: ChunkMeta[] = []

  for (const filePath of files) {
    try {
      let text = ''
      if (extname(filePath).toLowerCase() === '.txt') {
        text = Buffer.from(await readFile(filePath)).toString('utf-8')
      } else {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pdfParse = require('pdf-parse')
        const buf = Buffer.from(await readFile(filePath))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await pdfParse(buf)
        text = result.text as string
      }
      allChunks.push(...chunkText(text, filePath))
    } catch (err) {
      console.error(`[rag] Skipping ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (allChunks.length === 0) {
    return { indexed: files.length, chunks: 0, error: 'Files were found but yielded no usable text.' }
  }

  // ── 3. Build the HNSWLIB index ─────────────────────────────────────────────
  const HierarchicalNSW = loadHnsw()
  const index = new HierarchicalNSW('cosine', VECTOR_DIM)
  index.initIndex(Math.max(allChunks.length, MAX_INDEX_ELEMENTS))

  for (let i = 0; i < allChunks.length; i++) {
    const vector = await embedText(allChunks[i].text)
    index.addPoint(vector, i)
  }

  // ── 4. Persist ─────────────────────────────────────────────────────────────
  index.writeIndex(indexPath())
  await writeFile(metaPath(), JSON.stringify(allChunks), 'utf-8')

  return { indexed: files.length, chunks: allChunks.length }
}

/**
 * Embed `query` with Ollama and return the top-K most semantically similar
 * chunks from the previously built index.  Returns an empty array when no
 * index exists yet (user has not run indexDirectory).
 */
export async function searchLocalKnowledge(query: string, topK = 5): Promise<SearchResult[]> {
  const HierarchicalNSW = loadHnsw()
  // No native module (e.g. Windows build) or no index built yet → no results.
  if (!HierarchicalNSW || !existsSync(indexPath()) || !existsSync(metaPath())) return []

  const index = new HierarchicalNSW('cosine', VECTOR_DIM)
  index.readIndex(indexPath())

  const allChunks: ChunkMeta[] = JSON.parse(Buffer.from(await readFile(metaPath())).toString('utf-8'))
  const queryVector = await embedText(query)
  const k = Math.min(topK, allChunks.length)

  const { neighbors, distances } = index.searchKnn(queryVector, k) as {
    neighbors: number[]
    distances: number[]
  }

  return neighbors.map((label: number, i: number) => ({
    text: allChunks[label]?.text ?? '',
    source: allChunks[label]?.source ?? '',
    score: parseFloat((1 - distances[i]).toFixed(4))
  }))
}
