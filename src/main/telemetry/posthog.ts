import PostHog from 'posthog-js-lite'
import { app } from 'electron'
import { getSetting, setSetting } from '../database/repositories/settingsRepo'

let posthog: PostHog | null = null

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? ''
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com'

export async function initTelemetry(): Promise<void> {
  if (!POSTHOG_API_KEY) return

  const telemetryOptOut = getSetting('telemetry_opt_out')
  if (telemetryOptOut === true) {
    console.log('[Telemetry] User has opted out. Not initializing PostHog.')
    return
  }

  posthog = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST })

  await posthog.register({
    app_version: app.getVersion(),
    platform: process.platform,
    electron_version: process.versions.electron,
    node_version: process.versions.node,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    os_release: (process as any).getSystemVersion?.() ?? '',
  })

  console.log('[Telemetry] PostHog initialized.')
}

export function identifyUser(userId: string, properties?: Record<string, unknown>): void {
  if (!posthog) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  posthog.identify(userId, properties as any)
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!posthog) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  posthog.capture(event, properties as any)
}

export function resetTelemetryIdentity(): void {
  if (!posthog) return
  posthog.reset()
}

export function setTelemetryOptOut(optOut: boolean): void {
  if (optOut && posthog) {
    posthog.shutdown().catch(() => {})
    posthog = null
  }
  setSetting('telemetry_opt_out', optOut)
}

export function shutdownTelemetry(): void {
  if (!posthog) return
  posthog.shutdown().catch(() => {})
  posthog = null
}

export function isTelemetryActive(): boolean {
  return posthog !== null
}
