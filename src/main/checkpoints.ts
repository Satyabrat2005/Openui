/**
 * checkpoints.ts — cross-session resume for autonomous coding tasks (Task §7).
 *
 * A large autonomous task can span far longer than one idle window; if the app
 * closes (or the user returns) mid-task, the old loop simply restarted the task
 * from scratch next time — re-doing sub-tasks that were already built, tested,
 * and committed. This module persists a tiny durable record per in-flight task so
 * a later session can pick it back up:
 *
 *   { taskId, source, subtaskIds, completedSubtaskIds, lastGoodCommit, turnsUsed }
 *
 * stored at userData/autonomous-resume/<taskId>.json. Resume granularity is the
 * SUB-TASK (it composes with §3 decomposition): on resume we skip the sub-tasks
 * already merged and continue from the last good commit. Fine-grained
 * message-level replay is deliberately out of scope — the model re-orients from
 * committed state.
 *
 * Design mirrors runLog.ts: a `set*ForTests` seam, a lazy `require('electron')`
 * so the module is importable under plain-node vitest, and every function
 * swallows its own IO errors — a failed checkpoint must never break a task run.
 */
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskSource } from './tasks'

export interface ResumeCheckpoint {
  taskId: string
  source: TaskSource
  title: string
  /** All sub-task ids when the task was decomposed (empty for a whole task). */
  subtaskIds: string[]
  /** Sub-tasks already built, verified, and merged — skipped on resume. */
  completedSubtaskIds: string[]
  /** Last known-good commit SHA to continue from, or null. */
  lastGoodCommit: string | null
  turnsUsed: number
  /** ISO timestamp of the last save; drives staleness in findResumableCheckpoint. */
  updatedAt: string
}

/** Everything but the server-stamped `updatedAt`. */
export type CheckpointInput = Omit<ResumeCheckpoint, 'updatedAt'>

// A checkpoint older than this is treated as stale: a day-old interrupted task is
// almost always obsolete (the surrounding code has moved on), so we start fresh
// rather than resume into a divergent tree.
const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000

let dirOverride: string | null = null

/** Test seam: relocate the resume dir (pass null to restore the default). */
export function setCheckpointDirForTests(dir: string | null): void {
  dirOverride = dir
}

function getCheckpointDir(): string {
  if (dirOverride) return dirOverride
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'autonomous-resume')
}

function fileFor(taskId: string): string {
  const safe = taskId.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'task'
  return join(getCheckpointDir(), `${safe}.json`)
}

function isValid(v: unknown): v is ResumeCheckpoint {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.taskId === 'string' &&
    typeof c.source === 'string' &&
    Array.isArray(c.subtaskIds) &&
    Array.isArray(c.completedSubtaskIds) &&
    typeof c.updatedAt === 'string'
  )
}

/**
 * Write (or overwrite) the resume record for a task. Called incrementally —
 * per sub-task completion / per checkpoint — and fire-and-forget. Never throws.
 */
export async function saveCheckpoint(state: CheckpointInput): Promise<void> {
  try {
    const dir = getCheckpointDir()
    await mkdir(dir, { recursive: true })
    const record: ResumeCheckpoint = { ...state, updatedAt: new Date().toISOString() }
    await writeFile(fileFor(state.taskId), JSON.stringify(record, null, 2), 'utf8')
  } catch (err) {
    console.warn('[checkpoints] could not save resume state:', err)
  }
}

/** Load a specific task's checkpoint, or null if absent/corrupt. */
export async function loadCheckpoint(taskId: string): Promise<ResumeCheckpoint | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(fileFor(taskId), 'utf8'))
    return isValid(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Delete a task's checkpoint (call on definitive success or failure). Never throws. */
export async function clearCheckpoint(taskId: string): Promise<void> {
  await unlink(fileFor(taskId)).catch(() => {})
}

/**
 * Find the most recent non-stale, genuinely-incomplete checkpoint for a source,
 * so the loop can resume that task before pulling new ones. Skips checkpoints
 * whose sub-tasks are all already complete (nothing left to resume) and those
 * past MAX_RESUME_AGE_MS. Returns null when nothing is resumable.
 */
export async function findResumableCheckpoint(
  source: TaskSource,
  now = new Date()
): Promise<ResumeCheckpoint | null> {
  try {
    const dir = getCheckpointDir()
    const candidates: ResumeCheckpoint[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))
        if (!isValid(parsed)) continue
        if (parsed.source !== source) continue
        if (now.getTime() - new Date(parsed.updatedAt).getTime() > MAX_RESUME_AGE_MS) continue
        // A decomposed task whose sub-tasks are all done has nothing left to resume.
        if (parsed.subtaskIds.length > 0 && parsed.completedSubtaskIds.length >= parsed.subtaskIds.length) {
          continue
        }
        candidates.push(parsed)
      } catch {
        // Corrupt/partial file — ignore it.
      }
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return candidates[0] ?? null
  } catch {
    // No resume dir yet — nothing to resume.
    return null
  }
}
