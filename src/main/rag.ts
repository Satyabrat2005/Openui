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
import { VECTOR_DIM, RAG_UNAVAILABLE_MSG, chunkText, embedText, loadHnsw } from './embeddings'
import type { ChunkMeta } from './embeddings'

// Re-exported for callers that import it from rag.ts (its original home).
export { RAG_UNAVAILABLE_MSG }

const MAX_INDEX_ELEMENTS = 10_000

// ── paths ─────────────────────────────────────────────────────────────────────

function indexPath(): string {
  return join(app.getPath('userData'), 'vector_index.bin')
}

function metaPath(): string {
  return join(app.getPath('userData'), 'vector_index.json')
}

// ── types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  text: string
  source: string
  score: number
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
