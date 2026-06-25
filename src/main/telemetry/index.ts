import { EVENTS, type EventName } from './events'
import { trackEvent as posthogTrackEvent } from './posthog'

export { EVENTS }
export type { EventName }

/**
 * Record a telemetry event. Delegates to PostHog when initialised; silently
 * no-ops otherwise. Never throws — fire-and-forget.
 */
export function trackEvent(event: EventName, properties: Record<string, unknown> = {}): void {
  try {
    posthogTrackEvent(event, properties)
  } catch {
    // Swallow — telemetry must never disrupt the calling flow.
  }
}
