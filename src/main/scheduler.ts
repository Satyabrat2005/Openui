/**
 * scheduler.ts — activity monitor that decides when OpenUI may work
 * autonomously (Phase 8).
 *
 * It polls Electron's powerMonitor.getSystemIdleTime() (a cross-platform,
 * dependency-free measure of seconds since the last mouse/keyboard input) and
 * also honours a manual "I'm busy" toggle from the UI. When Autonomous Coding
 * Mode is enabled AND the user is away (idle past the threshold, or explicitly
 * busy), it kicks off the autonomous coding loop. When the user returns to the
 * keyboard, it asks the loop to pause so it never fights the user for the
 * machine.
 *
 * All state lives here; the loop itself is in autonomous.ts. Direction of
 * dependency is one-way (scheduler → autonomous) to avoid an import cycle.
 */
import { app, ipcMain, powerMonitor, type BrowserWindow } from 'electron'
import {
  runAutonomousCoding,
  requestAutonomousStop,
  isAutonomousRunning,
  emitAutonomousStatus,
  type AutonomousStatus
} from './autonomous'
import type { TaskSource } from './tasks'
import { coerceTier } from './agent'
import type { Tier } from './tools'

// How often we sample idle time. 15 s is responsive enough for a 5-minute
// threshold without waking the CPU constantly.
const POLL_INTERVAL_MS = 15_000

// Seconds of inactivity before the user is considered "away". Overridable via
// OPENUI_IDLE_THRESHOLD (seconds) for testing / power users.
const DEFAULT_IDLE_THRESHOLD_SEC = 300

// Idle time at/under which we treat the user as actively present again. A small
// non-zero value debounces a single stray event from prematurely resuming.
const ACTIVE_IDLE_SEC = 5

function idleThresholdSec(): number {
  const raw = Number(process.env.OPENUI_IDLE_THRESHOLD)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_THRESHOLD_SEC
}

interface SchedulerState {
  /** Master switch for Autonomous Coding Mode. */
  enabled: boolean
  /** Manual "I'm busy" override — treat the user as away regardless of idle. */
  manualBusy: boolean
  /** Tier the autonomous loop runs under. */
  tier: Tier
  /** Where autonomous tasks come from. */
  source: TaskSource
}

const state: SchedulerState = {
  enabled: false,
  manualBusy: false,
  tier: 'free',
  source: process.env.OPENUI_TASK_SOURCE === 'github' ? 'github' : 'todo'
}

let timer: ReturnType<typeof setInterval> | null = null
let targetWin: BrowserWindow | null = null

/** Compute the status the UI should show right now (when not actively working). */
function currentStatus(): AutonomousStatus {
  if (!state.enabled) return { active: false, state: 'disabled' }
  if (isAutonomousRunning()) return { active: true, state: 'working' }
  const away = state.manualBusy || powerMonitor.getSystemIdleTime() >= idleThresholdSec()
  return {
    active: true,
    state: 'monitoring',
    detail: away ? 'You are away — starting soon…' : 'Watching for idle time…'
  }
}

function broadcastStatus(): void {
  if (targetWin) emitAutonomousStatus(targetWin, currentStatus())
}

/** One poll tick: decide whether to start or pause the autonomous loop. */
function tick(): void {
  if (!targetWin || !state.enabled) return

  const idle = powerMonitor.getSystemIdleTime()
  const away = state.manualBusy || idle >= idleThresholdSec()

  if (away && !isAutonomousRunning()) {
    // Fire and forget; runAutonomousCoding guards against re-entry itself.
    void runAutonomousCoding(targetWin, state.tier, state.source)
  } else if (!away && isAutonomousRunning() && idle <= ACTIVE_IDLE_SEC && !state.manualBusy) {
    // The user came back — yield the machine.
    requestAutonomousStop()
  }

  broadcastStatus()
}

function startTimer(): void {
  if (timer) return
  timer = setInterval(tick, POLL_INTERVAL_MS)
  // Don't let the poll timer keep the process alive on its own.
  if (typeof timer.unref === 'function') timer.unref()
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * Wire up the scheduler: register IPC handlers and (when enabled) begin polling.
 * Called once from index.ts after the window is created.
 */
export function startScheduler(win: BrowserWindow): void {
  targetWin = win

  // Enable/disable Autonomous Coding Mode. Optional tier + source ride along so
  // the UI can pick where work comes from and which model runs it.
  ipcMain.on('openui:autonomous:set-enabled', (_event, payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    state.enabled = p.enabled === true
    if (p.tier !== undefined) state.tier = coerceTier(p.tier)
    if (p.source === 'github' || p.source === 'todo') state.source = p.source

    if (state.enabled) {
      startTimer()
      tick() // evaluate immediately rather than waiting a full interval
    } else {
      stopTimer()
      requestAutonomousStop()
    }
    broadcastStatus()
  })

  // Manual "I'm busy" toggle from the UI.
  ipcMain.on('openui:autonomous:set-busy', (_event, busy: unknown) => {
    state.manualBusy = busy === true
    if (state.enabled) tick()
    else broadcastStatus()
  })

  // Let the renderer query the current status on mount.
  ipcMain.handle('openui:autonomous:get-status', () => currentStatus())

  // Pause cleanly on quit so a half-finished test run isn't orphaned.
  app.on('before-quit', () => {
    requestAutonomousStop()
    stopTimer()
  })
}
