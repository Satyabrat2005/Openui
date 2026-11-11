/**
 * oauthGuard.ts — `state` and PKCE for the Google connect flows (Gmail,
 * Calendar, Drive).
 *
 * Each flow listens on a 127.0.0.1 port for Google's redirect. Without a
 * `state` check, anything that can make a request to that port while it waits
 * — another program, or a web page the browser has open — could hand the app
 * an authorization code for the SENDER's Google account (the app would then
 * read and send mail as that account), or end the flow early with `?error=`.
 * Without PKCE, a code intercepted on the way could be redeemed elsewhere.
 * Both are what Google recommends for installed apps.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface OAuthGuard {
  /** Sent with the request and required, unchanged, on the redirect. */
  state: string
  /** Kept in memory; sent only with the token exchange. */
  codeVerifier: string
  /** SHA-256 of the verifier, sent with the authorization request. */
  codeChallenge: string
}

export function newOAuthGuard(): OAuthGuard {
  const state = randomBytes(24).toString('base64url')
  // 64 characters: inside PKCE's 43–128 range.
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { state, codeVerifier, codeChallenge }
}

/** Constant-time comparison of the redirect's `state` with ours. */
export function stateMatches(expected: string, received: string | null): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Adds the guard to an authorization URL's query. */
export function addGuardToAuthParams(params: URLSearchParams, guard: OAuthGuard): void {
  params.set('state', guard.state)
  params.set('code_challenge', guard.codeChallenge)
  params.set('code_challenge_method', 'S256')
}
