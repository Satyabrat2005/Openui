/**
 * Lightweight client-side telemetry.
 *
 * Renderer UI events are forwarded over IPC (`window.openui.track`) to the
 * main-process PostHog pipe (`src/main/telemetry/posthog.ts`), which is
 * consent-gated and a silent no-op when `POSTHOG_API_KEY` is unset. Every call
 * site passes a stable event name + a flat, primitive property bag. In dev we
 * also log to the console so events stay observable while building.
 */

export type TelemetryValue = string | number | boolean | null | undefined
export type TelemetryProperties = Record<string, TelemetryValue>

/** Drop `undefined` values so the IPC payload is a clean primitive bag. */
function normalize(
  properties?: TelemetryProperties
): Record<string, string | number | boolean | null> | undefined {
  if (!properties) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export function track(event: string, properties?: TelemetryProperties): void {
  if (import.meta.env.DEV) {
     
    console.debug('[telemetry]', event, properties ?? {})
  }
  // Forward to the main process. Guarded because the preload bridge is absent
  // in non-Electron contexts (e.g. unit tests) — telemetry must never throw
  // into a UI flow.
  try {
    window.openui?.track(event, normalize(properties))
  } catch {
    /* ignore — analytics is best-effort */
  }
}
