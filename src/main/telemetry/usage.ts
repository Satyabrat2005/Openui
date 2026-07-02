/**
 * usage.ts — daily-active users + time-in-app tracking on top of PostHog.
 *
 * PostHog already computes DAU/WAU/MAU from any event that carries a stable
 * distinct id, so `app_started` (fired once per launch) is enough to answer
 * "how many users use OpenUI each day".
 *
 * What a single lifecycle event CANNOT answer is "how many hours are they
 * using it" — OpenUI keeps running in the system tray, so a raw launch→quit
 * span badly overstates real usage. To get a meaningful figure we emit a
 * periodic `app_heartbeat` ONLY while an OpenUI window is focused (i.e. the
 * user is actually interacting). Summing `heartbeats × interval` then gives an
 * approximate active time-in-app, which PostHog insights — or Supabase, once
 * it's launched — can chart per user per day.
 *
 * Everything here is fire-and-forget: `trackEvent` is a no-op when telemetry is
 * disabled or unconfigured, so this module is zero-overhead in that case.
 */
import { BrowserWindow } from 'electron'
import { Events } from './events'
import { trackEvent } from './posthog'

/** One heartbeat represents this many seconds of active (focused) use. */
const HEARTBEAT_INTERVAL_MS = 60_000

let sessionStartMs = 0
let timer: NodeJS.Timeout | null = null

/** True when at least one OpenUI window is focused — our proxy for "active". */
function isUserActive(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
}

/**
 * Begin the session clock and the active-use heartbeat. Idempotent — a second
 * call while already running is ignored. Safe to call before consent is granted;
 * the underlying trackEvent simply drops events until telemetry is active.
 */
export function startUsageTracking(): void {
  if (timer) return
  sessionStartMs = Date.now()
  timer = setInterval(() => {
    if (isUserActive()) {
      trackEvent(Events.APP_HEARTBEAT, { interval_seconds: HEARTBEAT_INTERVAL_MS / 1000 })
    }
  }, HEARTBEAT_INTERVAL_MS)
  // Don't let the heartbeat keep the process alive on its own — the tray does.
  timer.unref?.()
}

/** Whole seconds since the session started (0 if it never started). */
export function sessionDurationSeconds(): number {
  return sessionStartMs ? Math.round((Date.now() - sessionStartMs) / 1000) : 0
}

/** Stop the heartbeat. Call on app quit. */
export function stopUsageTracking(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
