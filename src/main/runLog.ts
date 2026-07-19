/**
 * runLog.ts — structured, per-run JSONL logging for agent task runs (Task 5).
 *
 * Console output tells a developer what happened moments ago; it tells an
 * operator nothing about last Tuesday's failed autonomous run. This module
 * gives every unit of agent work (an interactive chat turn, an autonomous
 * coding task, a browser session, a fine-tune job) a run id and appends one
 * JSON line per event to a daily file under userData/logs/tasks/.
 *
 * Design constraints:
 *   • Zero new dependencies — plain fs appends of JSON lines.
 *   • Never throws into the caller: a logging failure must not break a task
 *     run, so all sink errors are swallowed (after one console.warn).
 *   • Cheap: events are serialised once and appended fire-and-forget.
 *   • Bounded: daily files, oldest pruned after RETENTION_DAYS.
 *
 * Line shape (one JSON object per line):
 *   { ts, runId, kind, type, ...payload }
 * where type ∈ 'run_start' | 'tool_call' | 'event' | 'run_end'.
 */
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** What kind of work this run is — used to slice logs per subsystem. */
export type RunKind = 'chat' | 'autonomous-task' | 'browser' | 'finetune' | 'queue' | 'demo-smoke'

export interface ToolCallEntry {
  tool: string
  ok: boolean
  ms: number
  /** Compact, PII-light summary of the arguments (never full values). */
  argsSummary?: string
  error?: string
}

// Keep individual lines bounded so a runaway error string cannot bloat a file.
const MAX_FIELD_CHARS = 2_000
const RETENTION_DAYS = 14

/** Directory the daily JSONL files live in. Overridable for tests. */
let logDirOverride: string | null = null

/** Test seam: point the logger at a temp dir (pass null to restore default). */
export function setRunLogDirForTests(dir: string | null): void {
  logDirOverride = dir
}

function getLogDir(): string {
  if (logDirOverride) return logDirOverride
  // Lazy-required so pure helpers stay importable outside Electron (vitest).
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'logs', 'tasks')
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function clip(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return value.slice(0, MAX_FIELD_CHARS) + '…'
  }
  return value
}

/** Serialise one log entry to a single JSON line (exported for tests). */
export function buildLogLine(
  runId: string,
  kind: RunKind,
  type: string,
  payload: Record<string, unknown>
): string {
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), runId, kind, type }
  for (const [k, v] of Object.entries(payload)) entry[k] = clip(v)
  return JSON.stringify(entry) + '\n'
}

let warnedOnce = false

// Appends are fire-and-forget for callers but serialised among themselves, so
// lines land in emit order (concurrent appendFile calls are not ordered).
let writeChain: Promise<void> = Promise.resolve()

function sink(line: string): void {
  writeChain = writeChain.then(async () => {
    try {
      const dir = getLogDir()
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, `${dayStamp()}.jsonl`), line, 'utf8')
    } catch (err) {
      if (!warnedOnce) {
        warnedOnce = true
        console.warn('[runLog] disabled — could not write task log:', err)
      }
    }
  })
}

/**
 * A single run's logging handle. Create with startRun(); every method is
 * fire-and-forget and safe to call after end() (extra lines are still valid).
 */
export interface RunLog {
  readonly runId: string
  readonly kind: RunKind
  toolCall(entry: ToolCallEntry): void
  event(type: string, data?: Record<string, unknown>): void
  end(status: 'success' | 'failure' | 'cancelled', detail?: string): void
}

/** Begin a structured run; writes the run_start line immediately. */
export function startRun(kind: RunKind, meta: Record<string, unknown> = {}): RunLog {
  const runId = randomUUID()
  const t0 = Date.now()
  sink(buildLogLine(runId, kind, 'run_start', meta))
  return {
    runId,
    kind,
    toolCall(entry: ToolCallEntry): void {
      sink(
        buildLogLine(runId, kind, 'tool_call', {
          tool: entry.tool,
          ok: entry.ok,
          ms: entry.ms,
          ...(entry.argsSummary ? { args: entry.argsSummary } : {}),
          ...(entry.error ? { error: entry.error } : {})
        })
      )
    },
    event(type: string, data: Record<string, unknown> = {}): void {
      sink(buildLogLine(runId, kind, 'event', { event: type, ...data }))
    },
    end(status: 'success' | 'failure' | 'cancelled', detail?: string): void {
      sink(
        buildLogLine(runId, kind, 'run_end', {
          status,
          total_ms: Date.now() - t0,
          ...(detail ? { detail } : {})
        })
      )
    }
  }
}

/**
 * Delete daily log files older than RETENTION_DAYS. Called once at startup;
 * failures are ignored (a locked file is retried next launch).
 */
export async function pruneOldRunLogs(now = new Date()): Promise<void> {
  try {
    const dir = getLogDir()
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    for (const name of await readdir(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      if (m && m[1] < dayStamp(cutoff)) {
        await unlink(join(dir, name)).catch(() => {})
      }
    }
  } catch {
    // Log dir missing on first run — nothing to prune.
  }
}
