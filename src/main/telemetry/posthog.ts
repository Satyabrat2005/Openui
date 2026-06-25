import { PostHog } from 'posthog-node'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setSetting } from '../database/repositories/settingsRepo'
import { ConsentStatus, getConsentStatus, drainPendingEvents } from './consent'

let client: PostHog | null = null
let deviceId = 'anonymous'

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? ''
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com'

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
 * Capture a named event with optional primitive properties.
 * No-op when telemetry is disabled (client is null) — zero overhead.
 */
export function trackEvent(
  event: string,
  properties?: Record<string, string | number | boolean>
): void {
  if (!client) return
  client.capture({ distinctId: deviceId, event, properties: properties ?? {} })
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
