import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// While paid plans are off, the subscription check has nothing to decide, and
// running it anyway cost every signed-in user two Supabase calls every five
// minutes plus one per window focus — enough, at a few hundred users, to use
// up the free plan's monthly Edge Function allowance on its own.

const H = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: { app_metadata: { tier: 'pro' } } }, error: null })),
  invoke: vi.fn(async () => ({ data: { tier: 'pro', status: 'active', currentPeriodEnd: null }, error: null })),
  cached: [] as unknown[][]
}))

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../auth/supabaseClient', () => ({
  isSupabaseConfigured: () => true,
  getSupabaseClient: () => ({ auth: { getUser: H.getUser }, functions: { invoke: H.invoke } })
}))
vi.mock('../auth/sessionManager', () => ({ ACTIVE_USER_KEY: 'auth.active_user_id' }))
vi.mock('../database', () => ({
  database: {
    settings: { getSetting: () => 'u1' },
    subscriptions: {
      getCachedSubscription: () => null,
      cacheSubscription: (...a: unknown[]) => H.cached.push(a)
    }
  }
}))

import { startSubscriptionSyncLoop, stopSubscriptionSyncLoop, syncSubscriptionStatus } from './subscriptionSync'

beforeEach(() => {
  vi.clearAllMocks()
  H.cached.length = 0
})
afterEach(() => {
  stopSubscriptionSyncLoop()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('subscription sync while paid plans are off', () => {
  it('asks Supabase nothing and keeps the local tier', async () => {
    vi.stubEnv('OPENUI_ENABLE_PAID_PLANS', '')
    await expect(syncSubscriptionStatus('u1')).resolves.toBe('free')
    expect(H.getUser).not.toHaveBeenCalled()
    expect(H.invoke).not.toHaveBeenCalled()
  })

  it('starts no five-minute loop', async () => {
    vi.stubEnv('OPENUI_ENABLE_PAID_PLANS', '')
    vi.useFakeTimers()
    startSubscriptionSyncLoop()
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
    expect(H.invoke).not.toHaveBeenCalled()
  })

  it('still checks once paid plans are switched on', async () => {
    vi.stubEnv('OPENUI_ENABLE_PAID_PLANS', '1')
    await expect(syncSubscriptionStatus('u1')).resolves.toBe('pro')
    expect(H.invoke).toHaveBeenCalledWith('check-subscription', { body: { userId: 'u1' } })
  })
})
