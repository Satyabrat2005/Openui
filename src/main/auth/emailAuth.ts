/**
 * emailAuth.ts — email + password registration and sign-in.
 *
 * WHY THIS EXISTS. OpenUI's only real sign-in path was Google OAuth through an
 * external browser window (authWindow + deeplink), and it was *optional*: a
 * silent anonymous guest session (sessionManager.ensureGuestSession) made the
 * app fully usable with no account at all. That is the opposite of what this
 * feature needs — access to the model is now gated behind a real account, so
 * there has to be an account the user can actually create from inside the app,
 * without an OAuth provider and without leaving the window.
 *
 * Everything here runs in the MAIN process. The anon key, the access token and
 * the refresh token never cross the IPC boundary; the renderer only ever sees a
 * derived profile (id / email / display name / tier) and an error code. Session
 * persistence is the same SQLite-backed path the OAuth flow already uses
 * (database.users + settings), NOT renderer localStorage.
 *
 * The error mapping is pure and exported so every failure path can be tested
 * without a network or a Supabase project.
 */
import type { BrowserWindow } from 'electron'
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient'
import { database } from '../database'
import { setActiveUser, cacheUserTier, type UserProfile } from './sessionManager'

/**
 * Why a sign-in or registration attempt failed. The renderer switches on this
 * rather than pattern-matching a message string, so copy can change without
 * breaking behaviour — and so each failure gets its own legible message instead
 * of one generic "sign-in failed".
 */
export type AuthErrorCode =
  | 'not_configured'
  | 'invalid_email'
  | 'weak_password'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'email_taken'
  | 'rate_limited'
  | 'network'
  | 'unknown'

export type AuthOutcome =
  | { ok: true; profile: UserProfile; needsEmailConfirmation?: boolean }
  | { ok: false; code: AuthErrorCode; message: string }

/** Minimum password length we accept locally, before Supabase's own policy. */
export const MIN_PASSWORD_LENGTH = 8

/**
 * Deliberately permissive: this only catches obvious typos ("rin@", "rin.com")
 * so the user gets an instant, local answer instead of a network round-trip.
 * Supabase remains the authority on whether an address is really deliverable.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim())
}

/**
 * Map whatever Supabase (or the network stack) threw into a stable code plus a
 * message a person can act on.
 *
 * Supabase returns human-readable strings, not stable codes, for most auth
 * failures, so this matches on the text it actually sends. Anything unmatched
 * falls through to `unknown` with the raw message preserved — an unfamiliar
 * failure must stay visible, not be swallowed into a friendly lie.
 *
 * Pure and exported for tests.
 */
export function mapAuthError(raw: unknown): { code: AuthErrorCode; message: string } {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '')
  const t = text.toLowerCase()

  if (/fetch failed|network|enotfound|econnrefused|etimedout|timeout/.test(t)) {
    return {
      code: 'network',
      message: "We couldn't reach the account service. Check your internet connection and try again."
    }
  }
  if (/already registered|already been registered|user already exists|already exists/.test(t)) {
    return {
      code: 'email_taken',
      message: 'An account with that email already exists. Sign in instead, or use a different email.'
    }
  }
  if (/email not confirmed|not confirmed/.test(t)) {
    return {
      code: 'email_not_confirmed',
      message: 'Check your inbox and confirm your email address, then sign in.'
    }
  }
  if (/invalid login credentials|invalid credentials|invalid email or password/.test(t)) {
    return { code: 'invalid_credentials', message: 'That email and password combination is incorrect.' }
  }
  if (/password should be|password is too|weak password|at least \d+ characters/.test(t)) {
    return {
      code: 'weak_password',
      message: `Choose a longer password — at least ${MIN_PASSWORD_LENGTH} characters.`
    }
  }
  if (/unable to validate email|invalid email|email address .* is invalid/.test(t)) {
    return { code: 'invalid_email', message: 'That email address doesn’t look right.' }
  }
  if (/rate limit|too many requests|over_email_send_rate_limit|for security purposes/.test(t)) {
    return { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' }
  }
  return {
    code: 'unknown',
    message: text ? `Sign-in failed: ${text}` : 'Sign-in failed for an unknown reason. Please try again.'
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** The subset of a Supabase session/user this module persists. */
interface MinimalSession {
  access_token: string
  refresh_token?: string | null
  expires_at?: number | null
  expires_in?: number | null
}
interface MinimalUser {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown> | null
  app_metadata?: Record<string, unknown> | null
}

/**
 * Derive the renderer-facing profile from a Supabase user. Kept separate from
 * persistence so it can be unit-tested, and so the same shape is produced no
 * matter which flow (register / sign-in / refresh) created the session.
 */
export function profileFromUser(user: MinimalUser): UserProfile {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>
  const tier = typeof appMeta.tier === 'string' ? appMeta.tier : 'free'
  return {
    id: user.id,
    email: user.email ?? null,
    display_name:
      (typeof meta.full_name === 'string' && meta.full_name) ||
      (typeof meta.name === 'string' && meta.name) ||
      user.email ||
      null,
    avatar_url: typeof meta.avatar_url === 'string' ? meta.avatar_url : null,
    tier
  }
}

/**
 * Write the session to local storage exactly the way the OAuth callback does,
 * so token refresh, tier caching and "who is signed in" all keep working
 * unchanged regardless of which flow produced the session.
 */
export function persistSession(session: MinimalSession, user: MinimalUser): UserProfile {
  const profile = profileFromUser(user)
  const expiresAtSec =
    session.expires_at ?? nowSeconds() + (typeof session.expires_in === 'number' ? session.expires_in : 3600)

  database.users.upsertUser({
    id: profile.id,
    email: profile.email ?? undefined,
    displayName: profile.display_name ?? undefined,
    avatarUrl: profile.avatar_url ?? undefined,
    tier: profile.tier
  })
  database.users.updateAuthTokens(
    profile.id,
    session.access_token,
    session.refresh_token ?? '',
    expiresAtSec
  )
  cacheUserTier(profile.id, profile.tier)
  setActiveUser(profile.id)
  return profile
}

function announce(win: BrowserWindow | null | undefined, profile: UserProfile): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('openui:auth-success', profile)
  } catch {
    /* renderer gone — the session is still persisted */
  }
}

/** Shared front-door checks for both flows. */
function precheck(email: string, password: string, requireStrong: boolean): AuthOutcome | null {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      code: 'not_configured',
      message:
        'Accounts are not configured in this build, so sign-in is unavailable. Contact support if you were expecting to sign in here.'
    }
  }
  if (!isValidEmail(email)) {
    return { ok: false, code: 'invalid_email', message: 'Enter a valid email address.' }
  }
  if (requireStrong && password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'weak_password',
      message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`
    }
  }
  if (!password) {
    return { ok: false, code: 'invalid_credentials', message: 'Enter your password.' }
  }
  return null
}

/**
 * Create an account. When the Supabase project requires email confirmation,
 * `signUp` returns a user but NO session — that is not an error and must not be
 * reported as one, so we resolve with `needsEmailConfirmation` and leave the
 * user signed out until they confirm.
 */
export async function registerWithEmail(
  win: BrowserWindow | null,
  email: string,
  password: string
): Promise<AuthOutcome> {
  const bad = precheck(email, password, true)
  if (bad) return bad

  try {
    const { data, error } = await getSupabaseClient().auth.signUp({
      email: email.trim(),
      password
    })
    if (error) return { ok: false, ...mapAuthError(error) }

    const user = data?.user as MinimalUser | null | undefined
    const session = data?.session as MinimalSession | null | undefined
    if (!user) {
      return { ok: false, ...mapAuthError('signup returned no user') }
    }
    if (!session) {
      // Confirmation-required project: the account exists, but there is no
      // session yet. Report the real state instead of pretending we signed in.
      return { ok: true, profile: profileFromUser(user), needsEmailConfirmation: true }
    }

    const profile = persistSession(session, user)
    announce(win, profile)
    return { ok: true, profile }
  } catch (err) {
    return { ok: false, ...mapAuthError(err) }
  }
}

/** Sign in an existing account. */
export async function signInWithEmail(
  win: BrowserWindow | null,
  email: string,
  password: string
): Promise<AuthOutcome> {
  const bad = precheck(email, password, false)
  if (bad) return bad

  try {
    const { data, error } = await getSupabaseClient().auth.signInWithPassword({
      email: email.trim(),
      password
    })
    if (error) return { ok: false, ...mapAuthError(error) }

    const user = data?.user as MinimalUser | null | undefined
    const session = data?.session as MinimalSession | null | undefined
    if (!user || !session) {
      return { ok: false, ...mapAuthError('sign-in returned no session') }
    }

    const profile = persistSession(session, user)
    announce(win, profile)
    return { ok: true, profile }
  } catch (err) {
    return { ok: false, ...mapAuthError(err) }
  }
}
