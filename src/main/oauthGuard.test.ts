import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { request } from 'node:http'

const H = vi.hoisted(() => ({ opened: [] as string[] }))
vi.mock('electron', () => ({ shell: { openExternal: async (url: string) => void H.opened.push(url) } }))

import { newOAuthGuard, stateMatches } from './oauthGuard'
import { buildAuthUrl, buildTokenExchangeBody, connectGmail } from './gmail'

describe('newOAuthGuard', () => {
  it('makes a fresh state and a PKCE S256 pair each time', () => {
    const a = newOAuthGuard()
    const b = newOAuthGuard()
    expect(a.state).not.toBe(b.state)
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(a.codeVerifier.length).toBeLessThanOrEqual(128)
    expect(a.codeChallenge).toBe(createHash('sha256').update(a.codeVerifier).digest('base64url'))
  })

  it('compares state exactly', () => {
    expect(stateMatches('abc', 'abc')).toBe(true)
    expect(stateMatches('abc', 'abd')).toBe(false)
    expect(stateMatches('abc', 'ab')).toBe(false)
    expect(stateMatches('abc', null)).toBe(false)
  })

  it('goes into the authorization URL and the token exchange', () => {
    const g = newOAuthGuard()
    const url = new URL(buildAuthUrl('cid', 'http://127.0.0.1:1/callback', g))
    expect(url.searchParams.get('state')).toBe(g.state)
    expect(url.searchParams.get('code_challenge')).toBe(g.codeChallenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const body = buildTokenExchangeBody({ clientId: 'cid', clientSecret: 's' }, 'code', 'http://127.0.0.1:1/callback', g.codeVerifier)
    expect(body.get('code_verifier')).toBe(g.codeVerifier)
  })
})

/** GET a path on the loopback port; resolves with the status code. */
function hit(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('connectGmail loopback', () => {
  beforeEach(() => {
    H.opened.length = 0
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'cid')
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('refuses a redirect it did not ask for, and keeps waiting for the real one', async () => {
    const flow = connectGmail()
    await vi.waitFor(() => expect(H.opened).toHaveLength(1))
    const auth = new URL(H.opened[0])
    const port = Number(new URL(auth.searchParams.get('redirect_uri')!).port)
    const state = auth.searchParams.get('state')!

    // Someone else's code, with no state or a wrong one: refused, nothing connected.
    expect(await hit(port, '/callback?code=ATTACKER')).toBe(400)
    expect(await hit(port, '/callback?code=ATTACKER&state=guess')).toBe(400)
    // …and a forged ?error= can no longer end the flow early.
    expect(await hit(port, '/callback?error=access_denied')).toBe(400)

    // The genuine redirect (here: the user pressed Cancel) is still accepted.
    expect(await hit(port, `/callback?error=access_denied&state=${encodeURIComponent(state)}`)).toBe(200)
    await expect(flow).resolves.toMatchObject({ ok: false, error: expect.stringContaining('access_denied') })
  })
})
