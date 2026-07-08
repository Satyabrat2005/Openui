/**
 * crashReporter.ts — last-resort error capture for the main process.
 *
 * Installs global `uncaughtException` / `unhandledRejection` handlers so a stray
 * error surfaces somewhere actionable instead of silently killing a feature (or
 * the whole app). Every crash is:
 *   1. logged to the console, and
 *   2. appended to a rotating `crash.log` in userData, and
 *   3. forwarded to the PostHog pipe (consent-gated + no-op without a key), so
 *      we get aggregate crash rates in production without any extra service, and
 *   4. forwarded to Sentry (sentry.ts) — but ONLY when a SENTRY_DSN is
 *      configured AND the user granted the telemetry consent. Without either,
 *      that call is a silent no-op and this module remains fully functional
 *      with zero configuration.
 *
 * We deliberately do NOT `process.exit()` on an uncaught exception: an Electron
 * app is usually more useful left running (the error is often confined to one
 * IPC handler) than hard-killed. Truly fatal states still crash the runtime.
 */
import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { trackEvent } from './posthog'
import { forwardErrorToSentry } from './sentry'
import { Events } from './events'

/** Roll the log over at ~512 KB so it can never grow unbounded. */
const MAX_LOG_BYTES = 512 * 1024

function crashLogPath(): string {
  const dir = join(app.getPath('userData'), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* directory may already exist */
  }
  return join(dir, 'crash.log')
}

function appendCrashLog(entry: string): void {
  try {
    const path = crashLogPath()
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {
      /* no existing log yet */
    }
    appendFileSync(path, entry, 'utf8')
  } catch {
    /* logging must never itself throw */
  }
}

function report(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err))
  const stamp = new Date().toISOString()
  const line = `[${stamp}] ${kind}: ${error.message}\n${error.stack ?? '(no stack)'}\n\n`

  // eslint-disable-next-line no-console
  console.error(`[openui] ${kind}:`, error)
  appendCrashLog(line)

  // Fire-and-forget; trackEvent is itself a no-op without consent/key. Keep the
  // payload small and free of any user content — just the shape of the failure.
  trackEvent(Events.APP_CRASH, {
    kind,
    message: error.message.slice(0, 300),
    // First stack frame is enough to group crashes without leaking much.
    frame: (error.stack ?? '').split('\n')[1]?.trim().slice(0, 200) ?? 'unknown'
  })

  // Full stack to Sentry when (and only when) DSN + consent allow it; the
  // event is PII-scrubbed in sentry.ts before leaving the machine.
  forwardErrorToSentry(error, kind)
}

let installed = false

/**
 * Install the global handlers. Idempotent and safe to call before
 * `app.whenReady()` so early-startup crashes are captured too.
 */
export function installCrashReporter(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (err) => report('uncaughtException', err))
  process.on('unhandledRejection', (reason) => report('unhandledRejection', reason))
}
