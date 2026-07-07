/**
 * taskQueue.ts — a small in-process task queue with per-lane concurrency (Task 5).
 *
 * Before this module, background work was ad-hoc: the scheduler called the
 * autonomous loop directly and guarded re-entry with a boolean, and long
 * browser/vision sessions simply ran wherever they were triggered. As tasks get
 * longer (screenshot-reason-act loops, fine-tune jobs) that model breaks down:
 * two browser sessions would fight over the one shared Playwright page, and a
 * fine-tune job could start mid-coding-run.
 *
 * This queue serialises work into LANES with fixed concurrency caps:
 *   browser: 1   — one shared Playwright context / one visual loop at a time
 *   coding:  1   — the sandbox workspace is a single shared directory
 *   finetune: 1  — GPU + Ollama model registry are exclusive resources
 *   chat:    2   — interactive turns may overlap a background task
 *
 * Deliberately NOT a distributed job system: no redis, no persistence of the
 * closure itself. Durability lives in the task SOURCES (todo.json, GitHub
 * issues, the fine-tune manifest) which re-offer unfinished work after a
 * restart; the queue only guarantees orderly execution within one app session.
 * Every transition is journalled through runLog so a run can be reconstructed.
 */
import { startRun, type RunLog } from './runLog'

export type Lane = 'browser' | 'coding' | 'chat' | 'finetune'

const LANE_LIMITS: Record<Lane, number> = {
  browser: 1,
  coding: 1,
  chat: 2,
  finetune: 1
}

// Backstop so a bug cannot grow the queue without bound (each entry holds a
// closure and therefore memory). Rejections surface as normal task failures.
const MAX_QUEUED_PER_LANE = 100

export interface QueueJobOptions {
  /** Higher runs earlier within the lane (default 0). */
  priority?: number
}

interface QueuedJob {
  label: string
  priority: number
  seq: number
  run: (signal: AbortSignal) => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  controller: AbortController
}

interface LaneState {
  active: number
  queue: QueuedJob[]
  /** Controllers of currently RUNNING jobs, for cancelLane. */
  runningControllers: Set<AbortController>
}

const lanes = new Map<Lane, LaneState>()
let seqCounter = 0
let journal: RunLog | null = null

function getJournal(): RunLog {
  if (!journal) journal = startRun('queue', { note: 'task queue journal (one per app session)' })
  return journal
}

function getLane(lane: Lane): LaneState {
  let state = lanes.get(lane)
  if (!state) {
    state = { active: 0, queue: [], runningControllers: new Set() }
    lanes.set(lane, state)
  }
  return state
}

function pump(lane: Lane): void {
  const state = getLane(lane)
  while (state.active < LANE_LIMITS[lane] && state.queue.length > 0) {
    // Highest priority first; FIFO within the same priority.
    state.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
    const job = state.queue.shift() as QueuedJob
    state.active++
    state.runningControllers.add(job.controller)
    getJournal().event('job_start', { lane, label: job.label })
    const t0 = Date.now()
    job
      .run(job.controller.signal)
      .then(
        (value) => {
          getJournal().event('job_done', { lane, label: job.label, ms: Date.now() - t0 })
          job.resolve(value)
        },
        (err) => {
          getJournal().event('job_failed', {
            lane,
            label: job.label,
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err)
          })
          job.reject(err)
        }
      )
      .finally(() => {
        state.active--
        state.runningControllers.delete(job.controller)
        pump(lane)
      })
  }
}

/**
 * Enqueue a job on a lane. Resolves/rejects with the job's own outcome. The
 * job receives an AbortSignal — long loops should check `signal.aborted` at
 * their iteration checkpoints (same cooperative model as requestAutonomousStop).
 */
export function enqueue<T>(
  lane: Lane,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
  opts: QueueJobOptions = {}
): Promise<T> {
  const state = getLane(lane)
  if (state.queue.length >= MAX_QUEUED_PER_LANE) {
    return Promise.reject(
      new Error(`Task queue lane "${lane}" is full (${MAX_QUEUED_PER_LANE} waiting jobs).`)
    )
  }
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      label,
      priority: opts.priority ?? 0,
      seq: ++seqCounter,
      run: run as (signal: AbortSignal) => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      controller: new AbortController()
    })
    getJournal().event('job_enqueued', { lane, label, waiting: state.queue.length })
    pump(lane)
  })
}

/**
 * Cooperatively cancel a lane: abort the signals of running jobs and reject
 * everything still waiting. Running jobs finish at their next checkpoint.
 */
export function cancelLane(lane: Lane, reason = 'cancelled'): void {
  const state = getLane(lane)
  for (const controller of state.runningControllers) controller.abort()
  const waiting = state.queue.splice(0, state.queue.length)
  for (const job of waiting) job.reject(new Error(`Task "${job.label}" ${reason} before it started.`))
  if (waiting.length || state.runningControllers.size) {
    getJournal().event('lane_cancelled', { lane, dropped: waiting.length })
  }
}

/** Snapshot of queue depth per lane (for status UI / diagnostics). */
export function getQueueStats(): Record<Lane, { active: number; waiting: number }> {
  const out = {} as Record<Lane, { active: number; waiting: number }>
  for (const lane of Object.keys(LANE_LIMITS) as Lane[]) {
    const state = getLane(lane)
    out[lane] = { active: state.active, waiting: state.queue.length }
  }
  return out
}

/** Test seam: drop all lane state (queued jobs are rejected). */
export function resetQueueForTests(): void {
  for (const lane of Object.keys(LANE_LIMITS) as Lane[]) cancelLane(lane, 'reset')
  lanes.clear()
  journal = null
}
