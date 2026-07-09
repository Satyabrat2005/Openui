// Regression tests for requireVerifiedUser — the object-level-authorization
// guard shared by the billing edge functions (create-checkout,
// check-subscription, customer-portal). Run with: deno test
import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts'
import { requireVerifiedUser, type AuthClient } from './auth.ts'

const REAL_USER_ID = 'user-real-123'

function fakeSupabase(overrides: Partial<AuthClient['auth']> = {}): AuthClient {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === 'valid-token') {
          return { data: { user: { id: REAL_USER_ID, email: 'real@example.com' } }, error: null }
        }
        return { data: { user: null }, error: new Error('invalid token') }
      },
      ...overrides
    }
  }
}

function reqWithAuth(token?: string): Request {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return new Request('https://example.com/fn', { method: 'POST', headers })
}

Deno.test('rejects requests with no Authorization header', async () => {
  const result = await requireVerifiedUser(reqWithAuth(undefined), fakeSupabase())
  assertEquals(result, { ok: false, status: 401, error: 'missing_token' })
})

Deno.test('rejects requests with an invalid/expired token', async () => {
  const result = await requireVerifiedUser(reqWithAuth('garbage-token'), fakeSupabase())
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.status, 401)
    assertEquals(result.error, 'invalid_token')
  }
})

// The core exploit this closes: an attacker with their OWN valid token spoofs
// another user's id in the request body (e.g. `{ userId: "victim-id" }`) to
// read or act on that victim's Stripe subscription/customer-portal/checkout.
Deno.test('rejects when body-supplied userId does not match the verified token owner', async () => {
  const result = await requireVerifiedUser(reqWithAuth('valid-token'), fakeSupabase(), 'someone-elses-id')
  assertEquals(result, { ok: false, status: 403, error: 'user_mismatch' })
})

Deno.test('accepts a valid token whose claimed userId matches the token owner', async () => {
  const result = await requireVerifiedUser(reqWithAuth('valid-token'), fakeSupabase(), REAL_USER_ID)
  assertEquals(result, { ok: true, user: { id: REAL_USER_ID, email: 'real@example.com' } })
})

Deno.test('accepts a valid token with no claimed userId at all', async () => {
  const result = await requireVerifiedUser(reqWithAuth('valid-token'), fakeSupabase())
  assertEquals(result, { ok: true, user: { id: REAL_USER_ID, email: 'real@example.com' } })
})
