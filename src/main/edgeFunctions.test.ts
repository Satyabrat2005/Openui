import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A network that hangs instead of failing used to leave callers (the Splen
// download's "starting download") waiting for minutes. Every edge call now
// carries a time limit and a hang becomes the usual network error.

vi.mock('./stripe/subscriptionSync', () => ({ getCurrentUserId: () => 'u1' }))
vi.mock('./database', () => ({ database: { users: { getValidToken: () => 'tok' } } }))
vi.mock('./auth/sessionManager', () => ({ refreshSession: async () => true }))

import { callEdgeFunction, EDGE_TIMEOUT_MS } from './edgeFunctions'

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('callEdgeFunction', () => {
  it('sends every request with a time limit', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await callEdgeFunction('splen-download', {})
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(EDGE_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('turns a request that timed out into a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }))
    await expect(callEdgeFunction('splen-download', {})).rejects.toMatchObject({ code: 'network_error' })
  })
})
