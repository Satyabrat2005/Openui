/**
 * durableTasks.ts — persistence and resume for background tasks.
 *
 * taskQueue.ts already provides lanes, priorities, cooperative cancellation and
 * journalling, and it is explicit about what it does NOT do: "no persistence of
 * the closure itself … the queue only guarantees orderly execution within one
 * app session". That is the right call — a closure cannot be serialised — but it
 * leaves a real gap: a task interrupted by a crash, a quit, or a machine reboot
 * simply vanishes, with no record that it was ever meant to run.
 *
 * This module closes that gap without changing taskQueue's design. Instead of
 * persisting the work, it persists a DESCRIPTION of the work — a `kind` plus a
 * JSON payload — and requires each kind to be registered with a handler at
 * startup. Resume then means: find records that were left mid-flight, rebuild
 * their closures from the registry, and hand them back to taskQueue.
 *
 * The store is a plain JSON file so it stays inspectable and testable without
 * booting better-sqlite3, matching the reasoning in browser/consent.ts.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { enqueue, type Lane } from './taskQueue'

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TaskRecord {
  id: string
  /** Registered handler key — how the closure is rebuilt after a restart. */
  kind: string
  /** Serialisable arguments for the handler. */
  payload: unknown
  lane: Lane
  label: string
  status: TaskStatus
  /** How many times execution has been STARTED (not retries remaining). */
  attempts: number
  maxAttempts: number
  createdAt: number
  updatedAt: number
  /** Failure message from the last attempt, for the status UI. */
  error?: string
  /** True when the record was picked up by resumeInterrupted(). */
  resumed?: boolean
}

/**
 * Default attempt cap. A task that has already died twice is far more likely to
 * be deterministically broken than unlucky, and each resume runs unattended —
 * so the third start would just be a slower way to fail.
 */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Records kept in the store; oldest terminal records are pruned past this. */
const MAX_RECORDS = 500

export type TaskHandler = (payload: unknown, signal: AbortSignal) => Promise<unknown>

const handlers = new Map<string, TaskHandler>()

let storeDirOverride: string | null = null

/** Test seam: point the store at a temp dir (pass null to restore default). */
export function setTaskStoreDirForTests(dir: string | null): void {
  storeDirOverride = dir
  cache = null
}

function getStoreDir(): string {
  if (storeDirOverride) return storeDirOverride
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('userData')
}

function storeFile(): string {
  return join(getStoreDir(), 'background-tasks.json')
}

let cache: TaskRecord[] | null = null

function load(): TaskRecord[] {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(storeFile(), 'utf8'))
    cache = Array.isArray(parsed) ? parsed.filter(isTaskRecord) : []
  } catch {
    cache = [] // first run, or an unreadable/corrupt store → start clean
  }
  return cache
}

/**
 * Validate a record read off disk.
 *
 * The store is a plain file a user (or anything else on the machine) can edit,
 * so it is untrusted input: a malformed record must be dropped rather than
 * flowed into the scheduler.
 */
function isTaskRecord(v: unknown): v is TaskRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.lane === 'string' &&
    typeof r.label === 'string' &&
    typeof r.status === 'string' &&
    ['queued', 'running', 'done', 'failed', 'cancelled'].includes(r.status) &&
    typeof r.attempts === 'number' &&
    typeof r.maxAttempts === 'number'
  )
}

function persist(): void {
  const records = load()
  // Prune oldest TERMINAL records first — never drop something still pending,
  // which would silently lose queued work.
  if (records.length > MAX_RECORDS) {
    const terminal = (r: TaskRecord): boolean =>
      r.status === 'done' || r.status === 'failed' || r.status === 'cancelled'
    const keep = records.filter((r) => !terminal(r))
    const done = records.filter(terminal).sort((a, b) => b.updatedAt - a.updatedAt)
    cache = [...keep, ...done.slice(0, Math.max(0, MAX_RECORDS - keep.length))]
  }
  try {
    const file = storeFile()
    mkdirSync(dirname(file), { recursive: true })
    // Write-then-rename: a crash mid-write must not leave a truncated store
    // that would lose every pending task on the next start.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.warn('[durableTasks] could not persist the background task store:', err)
  }
}

function update(id: string, patch: Partial<TaskRecord>): void {
  const records = load()
  const record = records.find((r) => r.id === id)
  if (!record) return
  Object.assign(record, patch, { updatedAt: Date.now() })
  persist()
}

/**
 * Register the handler for a task kind.
 *
 * Must be called during startup, BEFORE resumeInterrupted(), or a persisted
 * task of that kind cannot be rebuilt and will be treated as unresumable.
 */
export function registerTaskHandler(kind: string, handler: TaskHandler): void {
  handlers.set(kind, handler)
}

/** Test seam: drop all registered handlers. */
export function resetTaskHandlersForTests(): void {
  handlers.clear()
}

export interface SubmitOptions {
  lane?: Lane
  label?: string
  maxAttempts?: number
  priority?: number
}

/**
 * Persist a task and enqueue it. Resolves/rejects with the handler's outcome,
 * exactly like taskQueue.enqueue — durability is added, not substituted.
 */
export function submitTask(kind: string, payload: unknown, opts: SubmitOptions = {}): Promise<unknown> {
  const record: TaskRecord = {
    id: randomUUID(),
    kind,
    payload,
    lane: opts.lane ?? 'coding',
    label: opts.label ?? kind,
    status: 'queued',
    attempts: 0,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  load().push(record)
  persist()
  return runRecord(record, opts.priority)
}

/** Enqueue an existing record onto its lane and track its status transitions. */
function runRecord(record: TaskRecord, priority?: number): Promise<unknown> {
  const handler = handlers.get(record.kind)
  if (!handler) {
    update(record.id, {
      status: 'failed',
      error: `No handler registered for task kind "${record.kind}".`
    })
    return Promise.reject(new Error(`No handler registered for task kind "${record.kind}".`))
  }

  return enqueue(
    record.lane,
    record.label,
    async (signal) => {
      update(record.id, { status: 'running', attempts: record.attempts + 1 })
      try {
        const result = await handler(record.payload, signal)
        // A handler that returns after cancellation must not be recorded as a
        // success — the work was cut short, and resume should not skip it.
        update(record.id, signal.aborted ? { status: 'cancelled' } : { status: 'done' })
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        update(record.id, {
          status: signal.aborted ? 'cancelled' : 'failed',
          error: message
        })
        throw err
      }
    },
    { priority }
  )
}

/**
 * Re-offer tasks that were interrupted rather than finished.
 *
 * A record left as `running` means the process died mid-task; a record left as
 * `queued` never started. Both are resumable. Records that have exhausted their
 * attempt budget are marked failed instead of being retried forever, and
 * records whose kind has no registered handler are left untouched so a later
 * build that registers the handler can still pick them up.
 *
 * Returns the records that were re-enqueued.
 */
export function resumeInterrupted(): TaskRecord[] {
  const resumable = load().filter((r) => r.status === 'running' || r.status === 'queued')
  const resumed: TaskRecord[] = []

  for (const record of resumable) {
    if (record.attempts >= record.maxAttempts) {
      update(record.id, {
        status: 'failed',
        error: `Gave up after ${record.attempts} attempt(s); the task did not complete.`
      })
      continue
    }
    if (!handlers.has(record.kind)) {
      // Leave the record pending: a future build that registers this kind can
      // still resume it. Dropping it would silently lose the work.
      console.warn(`[durableTasks] no handler for kind "${record.kind}"; leaving task ${record.id} pending`)
      continue
    }
    update(record.id, { status: 'queued', resumed: true })
    resumed.push(record)
    // Failures are recorded on the record itself; nothing is awaiting this
    // promise at startup, so swallow the rejection to avoid an unhandled one.
    void runRecord(record).catch(() => undefined)
  }

  return resumed
}

/**
 * Mark a task cancelled so it is not resumed on the next start.
 *
 * Cancelling work that is RUNNING is taskQueue's job (cancelLane aborts the
 * signal); this records the user's intent durably so a crash before the abort
 * lands does not resurrect the task.
 */
export function cancelTask(id: string): boolean {
  const record = load().find((r) => r.id === id)
  if (!record || record.status === 'done' || record.status === 'cancelled') return false
  update(id, { status: 'cancelled' })
  return true
}

/** Retry a failed or cancelled task, resetting its attempt budget. */
export function retryTask(id: string): Promise<unknown> {
  const record = load().find((r) => r.id === id)
  if (!record) return Promise.reject(new Error(`No task with id ${id}.`))
  if (record.status === 'running' || record.status === 'queued') {
    return Promise.reject(new Error(`Task ${id} is already ${record.status}.`))
  }
  update(id, { status: 'queued', attempts: 0, error: undefined })
  return runRecord(record)
}

/** All task records, newest first, optionally filtered by status. */
export function listTasks(status?: TaskStatus): TaskRecord[] {
  const records = [...load()].sort((a, b) => b.createdAt - a.createdAt)
  return status ? records.filter((r) => r.status === status) : records
}

/** One task record by id, or null. */
export function getTask(id: string): TaskRecord | null {
  return load().find((r) => r.id === id) ?? null
}

/** Test seam: drop all persisted records. */
export function resetTaskStoreForTests(): void {
  cache = []
  persist()
}
