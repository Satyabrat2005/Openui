/**
 * deeplink.ts — CROSS-PLATFORM `openui://` deep-link handling for OAuth.
 *
 * After Google sign-in, Supabase redirects the system browser to
 * `openui://auth-callback#access_token=…&refresh_token=…&expires_in=…&token_type=bearer`.
 * The OS then routes that URL back into this app. The three delivery paths are
 * all handled here:
 *
 *   • macOS  — a running app receives the `open-url` event.
 *   • Windows (running) — a second instance is launched with the URL in argv;
 *     `second-instance` forwards it to the primary instance.
 *   • Windows (cold start) — the very first process gets the URL in
 *     `process.argv`.
 *
 * No macOS-only APIs are used for the auth flow itself; the single-instance lock
 * is what makes the Windows "already running" case work.
 */
import { app, BrowserWindow } from 'electron'
import path from 'path'
import { getSupabaseClient } from './supabaseClient'
import { closeAuthWindow } from './authWindow'
import { database } from '../database'
import { setActiveUser, cacheUserTier, type UserProfile } from './sessionManager'
import { identifyUser } from '../telemetry/posthog'
import {
  emitToRenderer,
  getCurrentUserId,
  handlePaymentSuccess,
  syncSubscriptionStatus
} from '../stripe/subscriptionSync'

const PROTOCOL = 'openui'

/**
 * Register `openui://` as this app's protocol and claim the single-instance
 * lock. MUST be called before `app.whenReady()`:
 *   - the lock has to be requested before any window work so a second instance
 *     (e.g. the OS launching us to deliver a deep link) exits immediately and
 *     hands its argv to the primary instance via `second-instance`;
 *   - protocol registration on Windows in dev needs the Electron exec path and
 *     the script path, which are only correct this early.
 */
export function registerDeepLinkProtocol(): void {
  // Single-instance lock: if we are the second instance, quit now. The primary
  // instance will receive our argv (including any deep link) via second-instance.
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.quit()
    return
  }

  // setAsDefaultProtocolClient can fail on Linux / restricted Windows — warn,
  // never crash. The OAuth window's navigation fallback still works without it.
  try {
    let ok: boolean
    if (process.defaultApp && process.argv.length >= 2) {
      // Dev: running as `electron .` — register the electron binary + script so
      // Windows knows how to relaunch us for the protocol.
      ok = app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
    } else {
      ok = app.setAsDefaultProtocolClient(PROTOCOL)
    }
    if (!ok) {
      console.warn(`[openui] Could not register as default handler for ${PROTOCOL}:// (non-fatal).`)
    }
  } catch (err) {
    console.warn(`[openui] setAsDefaultProtocolClient threw (non-fatal):`, err)
  }
}

/**
 * Wire up the runtime delivery paths. Call once after the main window exists.
 * `mainWindow` is the window IPC results are sent to; if it has been recreated
 * we fall back to the first live window so a late deep link still lands.
 */
export function setupDeepLinkHandlers(mainWindow: BrowserWindow | null): void {
  const targetWindow = (): BrowserWindow | null => {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
    return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
  }

  // WINDOWS cold start: the deep link may be sitting in our own argv.
  if (process.platform === 'win32') {
    const url = findDeepLink(process.argv)
    if (url) void handleDeepLink(url, targetWindow())
  }

  // macOS: app already running, OS delivers the URL as an event.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    void handleDeepLink(url, targetWindow())
  })

  // WINDOWS already running: a second launch forwards its argv here. Also focus
  // the existing window so the user is brought back to the app.
  app.on('second-instance', (_event, argv) => {
    const win = targetWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    const url = findDeepLink(argv)
    if (url) void handleDeepLink(url, win)
  })
}

/** Find the first `openui://` argument in an argv array, if any. */
function findDeepLink(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
}

/** Route a Stripe payment/portal deep-link action to the subscription layer. */
function handleStripeRedirect(action: string): void {
  const userId = getCurrentUserId()
  if (action === 'payment-success') {
    if (userId) void handlePaymentSuccess(userId)
  } else if (action === 'payment-cancelled') {
    emitToRenderer('openui:payment-cancelled')
  } else if (action === 'portal-closed') {
    if (userId) void syncSubscriptionStatus(userId)
  }
}

/**
 * Parse a delivered deep link and route it: Stripe payment/portal redirects go to
 * the subscription layer; an auth callback completes the sign-in. Supabase
 * implicit-flow returns the tokens in the URL fragment.
 */
export async function handleDeepLink(url: string, mainWindow: BrowserWindow | null): Promise<void> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    console.warn('[openui] Ignored unparseable deep link:', url)
    return
  }

  // The action is the deep link's host for `openui://<action>` (non-special
  // scheme), with the pathname form accepted defensively.
  const action = parsedUrl.host || parsedUrl.pathname.replace(/\//g, '')

  // Stripe checkout success/cancel + billing-portal return: hand off to the
  // subscription layer, then surface the main window.
  if (action === 'payment-success' || action === 'payment-cancelled' || action === 'portal-closed') {
    handleStripeRedirect(action)
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    return
  }

  // For `openui://auth-callback`, the URL parser puts `auth-callback` in `host`.
  if (action !== 'auth-callback') return

  // Tokens arrive in the fragment (#…); some error responses use the query
  // string. Merge both so we read whichever the provider used.
  const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ''))
  const queryParams = parsedUrl.searchParams

  // Surface an explicit OAuth error (e.g. the user denied consent).
  const oauthError = hashParams.get('error_description') || queryParams.get('error_description') || hashParams.get('error') || queryParams.get('error')
  if (oauthError) {
    mainWindow?.webContents.send('openui:auth-error', { message: oauthError })
    closeAuthWindow()
    return
  }

  const accessToken = hashParams.get('access_token') ?? queryParams.get('access_token')
  const refreshToken = hashParams.get('refresh_token') ?? queryParams.get('refresh_token')
  const expiresIn = hashParams.get('expires_in') ?? queryParams.get('expires_in')
  const tokenType = hashParams.get('token_type') ?? queryParams.get('token_type')

  if (accessToken && refreshToken) {
    await completeAuth(accessToken, refreshToken, expiresIn, tokenType, mainWindow)
  } else {
    mainWindow?.webContents.send('openui:auth-error', { message: 'Missing tokens in auth callback' })
    closeAuthWindow()
  }
}

/**
 * Establish the Supabase session from the callback tokens, persist the user and
 * tokens locally, cache their subscription tier, and notify the renderer. Any
 * failure is reported to the renderer as `openui:auth-error`; the auth window is
 * always closed at the end.
 */
export async function completeAuth(
  accessToken: string,
  refreshToken: string,
  expiresIn: string | null,
  tokenType: string | null,
  mainWindow: BrowserWindow | null
): Promise<void> {
  try {
    const supabase = getSupabaseClient()

    // Adopt the session, then fetch the canonical user record (carries the
    // app_metadata custom claims we cache the tier from).
    await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
    const { data, error } = await supabase.auth.getUser(accessToken)
    if (error || !data?.user) {
      throw new Error(error?.message ?? 'Could not load the signed-in user.')
    }
    const user = data.user

    // Derive a display profile from Supabase's user + identity metadata.
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>
    const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>
    const tier = typeof appMeta.tier === 'string' ? appMeta.tier : 'free'

    const profile: UserProfile = {
      id: user.id,
      email: user.email ?? null,
      display_name:
        (typeof meta.full_name === 'string' && meta.full_name) ||
        (typeof meta.name === 'string' && meta.name) ||
        user.email ||
        null,
      avatar_url:
        (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
        (typeof meta.picture === 'string' && meta.picture) ||
        null,
      tier
    }

    // expires_in is seconds-from-now; store an absolute epoch-SECONDS expiry to
    // match the DB schema. Default to one hour if the provider omitted it.
    const expiresInSec = Number(expiresIn)
    const expiresAt =
      Math.floor(Date.now() / 1000) + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 3600)

    database.users.upsertUser({
      id: user.id,
      email: profile.email ?? undefined,
      displayName: profile.display_name ?? undefined,
      avatarUrl: profile.avatar_url ?? undefined,
      tier
    })
    database.users.updateAuthTokens(user.id, accessToken, refreshToken, expiresAt)
    cacheUserTier(user.id, tier)
    setActiveUser(user.id)

    mainWindow?.webContents.send('openui:auth-success', profile)
    identifyUser(profile.id, { email: profile.email ?? undefined, tier })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[openui] completeAuth failed:', message)
    mainWindow?.webContents.send('openui:auth-error', { message })
  } finally {
    // Whether we succeeded or failed, the OAuth window has done its job.
    closeAuthWindow()
  }
}
