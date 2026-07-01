/**
 * pricing.ts — the single source of truth for OpenUI's subscription tiers, the
 * models each tier may use, and the helpers that gate model routing.
 *
 * CLOUD-ONLY MODEL: every tier — including Free — is served exclusively through
 * OUR cloud backend (the `chat-proxy` Supabase Edge Function, which holds our API
 * keys server-side). There is no local-model / Ollama routing path anywhere in
 * the app: every chat and voice turn is metered against the limits below, with no
 * way for a user to self-host a model to escape the cap.
 *
 * Each tier declares a `dailyMessageLimit` (cloud messages/day) and a
 * `monthlyVoiceMinutes` cap (voice/interview minutes per calendar month), both
 * enforced server-side against the `usage_tracking` / `voice_usage` tables. The
 * `models` map lists the cloud models the tier may request via the proxy.
 *
 * SECURITY: Stripe *price ids* (`price_…`) are NOT secret — they are safe to ship
 * in the Electron app and are used only to tell the `create-checkout` Edge
 * Function which price the user picked. The Stripe *secret key* never appears
 * here (or anywhere in the Electron app); it lives only in Supabase Edge Function
 * secrets. See `.env.example` and `supabase/functions/README.md`.
 */
import { database } from '../database'

export const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    description: 'Get started with AI assistance — no setup required',
    features: [
      '5 cloud messages per day',
      '120 voice minutes per month',
      'Basic OS automation',
      'Local OCR screen reading',
      'Voice input'
    ],
    dailyMessageLimit: 5,
    monthlyVoiceMinutes: 120,
    models: {
      cloud: ['claude-3-5-haiku']
    },
    stripePriceId: null // No Stripe price for free
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 19,
    description: 'Advanced AI with cloud models and vision',
    features: [
      '500 cloud messages per day',
      '600 voice minutes per month',
      'Claude 3.5 Sonnet + GPT-4o',
      'Cloud vision (screen understanding)',
      'Advanced multi-step automation',
      'Priority processing'
    ],
    dailyMessageLimit: 500,
    monthlyVoiceMinutes: 600,
    models: {
      cloud: ['claude-3-5-sonnet', 'gpt-4o']
    },
    stripePriceId: process.env.STRIPE_PRO_PRICE_ID
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 49,
    description: 'Maximum power with custom models',
    features: [
      'Unlimited cloud messages',
      'Unlimited voice minutes',
      'GLM 5.2 + all premium models',
      'Unlimited vision calls',
      'Workflow chaining',
      'Custom MCP servers',
      'Priority support'
    ],
    dailyMessageLimit: Infinity,
    monthlyVoiceMinutes: Infinity,
    models: {
      cloud: ['glm-5.2', 'claude-3-5-sonnet', 'gpt-4o']
    },
    stripePriceId: process.env.STRIPE_ENTERPRISE_PRICE_ID
  }
} as const

export type TierId = keyof typeof TIERS

/** Ordered low→high so we can compare "is tier A at least tier B". */
const TIER_RANK: Record<TierId, number> = { free: 0, pro: 1, enterprise: 2 }

/** Is `model` allowed for `tier`? True only when it's in the tier's `models.cloud` list. */
export function isModelAllowedForTier(model: string, tier: TierId): boolean {
  const def = TIERS[tier]
  if (!def) return false
  const cloud = def.models.cloud as readonly string[]
  return cloud.includes(model)
}

/** The maximum cloud messages a tier may send per day (Infinity = unlimited). */
export function dailyMessageLimit(tier: TierId): number {
  return TIERS[tier]?.dailyMessageLimit ?? TIERS.free.dailyMessageLimit
}

/** The maximum voice/interview minutes a tier may use per calendar month (Infinity = unlimited). */
export function monthlyVoiceMinuteLimit(tier: TierId): number {
  return TIERS[tier]?.monthlyVoiceMinutes ?? TIERS.free.monthlyVoiceMinutes
}

/**
 * How long a cached tier may be trusted once Supabase becomes unreachable.
 * Beyond this we refuse to keep "unlocking" paid features and fall back to free.
 * Seconds, to match the `subscription_cache` schema (epoch SECONDS).
 */
export const MAX_CACHE_STALENESS_SEC = 24 * 60 * 60

function coerceTier(value: string | null | undefined): TierId {
  return value === 'pro' || value === 'enterprise' ? value : 'free'
}

/**
 * Best-effort, synchronous read of a user's tier from the local subscription
 * cache (the shared `database.subscriptions` repo). Returns 'free' when there is
 * no cached row, when the paid period has ended, OR when the row is older than
 * `MAX_CACHE_STALENESS_SEC` — i.e. we never trust a stale cache to unlock paid
 * features. For an authoritative value, call `syncSubscriptionStatus()` instead.
 */
export function getTierForUser(userId: string): TierId {
  const sub = database.subscriptions.getCachedSubscription(userId)
  if (!sub?.tier) return 'free'
  const nowSec = Math.floor(Date.now() / 1000)
  // Paid period has ended → downgrade (matches sessionManager.getUserTier).
  if (sub.current_period_end != null && sub.current_period_end <= nowSec) return 'free'
  // Stale cache (>24h since last sync) → don't trust it to unlock paid features.
  if (nowSec - sub.updated_at > MAX_CACHE_STALENESS_SEC) return 'free'
  return coerceTier(sub.tier)
}

/**
 * Clamp a *requested* tier down to what the user is actually entitled to.
 *
 * SECURITY: the chat/voice IPC carries a `tier` chosen by the (untrusted)
 * renderer. This prevents a compromised renderer from escalating itself to Pro/
 * Enterprise: a signed-in user can never route above their verified entitlement.
 * When there is no signed-in user (e.g. local dev before auth lands) we leave the
 * requested tier untouched so local development isn't blocked.
 */
export function clampTierToEntitlement(requested: TierId, userId: string | null): TierId {
  if (!userId) return requested
  const entitled = getTierForUser(userId)
  return TIER_RANK[requested] <= TIER_RANK[entitled] ? requested : entitled
}
