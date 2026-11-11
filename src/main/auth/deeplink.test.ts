import { describe, it, expect, vi, beforeEach } from 'vitest'

// Anyone can send an openui://auth-callback link carrying their own tokens.
// Opening one must not silently switch a signed-in app to the sender's account.

const H = vi.hoisted(() => ({
  activeUser: null as string | null,
  authWindowOpen: false,
  setSession: vi.fn(async () => ({})),
  getUser: vi.fn(async () => ({ data: { user: { id: 'attacker', email: 'x@evil.test', user_metadata: {}, app_metadata: {} } }, error: null })),
  upsertUser: vi.fn()
}))

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {} }))
vi.mock('./supabaseClient', () => ({
  getSupabaseClient: () => ({ auth: { setSession: H.setSession, getUser: H.getUser } })
}))
vi.mock('./authWindow', () => ({ closeAuthWindow: vi.fn(), isAuthWindowOpen: () => H.authWindowOpen }))
vi.mock('../database', () => ({
  database: { users: { upsertUser: H.upsertUser, updateAuthTokens: vi.fn() } }
}))
vi.mock('./sessionManager', () => ({ setActiveUser: vi.fn(), cacheUserTier: vi.fn() }))
vi.mock('../telemetry/posthog', () => ({ identifyUser: vi.fn() }))
vi.mock('../stripe/subscriptionSync', () => ({
  emitToRenderer: vi.fn(),
  getCurrentUserId: () => H.activeUser,
  handlePaymentSuccess: vi.fn(),
  syncSubscriptionStatus: vi.fn(async () => 'free')
}))

import { handleDeepLink } from './deeplink'

const LINK = 'openui://auth-callback#access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer'
const win = { isDestroyed: () => false, webContents: { send: vi.fn() } } as never

beforeEach(() => {
  vi.clearAllMocks()
  H.activeUser = null
  H.authWindowOpen = false
})

describe('auth-callback deep links', () => {
  it('are ignored while signed in, when no sign-in was started here', async () => {
    H.activeUser = 'victim'
    await handleDeepLink(LINK, win)
    expect(H.setSession).not.toHaveBeenCalled()
    expect(H.upsertUser).not.toHaveBeenCalled()
  })

  it('complete a sign-in this app started', async () => {
    H.activeUser = 'victim'
    H.authWindowOpen = true
    await handleDeepLink(LINK, win)
    expect(H.setSession).toHaveBeenCalledWith({ access_token: 'AT', refresh_token: 'RT' })
  })

  it('are adopted when nobody is signed in (an email-confirmation link)', async () => {
    await handleDeepLink(LINK, win)
    expect(H.setSession).toHaveBeenCalled()
  })
})
