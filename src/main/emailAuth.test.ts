import { describe, it, expect, vi, beforeEach } from 'vitest'

// Email/password auth is the gate the whole feature rests on, so these tests
// cover the three states that matter — a valid session gates the app OPEN, a bad
// credential gates it CLOSED, and an expired one drops back to signed-out — plus
// every distinct failure the user can hit, since the point of the error taxonomy
// is that each one gets its own message rather than a shared "sign-in failed".
//
// Everything below the Supabase client is mocked at the module boundary: no
// network, no Electron, no better-sqlite3.

// vi.mock factories are hoisted above the file body, so every piece of shared
// state they close over has to be created inside vi.hoisted.
const H = vi.hoisted(() => {
  interface Row {
    id: string
    email: string | null
    display_name: string | null
    avatar_url: string | null
    tier: string
    auth_token: string | null
    refresh_token: string | null
    token_expires_at: number | null
  }
  const rows = new Map<string, Row>()
  const settings = new Map<string, unknown>()
  const now = (): number => Math.floor(Date.now() / 1000)

  const db = {
    users: {
      upsertUser: (u: { id: string; email?: string; displayName?: string; avatarUrl?: string; tier?: string }) => {
        const prev = rows.get(u.id)
        rows.set(u.id, {
          id: u.id,
          email: u.email ?? null,
          display_name: u.displayName ?? null,
          avatar_url: u.avatarUrl ?? null,
          tier: u.tier ?? 'free',
          auth_token: prev?.auth_token ?? null,
          refresh_token: prev?.refresh_token ?? null,
          token_expires_at: prev?.token_expires_at ?? null
        })
      },
      updateAuthTokens: (id: string, access: string, refresh: string, expiresAt: number) => {
        const row = rows.get(id)
        if (row) {
          row.auth_token = access
          row.refresh_token = refresh
          row.token_expires_at = expiresAt
        }
      },
      getUserById: (id: string) => rows.get(id) ?? null,
      getValidToken: (id: string) => {
        const row = rows.get(id)
        if (!row?.auth_token || !row.token_expires_at) return null
        return row.token_expires_at <= now() ? null : row.auth_token
      }
    },
    settings: {
      setSetting: (k: string, v: unknown) => { settings.set(k, v) },
      getSetting: (k: string) => settings.get(k),
      deleteSetting: (k: string) => { settings.delete(k) }
    },
    subscriptions: {
      cacheSubscription: () => {},
      getCachedSubscription: () => null
    }
  }

  const supabase = {
    auth: {
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(async () => ({}))
    }
  }
  const state = { configured: true }
  return { rows, settings, now, db, supabase, state }
})
const { rows, settings, now, db, supabase, state } = H

vi.mock('./database', () => ({ database: H.db }))
vi.mock('./database/repositories/settingsRepo', () => ({
  getSetting: (k: string) => H.settings.get(k),
  setSetting: (k: string, v: unknown) => { H.settings.set(k, v) }
}))
vi.mock('./telemetry/posthog', () => ({ resetTelemetryIdentity: () => {}, identifyUser: () => {} }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('./auth/supabaseClient', () => ({
  getSupabaseClient: () => H.supabase,
  isSupabaseConfigured: () => H.state.configured
}))

import {
  mapAuthError,
  isValidEmail,
  profileFromUser,
  registerWithEmail,
  signInWithEmail,
  MIN_PASSWORD_LENGTH
} from './auth/emailAuth'
import { hasAccountSession, getCurrentUser, ACTIVE_USER_KEY } from './auth/sessionManager'

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: now() + 3600, ...overrides }
}
interface TestUser {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown> | null
  app_metadata?: Record<string, unknown> | null
}
function user(overrides: Partial<TestUser> = {}): TestUser {
  return { id: 'u1', email: 'rin@example.com', user_metadata: {}, app_metadata: {}, ...overrides }
}

beforeEach(() => {
  rows.clear()
  settings.clear()
  state.configured = true
  vi.clearAllMocks()
})

describe('mapAuthError — every failure gets its own code', () => {
  const cases: [string, string][] = [
    ['Invalid login credentials', 'invalid_credentials'],
    ['Email not confirmed', 'email_not_confirmed'],
    ['User already registered', 'email_taken'],
    ['Password should be at least 6 characters', 'weak_password'],
    ['Unable to validate email address: invalid format', 'invalid_email'],
    ['For security purposes, you can only request this after 46 seconds', 'rate_limited'],
    ['fetch failed', 'network']
  ]
  for (const [message, code] of cases) {
    it(`"${message}" → ${code}`, () => {
      expect(mapAuthError(new Error(message)).code).toBe(code)
    })
  }

  it('keeps an unrecognised failure visible instead of flattening it', () => {
    const out = mapAuthError(new Error('database is on fire'))
    expect(out.code).toBe('unknown')
    // The raw cause has to survive — an unfamiliar failure hidden behind a
    // friendly message is exactly how a real bug goes unreported.
    expect(out.message).toContain('database is on fire')
  })

  it('never tells the user to open a terminal', () => {
    for (const [message] of cases) {
      expect(mapAuthError(new Error(message)).message).not.toMatch(/terminal|command|ollama/i)
    }
  })
})

describe('isValidEmail', () => {
  it('accepts a normal address and rejects obvious typos', () => {
    expect(isValidEmail('rin@example.com')).toBe(true)
    expect(isValidEmail('rin@')).toBe(false)
    expect(isValidEmail('rin.example.com')).toBe(false)
    expect(isValidEmail('')).toBe(false)
  })
})

describe('profileFromUser', () => {
  it('prefers a full name, falls back to the email, and defaults the tier', () => {
    expect(profileFromUser(user({ user_metadata: { full_name: 'Rin' } })).display_name).toBe('Rin')
    expect(profileFromUser(user()).display_name).toBe('rin@example.com')
    expect(profileFromUser(user()).tier).toBe('free')
    expect(profileFromUser(user({ app_metadata: { tier: 'pro' } })).tier).toBe('pro')
  })
})

describe('registerWithEmail', () => {
  it('persists the session and opens the gate on success', async () => {
    supabase.auth.signUp.mockResolvedValue({ data: { user: user(), session: session() }, error: null })

    const out = await registerWithEmail(null, 'rin@example.com', 'a-long-password')

    expect(out.ok).toBe(true)
    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: 'rin@example.com',
      password: 'a-long-password'
    })
    // The session must be persisted through the SAME path the OAuth flow uses,
    // so refresh and "who is signed in" keep working.
    expect(settings.get(ACTIVE_USER_KEY)).toBe('u1')
    expect(hasAccountSession()).toBe(true)
  })

  it('reports "confirm your email" as a success WITHOUT signing anyone in', async () => {
    // A confirmation-required project returns a user and no session. Treating
    // that as a sign-in would open the gate for an unconfirmed account.
    supabase.auth.signUp.mockResolvedValue({ data: { user: user(), session: null }, error: null })

    const out = await registerWithEmail(null, 'rin@example.com', 'a-long-password')

    expect(out).toMatchObject({ ok: true, needsEmailConfirmation: true })
    expect(hasAccountSession()).toBe(false)
    expect(settings.get(ACTIVE_USER_KEY)).toBeUndefined()
  })

  it('rejects a short password locally, before any network call', async () => {
    const out = await registerWithEmail(null, 'rin@example.com', 'short')
    expect(out).toMatchObject({ ok: false, code: 'weak_password' })
    expect(out.ok === false && out.message).toContain(String(MIN_PASSWORD_LENGTH))
    expect(supabase.auth.signUp).not.toHaveBeenCalled()
  })

  it('rejects a malformed email locally', async () => {
    const out = await registerWithEmail(null, 'rin@', 'a-long-password')
    expect(out).toMatchObject({ ok: false, code: 'invalid_email' })
    expect(supabase.auth.signUp).not.toHaveBeenCalled()
  })

  it('surfaces an already-registered email as its own code', async () => {
    supabase.auth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error('User already registered')
    })
    const out = await registerWithEmail(null, 'rin@example.com', 'a-long-password')
    expect(out).toMatchObject({ ok: false, code: 'email_taken' })
    expect(hasAccountSession()).toBe(false)
  })

  it('fails closed when Supabase is not configured', async () => {
    state.configured = false
    const out = await registerWithEmail(null, 'rin@example.com', 'a-long-password')
    expect(out).toMatchObject({ ok: false, code: 'not_configured' })
    expect(hasAccountSession()).toBe(false)
  })
})

describe('signInWithEmail', () => {
  it('a valid credential produces a session that gates the app open', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: user(), session: session() },
      error: null
    })
    const out = await signInWithEmail(null, 'rin@example.com', 'pw')
    expect(out.ok).toBe(true)
    expect(hasAccountSession()).toBe(true)
  })

  it('an invalid credential leaves the app gated closed', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error('Invalid login credentials')
    })
    const out = await signInWithEmail(null, 'rin@example.com', 'wrong')
    expect(out).toMatchObject({ ok: false, code: 'invalid_credentials' })
    expect(hasAccountSession()).toBe(false)
  })

  it('a thrown network error is reported as network, not as bad credentials', async () => {
    supabase.auth.signInWithPassword.mockRejectedValue(new Error('fetch failed'))
    const out = await signInWithEmail(null, 'rin@example.com', 'pw')
    expect(out).toMatchObject({ ok: false, code: 'network' })
  })

  it('trims the email so a trailing space is not a failed sign-in', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: user(), session: session() },
      error: null
    })
    await signInWithEmail(null, '  rin@example.com ', 'pw')
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'rin@example.com',
      password: 'pw'
    })
  })
})

describe('the session gate itself', () => {
  it('an anonymous session (no email) does NOT count as an account', async () => {
    // ensureGuestSession mints exactly this shape. If it satisfied the gate, the
    // gate would be satisfiable without anyone ever registering.
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: user({ email: null }), session: session() },
      error: null
    })
    await signInWithEmail(null, 'rin@example.com', 'pw')
    expect(hasAccountSession()).toBe(false)
  })

  it('an expired session with a dead refresh token gates closed and is cleared', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: user(), session: session({ expires_at: now() - 10 }) },
      error: null
    })
    await signInWithEmail(null, 'rin@example.com', 'pw')
    // The refresh token is no longer accepted.
    supabase.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: new Error('bad') })

    expect(hasAccountSession()).toBe(false)
    // And the stale profile must not be handed back as a signed-in user.
    await expect(getCurrentUser()).resolves.toBeNull()
    expect(settings.get(ACTIVE_USER_KEY)).toBeUndefined()
  })

  it('an expired session that CAN be refreshed stays signed in', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: user(), session: session({ expires_at: now() - 10 }) },
      error: null
    })
    await signInWithEmail(null, 'rin@example.com', 'pw')
    supabase.auth.refreshSession.mockImplementation(async () => {
      // Mirror what the real refresh does: write fresh tokens.
      db.users.updateAuthTokens('u1', 'access-2', 'refresh-2', now() + 3600)
      return { data: { session: { access_token: 'access-2', refresh_token: 'refresh-2', expires_at: now() + 3600, user: { app_metadata: {} } } }, error: null }
    })

    const profile = await getCurrentUser()
    expect(profile?.id).toBe('u1')
    expect(hasAccountSession()).toBe(true)
  })

  it('no session at all gates closed', () => {
    expect(hasAccountSession()).toBe(false)
  })
})
