/**
 * embeddings.ts — shared local-embedding + HNSW primitives (Task §1).
 *
 * These were private helpers in rag.ts, serving the personal knowledge base.
 * The codebase index (codebaseIndex.ts) needs the exact same building blocks —
 * chunk text, embed a string with the local model, load the native vector
 * index — so they live here and both rag.ts and codebaseIndex.ts import them.
 * Behaviour is unchanged from the rag.ts originals; only the location moved.
 *
 * Everything here degrades on a machine without the native module or a running
 * Ollama: loadHnsw() returns null when hnswlib-node is absent, and embedText()
 * throws a descriptive error when Ollama is unreachable — callers catch that at
 * their tool boundary and fall back (e.g. to search_code). No Electron import,
 * so the module stays loadable under vitest.
 */
import { withOllamaLock } from './ollamaLock'

export const EMBED_MODEL = 'nomic-embed-text'
export const VECTOR_DIM = 768 // nomic-embed-text output dimension
export const CHUNK_SIZE = 512 // characters per chunk
export const CHUNK_OVERLAP = 64 // overlap between consecutive chunks

/** One embeddable slice of a source, tagged with where it came from. */
export interface ChunkMeta {
  text: string
  source: string
  chunkIndex: number
}

/**
 * Message surfaced when the native vector-index module is missing. The Windows
 * trial build ships without `hnswlib-node` because it cannot be compiled against
 * Electron's ABI on the build runner, so vector search is unavailable there.
 */
export const RAG_UNAVAILABLE_MSG =
  'Local knowledge base (RAG) is not available in this build — it currently ships on macOS only.'

/**
 * Split text into overlapping fixed-size character windows. Character-based (not
 * token-based) on purpose: it is dependency-free and good enough for retrieval.
 */
export function chunkText(text: string, source: string): ChunkMeta[] {
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

/**
 * Embed a string locally via Ollama (nomic-embed-text). Throws with a
 * descriptive message when Ollama is unreachable or the model is not pulled —
 * callers are expected to catch and degrade rather than crash the main process.
 */
export async function embedText(text: string): Promise<number[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('ollama')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = mod.default ?? mod
  // Embeddings share the GPU with chat/coding generation, so run them through the
  // same single-flight lock — one local inference on the 8 GB card at a time (see
  // ollamaLock.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await withOllamaLock(() => client.embeddings({ model: EMBED_MODEL, prompt: text }))
  const vec: number[] = res.embedding
  if (!Array.isArray(vec) || vec.length !== VECTOR_DIM) {
    throw new Error(
      `Unexpected embedding dimension: got ${Array.isArray(vec) ? vec.length : typeof vec}, ` +
        `expected ${VECTOR_DIM}. Is Ollama running with the ${EMBED_MODEL} model pulled?`
    )
  }
  return vec
}

/**
 * Returns the `HierarchicalNSW` constructor, or `null` when `hnswlib-node` is
 * not present in this build. Callers must degrade gracefully on `null` rather
 * than crashing the main process.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadHnsw(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('hnswlib-node')
    return mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW ?? null
  } catch {
    return null
  }
}
