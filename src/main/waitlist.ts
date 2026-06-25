/**
 * waitlist.ts — desktop-app side of the Pro-tier waitlist.
 *
 * Lets a signed-in (or anonymous) user join the waitlist from within the app
 * (Settings → "Join the waitlist"). It posts the email to the SAME Supabase
 * Edge Function the website uses (`supabase/functions/waitlist`), which proxies
 * to Mailchimp server-side — the Mailchimp API key is never in the app.
 *
 * The function URL is derived from `SUPABASE_URL` (already configured for auth),
 * so there is no new env var to set.
 */
import { ipcMain } from 'electron'
import { trackEvent } from './analytics'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type WaitlistResult =
  | { ok: true; alreadySubscribed?: boolean }
  | { ok: false; error: string }

/** Build the deployed `waitlist` Edge Function URL from SUPABASE_URL. */
function waitlistEndpoint(): string | null {
  const base = process.env.SUPABASE_URL
  if (!base) return null
  return `${base.replace(/\/$/, '')}/functions/v1/waitlist`
}

/**
 * POST an email to the waitlist Edge Function. Mirrors the website's response
 * contract: `{ success: true }`, `{ error: 'already_subscribed' }`, etc.
 */
export async function joinWaitlist(email: string): Promise<WaitlistResult> {
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, error: 'invalid_email' }
  }

  const endpoint = waitlistEndpoint()
  if (!endpoint) {
    console.error('[openui] Cannot join waitlist — SUPABASE_URL is not set.')
    return { ok: false, error: 'not_configured' }
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Supabase Edge Functions accept the anon key as the apikey when present.
        ...(process.env.SUPABASE_ANON_KEY
          ? { apikey: process.env.SUPABASE_ANON_KEY }
          : {})
      },
      body: JSON.stringify({ email: email.toLowerCase().trim() })
    })

    const data = await res.json().catch(() => ({}))

    if (data?.error === 'already_subscribed') {
      return { ok: true, alreadySubscribed: true }
    }
    if (!res.ok || data?.error) {
      return { ok: false, error: String(data?.error ?? `http_${res.status}`) }
    }
    return { ok: true }
  } catch (err) {
    console.error('[openui] joinWaitlist failed:', err)
    return { ok: false, error: 'network_error' }
  }
}

/** Register the `openui:join-waitlist` IPC handler. */
export function registerWaitlistIPC(): void {
  ipcMain.handle('openui:join-waitlist', async (_event, email: unknown) => {
    const result = await joinWaitlist(typeof email === 'string' ? email : '')
    if (result.ok && !result.alreadySubscribed) {
      trackEvent('waitlist_joined', { source: 'desktop_app' })
    }
    return result
  })
}
