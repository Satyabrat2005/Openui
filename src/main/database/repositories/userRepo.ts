import { getDb } from '../init'

export interface UserRow {
  id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  tier: string
  stripe_customer_id: string | null
  auth_token: string | null
  refresh_token: string | null
  token_expires_at: number | null
  created_at: number
  updated_at: number
}

export interface UserData {
  id: string
  email?: string
  displayName?: string
  avatarUrl?: string
  tier?: string
  stripeCustomerId?: string
}

export function upsertUser(userData: UserData): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, email, display_name, avatar_url, tier, stripe_customer_id, updated_at)
       VALUES (@id, @email, @displayName, @avatarUrl, @tier, @stripeCustomerId, strftime('%s','now'))
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         tier = excluded.tier,
         stripe_customer_id = excluded.stripe_customer_id,
         updated_at = strftime('%s','now')`
    )
    .run({
      id: userData.id,
      email: userData.email ?? null,
      displayName: userData.displayName ?? null,
      avatarUrl: userData.avatarUrl ?? null,
      tier: userData.tier ?? 'free',
      stripeCustomerId: userData.stripeCustomerId ?? null
    })
}

export function getUserById(id: string): UserRow | null {
  return (getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null
}

export function updateUserTier(userId: string, tier: string): void {
  getDb()
    .prepare(`UPDATE users SET tier = ?, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(tier, userId)
}

export function updateAuthTokens(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number
): void {
  getDb()
    .prepare(
      `UPDATE users
       SET auth_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = strftime('%s','now')
       WHERE id = ?`
    )
    .run(accessToken, refreshToken, expiresAt, userId)
}

export function getValidToken(userId: string): string | null {
  const row = getDb()
    .prepare('SELECT auth_token, token_expires_at FROM users WHERE id = ?')
    .get(userId) as { auth_token: string | null; token_expires_at: number | null } | undefined
  if (!row?.auth_token || !row.token_expires_at) return null
  if (row.token_expires_at <= Math.floor(Date.now() / 1000)) return null
  return row.auth_token
}

export function deleteUser(userId: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId)
}
