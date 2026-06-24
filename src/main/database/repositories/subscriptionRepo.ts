import { getDb } from '../init'

export interface SubscriptionRow {
  user_id: string
  tier: string | null
  stripe_status: string | null
  current_period_end: number | null
  updated_at: number
}

export function cacheSubscription(
  userId: string,
  tier: string,
  stripeStatus: string,
  periodEnd: number
): void {
  getDb()
    .prepare(
      `INSERT INTO subscription_cache (user_id, tier, stripe_status, current_period_end, updated_at)
       VALUES (?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         tier = excluded.tier,
         stripe_status = excluded.stripe_status,
         current_period_end = excluded.current_period_end,
         updated_at = strftime('%s','now')`
    )
    .run(userId, tier, stripeStatus, periodEnd)
}

export function getCachedSubscription(userId: string): SubscriptionRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM subscription_cache WHERE user_id = ?')
      .get(userId) as SubscriptionRow | undefined) ?? null
  )
}

export function isSubscriptionActive(userId: string): boolean {
  const row = getCachedSubscription(userId)
  if (!row) return false
  const nowSeconds = Math.floor(Date.now() / 1000)
  return (
    row.stripe_status === 'active' &&
    (row.current_period_end == null || row.current_period_end > nowSeconds)
  )
}
