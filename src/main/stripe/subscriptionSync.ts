/**
 * subscriptionSync.ts — keeps the local tier in sync with the authoritative
 * subscription state held by Supabase + Stripe, and acts as the IPC hub for the
 * Stripe feature (it owns the reference to the main window).
 *
 * Source-of-truth flow:
 *   Stripe webhook → Supabase `app_metadata.tier`  (authoritative)
 *   syncSubscriptionStatus() reads that + cross-checks live Stripe status via an
 *   Edge Function, writes the result into the UNTRUSTED local cache
 *   (`database.subscriptions`), and tells the renderer when the tier changes.
 *
 * The signed-in user is owned by the auth layer (sessionManager); we read the
 * active user id from `settings` so checkout/sync target the right account.
 */
import { BrowserWindow } from 'electron'
import { getSupabaseClient, isSupabaseConfigured } from '../auth/supabaseClient'
import { database } from '../database'
import { ACTIVE_USER_KEY } from '../auth/sessionManager'
import { getTierForUser, type TierId } from './pricing'

const SYNC_INTERVAL_MS = 5 * 60 * 1000
const DAY_SEC = 24 * 60 * 60

let mainWindow: BrowserWindow | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let focusHandlerAttached = false

/**
 * The Supabase id of the currently signed-in user (or null). Owned by the auth
 * layer, which records it in `settings` under `auth.active_user_id`.
 */
export function getCurrentUserId(): string | null {
  const id = database.settings.getSetting(ACTIVE_USER_KEY)
  return typeof id === 'string' && id ? id : null
}

/** Register the main window so tier/payment events can be pushed to the UI. */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

/** Send an IPC message to the renderer, guarding against a destroyed window. */
export function emitToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function coerceTier(value: unknown): TierId {
  return value === 'pro' || value === 'enterprise' ? value : 'free'
}

/**
 * Fetch the user's authoritative tier from Supabase (app_metadata.tier, written
 * by the Stripe webhook) and cross-check live Stripe status via the
 * `check-subscription` Edge Function, then update the local cache. Emits
 * `openui:tier-changed` to the renderer when the tier differs from the cache.
 *
 * If Supabase is unreachable or unconfigured we fall back to the cached tier —
 * but only while it is fresh (< 24h, enforced by `getTierForUser`).
 *
 * Returns the resolved current tier.
 */
export async function syncSubscriptionStatus(userId: string): Promise<TierId> {
  const previousTier = getTierForUser(userId)

  if (!isSupabaseConfigured()) {
    // Nothing to verify against — never trust a stale cache to unlock paid tiers.
    return previousTier
  }

  try {
    const supabase = getSupabaseClient()

    // 1) Authoritative claim: the tier baked into the user's JWT by the webhook.
    let tier: TierId | null = null
    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (!userErr) {
      const metaTier = (userData?.user?.app_metadata as Record<string, unknown> | undefined)?.tier
      if (metaTier) tier = coerceTier(metaTier)
    }

    // 2) Live cross-check with Stripe (status + period end) via Edge Function.
    //    The Edge Function holds the Stripe secret key; we only receive results.
    let stripeStatus = 'active'
    let currentPeriodEnd: number | null = null
    const { data: subData, error: subErr } = await supabase.functions.invoke('check-subscription', {
      body: { userId }
    })
    if (!subErr && subData && typeof subData === 'object') {
      const d = subData as { tier?: unknown; status?: unknown; currentPeriodEnd?: unknown }
      if (d.tier) tier = coerceTier(d.tier)
      if (typeof d.status === 'string') stripeStatus = d.status
      if (typeof d.currentPeriodEnd === 'number') currentPeriodEnd = d.currentPeriodEnd
    }

    const resolvedTier: TierId = tier ?? 'free'
    const nowSec = Math.floor(Date.now() / 1000)
    // A paid tier with no explicit period end stays fresh for a day so
    // getTierForUser doesn't immediately treat it as expired.
    const periodEnd = currentPeriodEnd ?? (resolvedTier === 'free' ? nowSec : nowSec + DAY_SEC)

    database.subscriptions.cacheSubscription(userId, resolvedTier, stripeStatus, periodEnd)

    if (resolvedTier !== previousTier) {
      emitToRenderer('openui:tier-changed', resolvedTier)
    }
    return resolvedTier
  } catch (err) {
    // Supabase/Stripe unreachable — degrade to the (freshness-guarded) cache.
    console.error(
      '[openui] Subscription sync failed; using cached tier:',
      err instanceof Error ? err.message : err
    )
    return getTierForUser(userId)
  }
}

/**
 * Start syncing the signed-in user's subscription:
 *   • every 5 minutes,
 *   • whenever the main window regains focus,
 *   • plus an immediate sync right now.
 * Idempotent — calling it more than once won't stack timers/listeners. The loop
 * idles harmlessly while there is no signed-in user. The timer is unref'd so it
 * never by itself keeps the app alive.
 */
export function startSubscriptionSyncLoop(): void {
  const tick = (): void => {
    const userId = getCurrentUserId()
    if (userId) void syncSubscriptionStatus(userId)
  }

  if (!syncTimer) {
    syncTimer = setInterval(tick, SYNC_INTERVAL_MS)
    if (typeof syncTimer.unref === 'function') syncTimer.unref()
  }

  if (mainWindow && !mainWindow.isDestroyed() && !focusHandlerAttached) {
    mainWindow.on('focus', tick)
    focusHandlerAttached = true
  }

  tick()
}

/** Stop the periodic sync (e.g. on shutdown). */
export function stopSubscriptionSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

/**
 * Called when a checkout window (or the `openui://payment-success` deep link)
 * reports success. Forces an immediate sync — don't wait for the 5-minute loop —
 * then notifies the renderer so it can celebrate / unlock the UI.
 */
export async function handlePaymentSuccess(userId: string): Promise<void> {
  const id = userId || getCurrentUserId()
  if (id) await syncSubscriptionStatus(id)
  emitToRenderer('openui:payment-success')
}
