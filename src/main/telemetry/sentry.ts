/**
 * sentry.ts — optional external error tracking (Task 8).
 *
 * This is the deliberate follow-up crashReporter.ts pointed at: crash.log and
 * the PostHog crash counter keep working with zero configuration; Sentry only
 * comes online when BOTH of these hold:
 *
 *   1. A DSN is present (SENTRY_DSN baked at build time or set in the env).
 *      No DSN → every function here is a silent no-op.
 *   2. The user granted the SAME privacy consent that gates PostHog
 *      (telemetry_consent = granted). One consent prompt, one Settings toggle,
 *      covers both pipes; opting out stops Sentry too.
 *
 * Everything sent is scrubbed first (beforeSend/beforeBreadcrumb): no user
 * object, no request data, usernames stripped from file paths, and anything
 * that looks like a token/secret/email redacted. We ship the shape of the
 * failure, not the user's data.
 *
 * The SDK is lazy-required inside init so importing this module never pulls in
 * Electron or the settings DB — unit tests exercise the scrubbers directly.
 */

// ── PII scrubbing (pure, exported for tests) ────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Anthropic-style keys
  /\bfigd_[A-Za-z0-9_-]{16,}\b/g, // Figma tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi
]

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// C:\Users\ashu\..., /Users/ashu/..., /home/ashu/... → username redacted.
const WIN_USER_PATH_RE = /([A-Za-z]:[\\/]Users[\\/])([^\\/\s"']+)/gi
const NIX_USER_PATH_RE = /(\/(?:Users|home)\/)([^/\s"']+)/g

/** Redact secrets, emails and usernames-in-paths from arbitrary text. */
export function scrubText(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  out = out.replace(EMAIL_RE, '[email]')
  out = out.replace(WIN_USER_PATH_RE, '$1[user]')
  out = out.replace(NIX_USER_PATH_RE, '$1[user]')
  return out
}

// Minimal structural view of a Sentry event — enough to scrub without
// depending on the SDK's types at module scope.
interface SentryEventLike {
  message?: string
  user?: unknown
  request?: unknown
  server_name?: string
  contexts?: Record<string, unknown>
  breadcrumbs?: Array<{ message?: string; data?: unknown }>
  exception?: {
    values?: Array<{
      value?: string
      stacktrace?: { frames?: Array<{ filename?: string; abs_path?: string; module?: string }> }
    }>
  }
  extra?: Record<string, unknown>
}

/**
 * beforeSend hook: drop identity fields outright and scrub every free-text
 * field. Returns the same event object, mutated.
 */
export function scrubEvent<T extends SentryEventLike>(event: T): T {
  delete event.user
  delete event.request
  delete event.server_name
  delete event.extra // arbitrary key-values are the easiest PII leak — drop them

  if (event.message) event.message = scrubText(event.message)

  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value)
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = scrubText(frame.filename)
      if (frame.abs_path) frame.abs_path = scrubText(frame.abs_path)
      if (frame.module) frame.module = scrubText(frame.module)
    }
  }

  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.message) crumb.message = scrubText(crumb.message)
      delete crumb.data // breadcrumb payloads (URLs, args) are not worth the risk
    }
  }
  return event
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

type SentryMain = typeof import('@sentry/electron/main')

let sdk: SentryMain | null = null
let active = false

function getDsn(): string | null {
  const dsn = process.env.SENTRY_DSN
  return typeof dsn === 'string' && dsn.trim() ? dsn.trim() : null
}

async function hasConsent(): Promise<boolean> {
  try {
    // Lazy so importing this module never touches the settings DB (tests).
    const consent = require('./consent') as typeof import('./consent')
    return (await consent.getConsentStatus()) === consent.ConsentStatus.GRANTED
  } catch {
    return false // unreadable consent state must never default to "send data"
  }
}

function startSdk(dsn: string): void {
  if (active) return
  try {
    sdk = require('@sentry/electron/main') as SentryMain
    const { app } = require('electron') as typeof import('electron')
    sdk.init({
      dsn,
      release: `openui@${app.getVersion()}`,
      environment: app.isPackaged ? 'production' : 'development',
      sendDefaultPii: false,
      // Errors and native crashes only — no performance tracing, no replays.
      tracesSampleRate: 0,
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (crumb) => {
        if (crumb.message) crumb.message = scrubText(crumb.message)
        delete crumb.data
        return crumb
      }
    })
    active = true
    console.log('[sentry] error tracking active (consented, DSN configured)')
  } catch (err) {
    sdk = null
    console.error('[sentry] init failed — continuing without error tracking:', err)
  }
}

/**
 * Start Sentry at app startup iff a DSN is configured AND consent was already
 * granted on a previous run. First-launch users (consent UNKNOWN) get nothing
 * until they accept the existing privacy prompt.
 */
export async function initSentry(): Promise<void> {
  const dsn = getDsn()
  if (!dsn) {
    console.log('[sentry] no SENTRY_DSN — external error tracking disabled')
    return
  }
  if (!(await hasConsent())) return
  startSdk(dsn)
}

/** Bring Sentry online right after the user grants the privacy consent. */
export function enableSentryAfterConsent(): void {
  const dsn = getDsn()
  if (dsn) startSdk(dsn)
}

/** Honour the Settings toggle: opting out of telemetry stops Sentry too. */
export function setSentryOptOut(optOut: boolean): void {
  if (optOut) {
    if (active && sdk) {
      void sdk.close(2000).catch(() => {})
      active = false
      console.log('[sentry] stopped (user opted out)')
    }
  } else {
    enableSentryAfterConsent()
  }
}

export function isSentryActive(): boolean {
  return active
}

/**
 * Forward one error from crashReporter.ts. No-op unless Sentry is active, so
 * the crash pipeline works identically with or without a DSN/consent.
 */
export function forwardErrorToSentry(error: Error, kind: string): void {
  if (!active || !sdk) return
  try {
    sdk.captureException(error, { tags: { kind } })
  } catch {
    // Error reporting must never itself throw into the crash handler.
  }
}
