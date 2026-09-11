/**
 * usageMeter.ts — how much this person uses OpenUI, and whether their tier
 * still allows the turn they just asked for.
 *
 * WHY THIS IS NOT THE CLOUD METER. `usage_tracking` (Supabase) and
 * `pricing.ts`'s `dailyMessageLimit` meter turns served by OUR API keys through
 * the chat-proxy Edge Function. That path is disabled in the shipped build
 * (`isCloudTierEnabled()` is false), so it currently meters nothing at all:
 * every turn runs locally through Ollama on the user's own hardware, costs us
 * nothing, and never reaches a server that could count it. This module is the
 * meter for THOSE turns, and it is deliberately a separate number with a
 * separate name (`localDailyMessageLimit`) so the two can never be confused.
 *
 * WHAT THIS IS AND IS NOT.
 *
 *   It IS a product boundary — the thing that makes a Free tier mean something
 *   when inference is free to serve, and the record that answers "how often do
 *   people actually use this".
 *
 *   It is NOT a security boundary, and nothing here should be described as one.
 *   The count lives in a SQLite file the user owns, on hardware they control,
 *   next to a model they downloaded. Anyone willing to open `openui.db` can set
 *   it to zero. That is not a flaw to be fixed by hiding the number better —
 *   it is what local inference means. Real enforcement needs the server to hold
 *   something the client cannot proceed without (see the licensed-runtime work);
 *   until then this stops casual overuse, not a determined user, and saying
 *   otherwise in a pitch would be a lie we would get caught in.
 *
 * WHAT COUNTS. One user-initiated chat turn = one message. Internal model calls
 * — the planner, the prompt refiner, each step of an autonomous build — are NOT
 * counted, because a user who asked one question would otherwise watch a "10
 * per day" allowance vanish in a single request through no action of their own.
 * That is why metering lives at `handleChat` and not inside `callModel`.
 */
import { database } from './database'
import { localDailyMessageLimit, type TierId } from './stripe/pricing'
import { trackEvent } from './telemetry/posthog'

/**
 * Today, as the user's calendar sees it.
 *
 * Local time, not UTC: an allowance that resets at the user's midnight is the
 * only version that behaves the way "per day" reads. Using UTC would end the
 * day mid-evening for anyone far enough east, which looks exactly like the
 * counter being broken.
 */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Clamp an arbitrary tier string to a tier we actually know.
 *
 * `getUserTier()` returns a plain string read out of the subscription cache, so
 * an unrecognised value has to resolve to SOMETHING. It resolves to `free`:
 * an unknown tier is the one case where guessing generously would hand out an
 * unlimited allowance on the strength of a corrupt or stale row.
 */
export function normaliseTier(tier: string): TierId {
  return tier === 'pro' || tier === 'enterprise' ? tier : 'free'
}

/** The answer to "may this turn run?", with everything the UI needs to explain it. */
export interface Allowance {
  allowed: boolean
  /** Turns used today, before this one. */
  used: number
  /** The tier's daily cap, or null when unlimited. */
  limit: number | null
  /** Turns left after this one would run, or null when unlimited. */
  remaining: number | null
  unlimited: boolean
  /** Local-time instant the allowance refills (next midnight). */
  resetsAt: number
}

/** Midnight tonight, local time — when a daily allowance turns over. */
export function nextResetAt(now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return d.getTime()
}

/** Turns already used on `day`. Absent row = an unused day, which is 0, not an error. */
export function usedOn(day: string = localDay()): number {
  try {
    const row = database.usage?.getDay(day)
    return row?.message_count ?? 0
  } catch {
    // A meter that throws must never take the chat down with it. An unreadable
    // counter reads as zero: failing OPEN is right here, because the cost of a
    // wrong answer is one extra free turn, while failing closed would lock a
    // paying user out of a product that works entirely on their own machine.
    return 0
  }
}

/**
 * May this tier run another turn today?
 *
 * Checked BEFORE the turn, so `remaining` describes the state the user will be
 * in once it completes — that is the number worth showing them.
 */
export function checkAllowance(tier: TierId | string, now: Date = new Date()): Allowance {
  const limit = localDailyMessageLimit(normaliseTier(tier))
  const used = usedOn(localDay(now))
  const resetsAt = nextResetAt(now)

  if (!Number.isFinite(limit)) {
    return { allowed: true, used, limit: null, remaining: null, unlimited: true, resetsAt }
  }

  const cap = limit as number
  return {
    allowed: used < cap,
    used,
    limit: cap,
    remaining: Math.max(0, cap - used - 1),
    unlimited: false,
    resetsAt
  }
}

/**
 * Record one completed user turn.
 *
 * Called AFTER the allowance check passes, so a refused turn is never counted
 * against the person who was refused it.
 */
export function recordTurn(kind: 'message' | 'voice' = 'message', now: Date = new Date()): void {
  const day = localDay(now)
  try {
    // Is this the first turn of a new day? Checked BEFORE the increment, since
    // afterwards the row always exists.
    const firstOfDay = !database.usage?.getDay(day)
    database.usage?.increment(day, kind, Math.floor(now.getTime() / 1000))
    if (firstOfDay) reportDailyRollup(now)
  } catch (err) {
    // Same reasoning as usedOn: the meter is never allowed to break the chat.
    console.error('[usage] could not record turn:', err)
  }
}

/**
 * Once a day, report how this install is being used — counts only.
 *
 * This is the aggregate that answers "how often do people actually use OpenUI"
 * without a backend of our own: PostHog already carries a consent gate and a
 * scrubber, and `trackEvent` is a no-op when the user has opted out, so the
 * privacy promise is unchanged by adding a number to it.
 *
 * EVERY PROPERTY HERE IS NUMERIC, deliberately. `scrubProperties` only rewrites
 * strings, so a string property is the one way a file path or a display name
 * could leak through this call — and the consent prompt promises we do not
 * collect those. Counts cannot carry a path. Keep it that way: if this ever
 * needs a string, scrub it at the call site and say why.
 *
 * Fired on the first turn of a new day rather than on a timer, so an install
 * that is not being used sends nothing at all — an absent report IS the signal
 * that someone stopped using it.
 */
function reportDailyRollup(now: Date): void {
  try {
    const s = summarise(30, now)
    trackEvent('usage_daily_rollup', {
      active_days_30d: s.activeDays,
      total_messages_30d: s.totalMessages,
      messages_per_active_day: s.messagesPerActiveDay,
      current_streak: s.currentStreak
    })
  } catch {
    // Reporting is never worth a failed turn.
  }
}

/** How a stretch of days was actually used — the frequency question, answered. */
export interface UsageSummary {
  /** Days in the window that saw at least one turn. */
  activeDays: number
  windowDays: number
  totalMessages: number
  /** Mean messages per ACTIVE day — a zero-filled mean would just measure the window. */
  messagesPerActiveDay: number
  /** Consecutive days ending today (or yesterday) with at least one turn. */
  currentStreak: number
  busiestDay: { day: string; messages: number } | null
}

/**
 * Summarise the last `windowDays` days.
 *
 * `messagesPerActiveDay` divides by active days rather than elapsed days on
 * purpose: someone who uses OpenUI hard every Monday is a weekly user with a
 * high intensity, and averaging their traffic across six idle days would report
 * them as a light daily user, which is a different person entirely.
 */
export function summarise(windowDays = 30, now: Date = new Date()): UsageSummary {
  let rows: Array<{ day: string; message_count: number }> = []
  try {
    rows = database.usage?.recentDays(windowDays) ?? []
  } catch {
    rows = []
  }

  const totalMessages = rows.reduce((n, r) => n + r.message_count, 0)
  const active = rows.filter((r) => r.message_count > 0)
  const busiest = active.reduce<{ day: string; messages: number } | null>(
    (best, r) => (best && best.messages >= r.message_count ? best : { day: r.day, messages: r.message_count }),
    null
  )

  // A streak counts backwards from today, but not using OpenUI yet TODAY should
  // not read as a broken streak at 9am — so yesterday is an acceptable start.
  const byDay = new Set(active.map((r) => r.day))
  let streak = 0
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!byDay.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (byDay.has(localDay(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }

  return {
    activeDays: active.length,
    windowDays,
    totalMessages,
    messagesPerActiveDay: active.length ? Number((totalMessages / active.length).toFixed(1)) : 0,
    currentStreak: streak,
    busiestDay: busiest
  }
}

/** Human-readable reason shown when a turn is refused. Never mentions a terminal. */
export function limitReachedMessage(a: Allowance): string {
  const when = new Date(a.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    `You have used all ${a.limit} of today's messages. ` +
    `Your allowance refills at ${when}. Upgrade for more.`
  )
}
