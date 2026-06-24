/**
 * sessionManager.ts — lifecycle of the signed-in session.
 *
 * Persistence goes through the shared `database` layer (src/main/database):
 * profile + tokens live on the `users` table, the tier is cached in
 * `subscription_cache`, and the id of the currently signed-in user is kept in
 * `settings` (OpenUI is single-user, so "the current user" is just that id).
 * Token refresh goes through Supabase. All of this runs in the main process; the
 * renderer only ever sees the derived profile/tier over IPC.
 *
 * NOTE on units: the database stores token expiry as epoch SECONDS (matching the
 * schema and Supabase's `session.expires_at`), so this module works in seconds.
 */
import { BrowserWindow } from 'electron'
import { getSupabaseClient } from './supabaseClient'
import { database, type UserRow } from '../database'

/** Settings key under which the signed-in user's id is stored. */
export const ACTIVE_USER_KEY = 'auth.active_user_id'

/** Refresh proactively this often. */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
/** Treat a token as "needs refresh" once within this many seconds of expiry. */
const EXPIRY_SKEW_SEC = 5 * 60 // 5 minutes
/** How long a cached tier stays fresh before getUserTier falls back to 'free'. */
const TIER_CACHE_TTL_SEC = 6 * 60 * 60 // 6 hours

/** Profile shape sent to the renderer (mirrors preload `AuthUser`). */
export interface UserProfile {
  id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  tier: string
}

function rowToProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    tier: row.tier
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// ── current user (single-user app) ────────────────────────────────────────────

/** Record which user is signed in (called when an auth callback completes). */
export function setActiveUser(userId: string): void {
  database.settings.setSetting(ACTIVE_USER_KEY, userId)
}

function getActiveUserId(): string | null {
  const id = database.settings.getSetting(ACTIVE_USER_KEY)
  return typeof id === 'string' && id ? id : null
}

/**
 * Cache a user's subscription tier. We reuse the Stripe-shaped
 * subscription_cache table, treating `current_period_end` as the cache-freshness
 * deadline so getUserTier can expire stale entries.
 */
export function cacheUserTier(userId: string, tier: string): void {
  database.subscriptions.cacheSubscription(userId, tier, 'active', nowSeconds() + TIER_CACHE_TTL_SEC)
}

// ── session API ───────────────────────────────────────────────────────────────

/** True when a non-expired access token is stored for the signed-in user. */
export function isAuthenticated(): boolean {
  const id = getActiveUserId()
  if (!id) return false
  return database.users.getValidToken(id) !== null
}

/**
 * Exchange the stored refresh token for a fresh access token via Supabase and
 * persist the new pair. Returns false when there is no session to refresh or the
 * refresh token is no longer valid.
 */
export async function refreshSession(): Promise<boolean> {
  const id = getActiveUserId()
  if (!id) return false
  const row = database.users.getUserById(id)
  if (!row?.refresh_token) return false

  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: row.refresh_token })
    const session = data?.session
    if (error || !session) return false

    // Supabase's session.expires_at is already epoch SECONDS.
    const expiresAtSec = session.expires_at ?? nowSeconds() + (session.expires_in ?? 3600)
    database.users.updateAuthTokens(id, session.access_token, session.refresh_token, expiresAtSec)

    const tier = (session.user?.app_metadata as Record<string, unknown> | undefined)?.tier
    if (typeof tier === 'string') cacheUserTier(id, tier)

    return true
  } catch (err) {
    console.error('[openui] refreshSession failed:', err)
    return false
  }
}

/**
 * Return the cached user profile, refreshing the session first when the access
 * token is at/near expiry. Returns null when nobody is signed in.
 */
export async function getCurrentUser(): Promise<UserProfile | null> {
  const id = getActiveUserId()
  if (!id) return null
  const row = database.users.getUserById(id)
  if (!row) return null

  if (row.token_expires_at && row.token_expires_at <= nowSeconds() + EXPIRY_SKEW_SEC) {
    await refreshSession() // best effort; profile is still returned either way
  }
  const fresh = database.users.getUserById(id)
  return rowToProfile(fresh ?? row)
}

/**
 * Sign out: invalidate local tokens, forget the active user, revoke the Supabase
 * session, and tell the renderer. Never throws — a failed network sign-out must
 * not leave the user stuck "signed in" locally.
 */
export async function logout(win?: BrowserWindow | null): Promise<void> {
  const id = getActiveUserId()
  if (id) database.users.updateAuthTokens(id, '', '', 0) // clears the valid token
  database.settings.deleteSetting(ACTIVE_USER_KEY)

  try {
    await getSupabaseClient().auth.signOut()
  } catch (err) {
    console.warn('[openui] Supabase signOut failed (local tokens already cleared):', err)
  }

  if (win && !win.isDestroyed()) win.webContents.send('openui:auth-logout')
}

/** Return the cached subscription tier, defaulting to 'free' when stale/absent. */
export function getUserTier(): string {
  const id = getActiveUserId()
  if (!id) return 'free'
  const sub = database.subscriptions.getCachedSubscription(id)
  if (!sub?.tier) return 'free'
  if (sub.current_period_end != null && sub.current_period_end <= nowSeconds()) return 'free'
  return sub.tier
}

// ── proactive refresh loop ────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start a 30-minute loop that refreshes the access token before it expires. The
 * timer is unref'd so it never by itself keeps the app alive, and each tick is a
 * no-op unless a user is signed in (i.e. it only does work while the app has an
 * active session). Idempotent — calling again restarts a single timer.
 */
export function startTokenRefreshLoop(win?: BrowserWindow | null): void {
  stopTokenRefreshLoop()
  refreshTimer = setInterval(() => void tick(win), REFRESH_INTERVAL_MS)
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref()
}

/** Stop the proactive refresh loop (e.g. on app shutdown). */
export function stopTokenRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

async function tick(win?: BrowserWindow | null): Promise<void> {
  const id = getActiveUserId()
  if (!id) return // no active session ⇒ nothing to refresh
  const row = database.users.getUserById(id)
  if (!row?.token_expires_at) return

  // Only spend a network call when the token would expire before the next tick.
  if (row.token_expires_at > nowSeconds() + REFRESH_INTERVAL_MS / 1000 + EXPIRY_SKEW_SEC) return

  const ok = await refreshSession()
  if (!ok) {
    // The refresh token is dead — force a clean logout so the UI reflects it.
    await logout(win)
  }
}
