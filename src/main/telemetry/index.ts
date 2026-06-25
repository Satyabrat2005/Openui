import { EVENTS, type EventName } from './events'

export { EVENTS }
export type { EventName }

/**
 * Record a telemetry event.
 *
 * OpenUI does not ship an analytics backend yet, so this currently just logs
 * the event locally. It is the single choke-point every feature funnels
 * through, so wiring in a real sink later (PostHog, a Supabase table, …) means
 * editing only this function. It must never throw — telemetry is
 * fire-and-forget and must not be able to crash a caller (e.g. the updater).
 */
export function trackEvent(event: EventName, properties: Record<string, unknown> = {}): void {
  try {
    console.log(`[Telemetry] ${event}`, properties)
  } catch {
    // Swallow — telemetry must never disrupt the calling flow.
  }
}
