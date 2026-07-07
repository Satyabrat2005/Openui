/**
 * snapshots.ts — rollback safety for autonomous code changes (Task 5).
 *
 * The autonomous coding loop edits real files in the sandbox workspace. When a
 * task ends in failure (GIVE UP, turn-limit, crash), the workspace used to be
 * left in whatever half-broken state the model reached — and the next task
 * started on top of that wreckage. This module makes every task transactional:
 *
 *   beginTaskSnapshot(taskId)          — open a snapshot for the task
 *   snapshotBeforeWrite(relPath)       — called by write_file BEFORE overwriting:
 *                                        first write per file copies the original
 *                                        into the snapshot dir; a brand-new file
 *                                        is recorded as "created"
 *   restoreActiveSnapshot()            — put every touched file back (restore
 *                                        originals, delete created files)
 *   discardActiveSnapshot()            — task succeeded: keep the snapshot dir
 *                                        for audit, close the transaction
 *
 * Snapshots are plain file copies under userData/autonomous-snapshots/<taskId>/
 * (no git dependency — the workspace is frequently not a git repo). Old
 * snapshot dirs are pruned oldest-first past MAX_SNAPSHOT_DIRS.
 *
 * Single-writer model: the coding lane has concurrency 1 (taskQueue), so at
 * most one snapshot is active at a time; module state mirrors that.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getWorkspaceDir } from './sandbox'

const MAX_SNAPSHOT_DIRS = 20
const MANIFEST_NAME = 'snapshot-manifest.json'

interface SnapshotManifest {
  taskId: string
  startedAt: string
  /** Workspace-relative paths whose ORIGINAL content is saved in the dir. */
  overwritten: string[]
  /** Workspace-relative paths that did not exist before the task. */
  created: string[]
}

let active: SnapshotManifest | null = null
let snapshotRootOverride: string | null = null

/** Test seam: relocate the snapshot root (pass null to restore default). */
export function setSnapshotRootForTests(dir: string | null): void {
  snapshotRootOverride = dir
}

function getSnapshotRoot(): string {
  if (snapshotRootOverride) return snapshotRootOverride
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'autonomous-snapshots')
}

/** Sanitise a task id into a safe directory name. */
function dirNameFor(taskId: string): string {
  return taskId.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'task'
}

function activeDir(): string {
  if (!active) throw new Error('no active snapshot')
  return join(getSnapshotRoot(), dirNameFor(active.taskId))
}

async function persistManifest(): Promise<void> {
  if (!active) return
  const dir = activeDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, MANIFEST_NAME), JSON.stringify(active, null, 2), 'utf8')
}

/** Open a snapshot transaction for a task. Replaces any stale open snapshot. */
export async function beginTaskSnapshot(taskId: string): Promise<void> {
  active = { taskId, startedAt: new Date().toISOString(), overwritten: [], created: [] }
  const dir = activeDir()
  // A retried task id reuses its dir; clear leftovers so old copies can't mix in.
  await rm(dir, { recursive: true, force: true })
  await persistManifest()
}

/**
 * Record the pre-image of a workspace file about to be (over)written. Safe to
 * call when no snapshot is active (interactive write_file outside a task run) —
 * it is then a no-op. Never throws: snapshot failure must not block the write,
 * but it DOES disable restore for that task (better honest than half-safe).
 */
export async function snapshotBeforeWrite(relPath: string): Promise<void> {
  if (!active) return
  if (active.overwritten.includes(relPath) || active.created.includes(relPath)) return
  try {
    const wsFile = join(getWorkspaceDir(), relPath)
    let exists = true
    try {
      await stat(wsFile)
    } catch {
      exists = false
    }
    if (exists) {
      const dest = join(activeDir(), 'files', relPath)
      await mkdir(dirname(dest), { recursive: true })
      await cp(wsFile, dest)
      active.overwritten.push(relPath)
    } else {
      active.created.push(relPath)
    }
    await persistManifest()
  } catch (err) {
    console.warn(`[snapshots] could not snapshot ${relPath} — restore disabled for this file:`, err)
  }
}

/**
 * Roll the workspace back to the snapshot: restore all overwritten originals,
 * delete all files the task created. Returns a summary for the task log.
 * The snapshot transaction stays closed afterwards.
 */
export async function restoreActiveSnapshot(): Promise<string> {
  if (!active) return 'No snapshot to restore.'
  const manifest = active
  const dir = activeDir()
  active = null

  let restored = 0
  let deleted = 0
  for (const relPath of manifest.overwritten) {
    try {
      const src = join(dir, 'files', relPath)
      const dest = join(getWorkspaceDir(), relPath)
      await mkdir(dirname(dest), { recursive: true })
      await cp(src, dest)
      restored++
    } catch (err) {
      console.warn(`[snapshots] failed to restore ${relPath}:`, err)
    }
  }
  for (const relPath of manifest.created) {
    try {
      await rm(join(getWorkspaceDir(), relPath), { force: true })
      deleted++
    } catch (err) {
      console.warn(`[snapshots] failed to remove created file ${relPath}:`, err)
    }
  }
  return `Rolled back workspace: restored ${restored} file(s), removed ${deleted} created file(s).`
}

/** Close the transaction keeping the snapshot dir on disk for audit. */
export function discardActiveSnapshot(): void {
  active = null
}

/** True while a task snapshot transaction is open (exported for tests). */
export function hasActiveSnapshot(): boolean {
  return active !== null
}

/** Prune snapshot dirs oldest-first beyond MAX_SNAPSHOT_DIRS. Never throws. */
export async function pruneSnapshots(): Promise<void> {
  try {
    const root = getSnapshotRoot()
    const entries = await readdir(root, { withFileTypes: true })
    const dirs: { name: string; startedAt: string }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const raw = await readFile(join(root, entry.name, MANIFEST_NAME), 'utf8')
        const manifest = JSON.parse(raw) as SnapshotManifest
        dirs.push({ name: entry.name, startedAt: manifest.startedAt ?? '' })
      } catch {
        dirs.push({ name: entry.name, startedAt: '' })
      }
    }
    dirs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    while (dirs.length > MAX_SNAPSHOT_DIRS) {
      const oldest = dirs.shift() as { name: string }
      await rm(join(root, oldest.name), { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    // No snapshot root yet — nothing to prune.
  }
}
