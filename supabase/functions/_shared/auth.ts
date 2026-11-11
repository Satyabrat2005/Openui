// Shared object-level-authorization helper for Supabase Edge Functions.
//
// Several billing endpoints (create-checkout, check-subscription,
// customer-portal) used to read `userId` straight out of the unauthenticated
// request body and trust it — letting any caller query or mutate another
// user's Stripe subscription just by passing their id in the JSON payload.
// chat-proxy already did this correctly (verify the bearer token via
// supabase.auth.getUser(token) and use the resolved user, never the body).
// This module centralizes that pattern so the billing endpoints match it.

export interface VerifiedUser {
  id: string
  email?: string
}

// Minimal shape of the subset of the supabase-js client this helper needs,
// so tests can pass a lightweight fake instead of a real network-backed client.
export interface AuthClient {
  auth: {
    getUser(token: string): Promise<{
      data: {
        user: { id: string; email?: string; is_anonymous?: boolean; email_confirmed_at?: string | null } | null
      }
      error: unknown
    }>
  }
}

export type AuthResult =
  | { ok: true; user: VerifiedUser }
  | { ok: false; status: 401 | 403; error: string }

/**
 * Verifies the caller's Supabase access token from the Authorization header.
 * If the caller also supplied a `claimedUserId` (e.g. a `userId` field in the
 * request body), it must match the verified id — otherwise the request is
 * rejected with 403 rather than silently trusting the body value.
 */
export async function requireVerifiedUser(
  req: Request,
  supabase: AuthClient,
  claimedUserId?: string,
  opts: { requireAccount?: boolean } = {}
): Promise<AuthResult> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return { ok: false, status: 401, error: 'missing_token' }

  const { data, error } = await supabase.auth.getUser(token)
  const user = data?.user
  if (error || !user) return { ok: false, status: 401, error: 'invalid_token' }

  if (claimedUserId && claimedUserId !== user.id) {
    return { ok: false, status: 403, error: 'user_mismatch' }
  }

  // A real, confirmed account — not an anonymous guest session (anyone can mint
  // those with the public anon key) and not an email nobody has proved they
  // own. With email confirmation switched off, Supabase sets
  // email_confirmed_at at sign-up, so this only bites when confirmation is on.
  if (opts.requireAccount) {
    if (user.is_anonymous) return { ok: false, status: 403, error: 'account_required' }
    if (!user.email || !user.email_confirmed_at) return { ok: false, status: 403, error: 'email_not_confirmed' }
  }

  return { ok: true, user: { id: user.id, email: user.email } }
}
