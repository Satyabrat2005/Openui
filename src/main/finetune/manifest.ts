/**
 * manifest.ts — versioned checkpoint registry for local LoRA fine-tuning.
 *
 * Every fine-tuning pass gets a monotonically increasing version and its own
 * directory (userData/finetune/v<N>/ holding dataset, adapter, Modelfile). The
 * manifest records what happened to each version — the history is APPEND-ONLY
 * and checkpoint directories are never deleted by the pipeline, so the
 * last-known-good model always survives:
 *
 *   - promote() flips the active pointer and marks the old active version
 *     'superseded' (still on disk, still in Ollama — instant rollback target).
 *   - reject() records a candidate that failed its held-out eval; the active
 *     pointer is untouched. That IS the auto-rollback: a regressing candidate
 *     simply never becomes active.
 *
 * File-based (not the settings DB) for the same reason as browser/consent.ts:
 * auditable by the user, unit-testable without better-sqlite3.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CheckpointStatus = 'active' | 'superseded' | 'rejected' | 'failed'

export interface CheckpointEntry {
  version: number
  /** Ollama tag, e.g. "openui-qwen-coder:v3". */
  tag: string
  /** Ollama base model the adapter sits on, e.g. "qwen2.5-coder:7b". */
  baseModel: string
  createdAt: string
  trainSize: number
  holdoutSize: number
  /** Mean held-out score of this candidate (null when eval never ran). */
  evalScore: number | null
  /** Mean held-out score of the model that was active at eval time. */
  baselineScore: number | null
  status: CheckpointStatus
  note?: string
}

export interface FinetuneManifest {
  entries: CheckpointEntry[]
  /** Version currently serving as the local coding model, if any. */
  activeVersion: number | null
}

const MANIFEST_FILE = 'manifest.json'

let dirOverride: string | null = null

/** Point the manifest at a temp dir in unit tests. Pass null to reset. */
export function setFinetuneDirForTests(dir: string | null): void {
  dirOverride = dir
}

/** Root directory for all fine-tuning artifacts (userData/finetune). */
export function getFinetuneDir(): string {
  if (dirOverride) return dirOverride
  // Lazy so importing this module never requires a booted Electron app.
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'finetune')
}

/** Directory holding one version's dataset, adapter and Modelfile. */
export function versionDir(version: number): string {
  return join(getFinetuneDir(), `v${version}`)
}

export function loadManifest(): FinetuneManifest {
  const file = join(getFinetuneDir(), MANIFEST_FILE)
  if (!existsSync(file)) return { entries: [], activeVersion: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FinetuneManifest
    if (!Array.isArray(parsed.entries)) return { entries: [], activeVersion: null }
    return { entries: parsed.entries, activeVersion: parsed.activeVersion ?? null }
  } catch {
    // A corrupt manifest must never brick the pipeline — start a fresh history
    // (checkpoint dirs on disk are unaffected).
    return { entries: [], activeVersion: null }
  }
}

function saveManifest(manifest: FinetuneManifest): void {
  const dir = getFinetuneDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')
}

/** The next unused checkpoint version (1-based). */
export function nextVersion(): number {
  const m = loadManifest()
  return m.entries.reduce((max, e) => Math.max(max, e.version), 0) + 1
}

/** Append a new checkpoint entry (any status). History is append-only. */
export function recordCheckpoint(entry: CheckpointEntry): void {
  const m = loadManifest()
  m.entries.push(entry)
  if (entry.status === 'active') {
    for (const e of m.entries) {
      if (e.version !== entry.version && e.status === 'active') e.status = 'superseded'
    }
    m.activeVersion = entry.version
  }
  saveManifest(m)
}

/**
 * Make `version` the active checkpoint. The previously active entry becomes
 * 'superseded' — never deleted, so it remains an instant rollback target.
 */
export function promote(version: number, evalScore: number, baselineScore: number | null): void {
  const m = loadManifest()
  for (const e of m.entries) {
    if (e.version === version) {
      e.status = 'active'
      e.evalScore = evalScore
      e.baselineScore = baselineScore
    } else if (e.status === 'active') {
      e.status = 'superseded'
    }
  }
  m.activeVersion = version
  saveManifest(m)
}

/**
 * Record that a candidate failed its held-out eval (or the build failed). The
 * active pointer is untouched — the last-known-good model keeps serving.
 */
export function reject(
  version: number,
  status: 'rejected' | 'failed',
  note: string,
  evalScore: number | null = null,
  baselineScore: number | null = null
): void {
  const m = loadManifest()
  for (const e of m.entries) {
    if (e.version === version) {
      e.status = status
      e.note = note
      if (evalScore !== null) e.evalScore = evalScore
      if (baselineScore !== null) e.baselineScore = baselineScore
    }
  }
  saveManifest(m)
}

/** Ollama tag of the active checkpoint, or null when none has been promoted. */
export function getActiveTag(): string | null {
  const m = loadManifest()
  if (m.activeVersion === null) return null
  const entry = m.entries.find((e) => e.version === m.activeVersion && e.status === 'active')
  return entry?.tag ?? null
}
