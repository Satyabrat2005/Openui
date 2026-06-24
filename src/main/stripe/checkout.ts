/**
 * checkout.ts — opens Stripe Checkout / the Stripe billing portal inside an
 * isolated Electron window, and registers the Stripe-related IPC handlers.
 *
 * SECURITY:
 *   • No Stripe secret key here. We ask a Supabase Edge Function to create the
 *     Checkout/Portal session (it holds the secret key) and only open the hosted
 *     URL it returns.
 *   • The payment window runs on its OWN session partition (so the app's locked-
 *     down default-session CSP does not apply and Stripe can load), with no
 *     preload, no node integration, sandboxed — the hosted page can never reach
 *     OpenUI's IPC bridge.
 *   • The app-wide navigation lock in `index.ts` would normally block this window
 *     from leaving the app origin. We register the window's webContents in
 *     `paymentFlowContents` so (and only so) that one window may navigate to
 *     Stripe/bank domains. Its own `will-navigate` monitor below still intercepts
 *     the success/cancel/return URLs.
 */
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { getSupabaseClient, isSupabaseConfigured } from '../auth/supabaseClient'
import { database } from '../database'
import { TIERS } from './pricing'
import {
  emitToRenderer,
  getCurrentUserId,
  handlePaymentSuccess,
  setMainWindow,
  startSubscriptionSyncLoop,
  syncSubscriptionStatus
} from './subscriptionSync'

// ── payment-window registry (consulted by the global navigation lock) ─────────

const paymentFlowContents = new WeakSet<WebContents>()

/** True if `contents` belongs to a Stripe checkout/portal window. */
export function isPaymentFlowWebContents(contents: WebContents): boolean {
  return paymentFlowContents.has(contents)
}

// ── terminal URLs that close the flow ─────────────────────────────────────────
// We accept both the custom-scheme deep links the Edge Functions are configured
// with and an https fallback, so either redirect style closes the window.

const SUCCESS_PREFIXES = ['openui://payment-success', 'https://openui.app/success']
const CANCEL_PREFIXES = ['openui://payment-cancelled', 'https://openui.app/cancel']
const PORTAL_RETURN_PREFIXES = ['openui://portal-closed', 'https://openui.app/portal-closed']

function matchesAny(url: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => url.startsWith(prefix))
}

// ── window creation ───────────────────────────────────────────────────────────

/**
 * Build a tiny script that injects a floating close button. Used only on macOS,
 * where the window is frameless (no OS chrome). Clicking it navigates to the
 * flow's "closed" deep link, which the monitor below turns into a clean close.
 */
function closeButtonScript(targetUrl: string): string {
  return `(() => {
    if (document.getElementById('openui-close-btn')) return;
    const b = document.createElement('button');
    b.id = 'openui-close-btn';
    b.textContent = '\\u2715';
    b.setAttribute('aria-label', 'Close');
    Object.assign(b.style, {
      position: 'fixed', top: '12px', right: '14px', zIndex: '2147483647',
      width: '28px', height: '28px', borderRadius: '50%', border: 'none',
      cursor: 'pointer', background: 'rgba(0,0,0,0.55)', color: '#fff',
      fontSize: '15px', lineHeight: '28px', padding: '0', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
    });
    b.addEventListener('click', () => { window.location.href = ${JSON.stringify(targetUrl)}; });
    document.body.appendChild(b);
  })();`
}

/**
 * Create the isolated 800×900 centered payment window with platform-appropriate
 * chrome: frameless + custom close button on macOS, the standard OS frame on
 * Windows/Linux.
 */
function createFlowWindow(title: string, closeTargetUrl: string): BrowserWindow {
  const isMac = process.platform === 'darwin'

  const win = new BrowserWindow({
    width: 800,
    height: 900,
    center: true,
    show: false,
    title,
    frame: !isMac, // macOS: frameless (we draw our own close button)
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'stripe-checkout', // isolates cookies + escapes the app CSP
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  paymentFlowContents.add(win.webContents)

  if (isMac) {
    // Re-inject on every page load (Stripe navigates between its own pages).
    win.webContents.on('dom-ready', () => {
      win.webContents.executeJavaScript(closeButtonScript(closeTargetUrl)).catch(() => {
        /* page may block injection late in teardown — harmless */
      })
    })
  }

  return win
}

/**
 * Attach the URL monitor that closes the window when the flow reaches a terminal
 * URL, and triggers the right follow-up (sync on success/return, cancel IPC on
 * cancel). `kind` selects checkout vs portal semantics.
 */
function attachFlowMonitor(win: BrowserWindow, userId: string, kind: 'checkout' | 'portal'): void {
  let settled = false

  const finish = (after: () => void): void => {
    if (settled) return
    settled = true
    after()
    if (!win.isDestroyed()) win.close()
  }

  const onNavigate = (event: Electron.Event, url: string): void => {
    if (matchesAny(url, SUCCESS_PREFIXES)) {
      event.preventDefault()
      finish(() => void handlePaymentSuccess(userId))
    } else if (matchesAny(url, CANCEL_PREFIXES)) {
      event.preventDefault()
      finish(() => emitToRenderer('openui:payment-cancelled'))
    } else if (matchesAny(url, PORTAL_RETURN_PREFIXES)) {
      event.preventDefault()
      // Portal closed: the subscription may have changed → silent resync.
      finish(() => void syncSubscriptionStatus(userId))
    }
  }

  win.webContents.on('will-navigate', onNavigate)
  win.webContents.on('will-redirect', onNavigate)

  // If the user closes the window via OS chrome (Windows) before a terminal URL,
  // treat a checkout as cancelled and a portal close as a reason to resync.
  win.on('closed', () => {
    if (settled) return
    settled = true
    if (kind === 'checkout') emitToRenderer('openui:payment-cancelled')
    else void syncSubscriptionStatus(userId)
  })
}

// ── public entry points ───────────────────────────────────────────────────────

/**
 * Start a Stripe Checkout flow for `userId` buying `priceId`. Asks the Edge
 * Function for a hosted Checkout Session URL, then opens it in an isolated
 * window and watches for the success/cancel redirect.
 */
export async function openCheckoutWindow(userId: string, priceId: string): Promise<void> {
  if (!userId) throw new Error('openCheckoutWindow: not signed in (missing userId).')
  if (!priceId) throw new Error('openCheckoutWindow: missing priceId.')
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured; cannot start checkout.')

  const supabase = getSupabaseClient()
  // Read the email from the local user record (populated at sign-in) rather than
  // a network round-trip; the Edge Function uses it to find/create the customer.
  const email = database.users.getUserById(userId)?.email ?? undefined

  const { data, error } = await supabase.functions.invoke('create-checkout', {
    body: { userId, priceId, email }
  })
  if (error) throw new Error(`create-checkout failed: ${error.message}`)

  const url = (data as { url?: unknown } | null)?.url
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('create-checkout did not return a valid https checkout URL.')
  }

  const win = createFlowWindow('Upgrade OpenUI', 'openui://payment-cancelled')
  attachFlowMonitor(win, userId, 'checkout')
  await win.loadURL(url)
  win.show()
}

/**
 * Open the Stripe billing portal so the user can upgrade/downgrade/cancel or view
 * invoices. The Edge Function resolves the Stripe customer from `userId` (we also
 * pass the cached customer id as a hint).
 */
export async function openCustomerPortal(userId: string): Promise<void> {
  if (!userId) throw new Error('openCustomerPortal: not signed in (missing userId).')
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured; cannot open billing portal.')

  const supabase = getSupabaseClient()

  // The Edge Function resolves the Stripe customer from the user id (via the
  // app_metadata.stripeCustomerId the webhook stored), so we just pass userId.
  const { data, error } = await supabase.functions.invoke('customer-portal', {
    body: { userId }
  })
  if (error) throw new Error(`customer-portal failed: ${error.message}`)

  const url = (data as { url?: unknown } | null)?.url
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('customer-portal did not return a valid https portal URL.')
  }

  const win = createFlowWindow('Manage subscription', 'openui://portal-closed')
  attachFlowMonitor(win, userId, 'portal')
  await win.loadURL(url)
  win.show()
}

// ── IPC ───────────────────────────────────────────────────────────────────────

/** The set of Stripe price ids the app is allowed to start checkout for. */
function allowedPriceIds(): Set<string> {
  return new Set(
    [TIERS.pro.stripePriceId, TIERS.enterprise.stripePriceId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    )
  )
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Register the Stripe IPC surface and start the subscription sync loop. Mirrors
 * the project's `registerAgentIPC` / `registerVoiceIPC` convention.
 */
export function registerStripeIPC(win: BrowserWindow): void {
  setMainWindow(win)

  ipcMain.handle('openui:checkout', async (_event, payload: unknown) => {
    const priceId = readString((payload as { priceId?: unknown } | null)?.priceId)
    if (!priceId) throw new Error('openui:checkout requires a string "priceId".')

    // Defence-in-depth: only ever start checkout for a price we configured.
    if (!allowedPriceIds().has(priceId)) {
      throw new Error('openui:checkout received an unrecognised priceId.')
    }

    const userId = getCurrentUserId()
    if (!userId) throw new Error('Cannot start checkout: no user is signed in.')

    await openCheckoutWindow(userId, priceId)
  })

  ipcMain.handle('openui:portal', async () => {
    const userId = getCurrentUserId()
    if (!userId) throw new Error('Cannot open billing portal: no user is signed in.')
    await openCustomerPortal(userId)
  })

  ipcMain.handle('openui:sync-subscription', async () => {
    const userId = getCurrentUserId()
    if (!userId) return 'free'
    return syncSubscriptionStatus(userId)
  })

  startSubscriptionSyncLoop()
}
