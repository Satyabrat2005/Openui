import { PostHog } from 'posthog-node'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setSetting } from '../database/repositories/settingsRepo'
import { ConsentStatus, getConsentStatus, drainPendingEvents } from './consent'
import { scrubText } from './sentry'

let client: PostHog | null = null
let deviceId = 'anonymous'

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? ''

/** PostHog's ingest host when nothing usable is configured. */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

/**
 * PostHog has TWO hostnames per region and they are easy to confuse: the app
 * you log into (`us.posthog.com/project/12345/...`) and the ingest endpoint the
 * SDK posts to (`us.i.posthog.com`). Configuring the former makes every flush
 * POST to `us.posthog.com/project/…/batch/`, which 403s — silently, because the
 * SDK swallows delivery errors. That is exactly what shipped in v7.2.0: the
 * `VITE_POSTHOG_HOST` secret holds a project URL, so the release reports no
 * usage data at all while looking healthy.
 *
 * Normalising here rather than only correcting the secret means a copy-pasted
 * project URL can never silently disable telemetry again — in any deployment,
 * not just this repo's CI.
 *
 * Deliberately conservative: an unrecognised host is passed through untouched so
 * a self-hosted PostHog keeps working. Only two things are corrected — a path on
 * the URL (ingest hosts have none) and the known app-hostname → ingest-hostname
 * pairs.
 */
export function normalizePostHogHost(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) return DEFAULT_POSTHOG_HOST

  let url: URL
  try {
    url = new URL(value)
  } catch {
    console.warn(`[telemetry] POSTHOG_HOST is not a valid URL ("${value}") — using ${DEFAULT_POSTHOG_HOST}.`)
    return DEFAULT_POSTHOG_HOST
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`[telemetry] POSTHOG_HOST has an unsupported protocol ("${value}") — using ${DEFAULT_POSTHOG_HOST}.`)
    return DEFAULT_POSTHOG_HOST
  }

  const APP_TO_INGEST: Record<string, string> = {
    'us.posthog.com': 'us.i.posthog.com',
    'eu.posthog.com': 'eu.i.posthog.com',
    'app.posthog.com': 'us.i.posthog.com' // legacy single-region hostname
  }
  const mapped = APP_TO_INGEST[url.hostname.toLowerCase()]
  const hadPath = url.pathname !== '/' && url.pathname !== ''
  if (mapped) url.hostname = mapped
  // An ingest host never carries a path; a project URL always does.
  url.pathname = '/'
  url.search = ''
  url.hash = ''

  const normalized = url.origin
  if (mapped || hadPath) {
    console.warn(
      `[telemetry] POSTHOG_HOST looked like a PostHog project URL ("${value}"); ` +
        `using the ingest host ${normalized} instead.`
    )
  }
  return normalized
}

const POSTHOG_HOST = normalizePostHogHost(process.env.POSTHOG_HOST)

function loadOrCreateDeviceId(): string {
  const file = join(app.getPath('userData'), '.telemetry-id')
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    const id = randomUUID()
    try { writeFileSync(file, id, 'utf8') } catch { /* ignore write failures */ }
    return id
  }
}

/** Construct the PostHog client (idempotent). Caller guarantees consent. */
function startClient(): void {
  if (client) return
  deviceId = loadOrCreateDeviceId()
  client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    flushAt: 20,
    flushInterval: 10000
  })
}

/**
 * Initialise PostHog on startup. Consent is checked FIRST: the client is only
 * created when the user has explicitly GRANTED analytics. On a first launch
 * (UNKNOWN — awaiting the consent prompt) or after an opt-out (DENIED), PostHog
 * is never initialised. Silent no-op when POSTHOG_API_KEY is unset.
 *
 * Must be called after app.whenReady() so app.getPath() and the settings DB are
 * available.
 */
export async function initTelemetry(): Promise<void> {
  if (!POSTHOG_API_KEY) return
  let consent: ConsentStatus
  try {
    consent = await getConsentStatus()
  } catch {
    return
  }
  if (consent !== ConsentStatus.GRANTED) return
  startClient()
}

/**
 * Bring PostHog online immediately after the user grants consent from the UI.
 * initTelemetry() runs at startup — before the consent prompt is shown — so a
 * brand-new user has no client until they opt in here. Any events stashed
 * locally while telemetry was disabled (e.g. an opt-out recorded during an
 * earlier "Skip") are batch-sent on the way up.
 */
export function enableTelemetryAfterConsent(): void {
  if (!POSTHOG_API_KEY) return
  startClient()
  if (!client) return
  for (const event of drainPendingEvents()) {
    trackEvent(event)
  }
}

/** Attach a known user identity after auth (replaces the anonymous device ID). */
export function identifyUser(userId: string, traits?: Record<string, string | number | boolean>): void {
  if (!client) return
  deviceId = userId
  client.identify({ distinctId: userId, properties: traits })
}

/** Alias for identifyUser — kept for call-site compatibility. */
export const setTelemetryUser = identifyUser

/**
 * Scrub every string-valued property through the same PII filter Sentry uses
 * (usernames-in-paths, secrets, emails) at the single egress choke point,
 * BEFORE anything leaves the machine. Crash events are the reason: app_crash
 * carries a stack `frame` and renderer_error carries a `source` filename, both
 * of which embed the user's home-directory path (and OS username) in a packaged
 * build — and the consent prompt promises we never collect file paths. Numeric
 * / boolean values (counts, flags, latencies) pass through untouched.
 */
export function scrubProperties(
  properties?: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  if (!properties) return {}
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(properties)) {
    out[key] = typeof value === 'string' ? scrubText(value) : value
  }
  return out
}

/**
 * Capture a named event with optional primitive properties.
 * No-op when telemetry is disabled (client is null) — zero overhead.
 */
export function trackEvent(
  event: string,
  properties?: Record<string, string | number | boolean>
): void {
  if (!client) return
  client.capture({ distinctId: deviceId, event, properties: scrubProperties(properties) })
}

/** Reset identity back to anonymous device ID (e.g. on logout). */
export function resetTelemetryIdentity(): void {
  deviceId = loadOrCreateDeviceId()
}

/**
 * Opt the user in or out of analytics. Persists the choice to the settings
 * database and immediately shuts down the client on opt-out.
 */
export function setTelemetryOptOut(optOut: boolean): void {
  try { setSetting('telemetry_opt_out', optOut) } catch { /* ignore */ }
  if (optOut && client) {
    void client.shutdown()
    client = null
  }
}

/** Returns true when the PostHog client is active. */
export function isTelemetryActive(): boolean {
  return client !== null
}

/** Flush pending events and tear down the client on app quit. */
export function shutdownTelemetry(): void {
  void client?.shutdown()
  client = null
}
