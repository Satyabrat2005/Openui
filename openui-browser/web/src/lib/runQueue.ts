/**
 * Pure derivations for the Run Console's queue model, status tokens, inspector
 * auto-collapse and inline-approval reconciliation. Kept free of React so the
 * non-trivial logic is unit-testable in the node test environment (see
 * runQueue.test.ts) and shared by RunConsole + TaskActivityContext without
 * drift.
 */
// NOTE: the ONLY change from the desktop copy is this import path — desktop
// imports from '../env'; the web app re-exports the identical shapes from
// '../types'. Everything below is the verified original, unchanged.
import type { TaskCard, RunQueue } from '../types'

type QueueInput = Pick<TaskCard, 'queue' | 'status'>

/**
 * Which sidebar queue a run belongs to. Prefers the explicit `queue` field (set
 * imperatively from events + approval state); falls back to status for older
 * cards that predate the field.
 */
export function queueOf(card: QueueInput): RunQueue {
  if (card.queue) return card.queue
  return card.status === 'in_progress' ? 'active' : 'done'
}

export interface QueueCounts {
  /** Running normally (in progress, not paused on an approval). */
  running: number
  /** Paused on an approval the user owes. */
  waiting: number
  /** Completed (done or failed). */
  finished: number
}

/** Live counters for the title bar + sidebar. */
export function deriveCounts(tasks: readonly QueueInput[]): QueueCounts {
  let running = 0
  let waiting = 0
  let finished = 0
  for (const t of tasks) {
    if (queueOf(t) === 'waiting') waiting++
    else if (t.status === 'in_progress') running++
    else finished++
  }
  return { running, waiting, finished }
}

export type StatusCls = 'running' | 'waiting' | 'finished' | 'failed'
export interface StatusTokenInfo {
  label: string
  cls: StatusCls
}

/** The RUNNING / NEEDS YOU / FINISHED / FAILED pill for a run row. */
export function statusToken(card: QueueInput): StatusTokenInfo {
  if (queueOf(card) === 'waiting') return { label: 'NEEDS YOU', cls: 'waiting' }
  if (card.status === 'in_progress') return { label: 'RUNNING', cls: 'running' }
  if (card.status === 'failed') return { label: 'FAILED', cls: 'failed' }
  return { label: 'FINISHED', cls: 'finished' }
}

/**
 * Inspector auto-collapse (README § Inspector): the responsive default hides the
 * inspector when the window is narrow (< 1180px), but a MANUAL open/close always
 * wins — so a manual open is never clobbered by the next resize event.
 */
export function resolveInspectorOpen(manual: boolean | null, narrow: boolean): boolean {
  return manual ?? !narrow
}

/**
 * Whether an active approval request should be shown INLINE on a run row (vs. the
 * fallback modal): only when there is a request AND the run it belongs to is
 * currently visible in the ledger. Otherwise the modal covers it so a request is
 * never silently missed.
 */
export function inlineApprovalVisible(
  hasRequest: boolean,
  targetId: string | null | undefined,
  filteredIds: readonly string[]
): boolean {
  return hasRequest && targetId != null && filteredIds.includes(targetId)
}

/**
 * Scope pills / CONNECTED "on" set — the apps the run may touch are exactly the
 * ones actually CONNECTED (one source of truth: the same connection store First
 * Run step 2 and the console CONNECTED group read). Never a hardcoded list.
 * Structural type so this stays decoupled from the ConnectAppsModal component.
 */
export function connectedScope<T extends { state: string }>(apps: readonly T[]): T[] {
  return apps.filter((a) => a.state === 'connected')
}
