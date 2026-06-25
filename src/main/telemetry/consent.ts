import { getSetting, setSetting } from '../database/repositories/settingsRepo'

/**
 * Privacy consent state for anonymous usage analytics (PostHog).
 *
 * - UNKNOWN — first launch; the user has not been shown the consent prompt yet.
 *             PostHog is NOT initialised in this state.
 * - GRANTED — the user opted in; PostHog runs.
 * - DENIED  — the user opted out (or pressed "Skip"); PostHog stays off. This is
 *             a permanent "no" — the prompt never reappears — but is reversible
 *             from Settings.
 */
export enum ConsentStatus {
  UNKNOWN = 'unknown',
  GRANTED = 'granted',
  DENIED = 'denied'
}

const CONSENT_KEY = 'telemetry_consent'
const OPT_OUT_KEY = 'telemetry_opt_out'
const PENDING_EVENTS_KEY = 'telemetry_pending_events'

/**
 * Read the persisted consent status. Defaults to UNKNOWN when the value is
 * unset (first launch) or the settings store is unreadable, so a brand-new or
 * degraded install never silently behaves as if consent were granted.
 *
 * `getSetting`/`setSetting` are synchronous, but these helpers are kept async so
 * the consent API has a stable, future-proof shape regardless of the backing
 * store (and so callers can `await` uniformly).
 */
export async function getConsentStatus(): Promise<ConsentStatus> {
  let raw: unknown
  try {
    raw = getSetting(CONSENT_KEY)
  } catch {
    return ConsentStatus.UNKNOWN
  }
  if (raw === ConsentStatus.GRANTED) return ConsentStatus.GRANTED
  if (raw === ConsentStatus.DENIED) return ConsentStatus.DENIED
  return ConsentStatus.UNKNOWN
}

/** Record an explicit opt-in. Also clears the low-level opt-out flag. */
export async function grantConsent(): Promise<void> {
  setSetting(CONSENT_KEY, ConsentStatus.GRANTED)
  setSetting(OPT_OUT_KEY, false)
}

/** Record an explicit opt-out (covers both first-launch "Skip" and toggle-off). */
export async function denyConsent(): Promise<void> {
  setSetting(CONSENT_KEY, ConsentStatus.DENIED)
  setSetting(OPT_OUT_KEY, true)
}

/** True only on the very first launch, before the user has made a choice. */
export async function shouldShowConsentPrompt(): Promise<boolean> {
  return (await getConsentStatus()) === ConsentStatus.UNKNOWN
}

/**
 * Stash an event name locally while telemetry is disabled. The opt-out event in
 * particular cannot be delivered to PostHog once the client is shut down (or
 * when it was never started after a "Skip"), so it is persisted here and
 * batch-sent if the user ever opts back in. Best-effort: never throws.
 */
export function recordPendingEvent(event: string): void {
  try {
    const existing = getSetting(PENDING_EVENTS_KEY)
    const list = Array.isArray(existing) ? (existing as string[]) : []
    list.push(event)
    setSetting(PENDING_EVENTS_KEY, list)
  } catch {
    // Telemetry persistence is best-effort and must never disrupt the caller.
  }
}

/** Return and clear any locally-stashed event names. */
export function drainPendingEvents(): string[] {
  let list: string[] = []
  try {
    const existing = getSetting(PENDING_EVENTS_KEY)
    if (Array.isArray(existing)) list = existing as string[]
    setSetting(PENDING_EVENTS_KEY, [])
  } catch {
    return []
  }
  return list
}
