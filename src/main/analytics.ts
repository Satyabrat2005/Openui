/**
 * analytics.ts — tiny, dependency-free PostHog event tracker for the main process.
 *
 * `trackEvent` posts to PostHog's HTTP capture endpoint when a project key is
 * configured (`POSTHOG_API_KEY`, optional `POSTHOG_HOST`). When it isn't, it is a
 * silent no-op — analytics is strictly optional and must never break a feature
 * or block the flow that called it. All sends are fire-and-forget.
 */

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? 'https://app.posthog.com'

/** A stable, anonymous per-install id so events from one machine group together. */
let distinctId: string | null = null
function getDistinctId(): string {
  if (distinctId) return distinctId
  // crypto.randomUUID is available in modern Node/Electron.
  distinctId = `desktop-${crypto.randomUUID()}`
  return distinctId
}

/** True when a PostHog project key is configured. */
export function isAnalyticsEnabled(): boolean {
  return Boolean(POSTHOG_API_KEY)
}

/**
 * Fire-and-forget capture of a product event. Never throws; failures are logged
 * at most and otherwise swallowed.
 */
export function trackEvent(event: string, properties: Record<string, unknown> = {}): void {
  if (!POSTHOG_API_KEY) return

  fetch(`${POSTHOG_HOST.replace(/\/$/, '')}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_API_KEY,
      event,
      distinct_id: getDistinctId(),
      properties: { ...properties, $lib: 'openui-desktop' }
    })
  }).catch((err) => {
    console.error('[openui] analytics capture failed:', err)
  })
}
