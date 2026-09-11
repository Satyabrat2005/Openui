/**
 * usageRepo.ts — the local daily usage counter.
 *
 * One row per calendar day the user sent at least one turn. Rows are kept, not
 * rolled over: the day's count enforces the allowance, and the history is the
 * only thing that can answer how regularly someone actually uses OpenUI.
 *
 * See usageMeter.ts for what counts as a turn, and for why this number is a
 * product boundary rather than a security one.
 */
import { getDb } from '../init'

export interface UsageDay {
  day: string
  message_count: number
  voice_count: number
  first_at: number | null
  last_at: number | null
}

/** One day's row, or undefined for a day with no activity. */
export function getDay(day: string): UsageDay | undefined {
  return getDb().prepare('SELECT * FROM usage_daily WHERE day = ?').get(day) as UsageDay | undefined
}

/**
 * Add one to a day's counter, creating the row on first use.
 *
 * `first_at` is written only on insert (COALESCE keeps the original on
 * conflict), so it records when the day actually started rather than being
 * overwritten by every later turn.
 */
export function increment(day: string, kind: 'message' | 'voice', atEpochSeconds: number): void {
  const col = kind === 'voice' ? 'voice_count' : 'message_count'
  getDb()
    .prepare(
      `INSERT INTO usage_daily (day, message_count, voice_count, first_at, last_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         ${col} = ${col} + 1,
         first_at = COALESCE(usage_daily.first_at, excluded.first_at),
         last_at = excluded.last_at`
    )
    .run(day, kind === 'voice' ? 0 : 1, kind === 'voice' ? 1 : 0, atEpochSeconds, atEpochSeconds)
}

/**
 * The most recent `n` days that have a row, newest first.
 *
 * Ordered by the `day` string, which sorts chronologically because the format
 * is zero-padded YYYY-MM-DD — the reason that format was chosen over anything
 * more readable.
 */
export function recentDays(n: number): UsageDay[] {
  return getDb()
    .prepare('SELECT * FROM usage_daily ORDER BY day DESC LIMIT ?')
    .all(n) as UsageDay[]
}

/** Wipe the history. Exposed so "clear my usage data" is a real, complete action. */
export function clearAll(): void {
  getDb().prepare('DELETE FROM usage_daily').run()
}
