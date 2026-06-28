import { getDb } from '../init'
import { randomUUID } from 'crypto'

/**
 * conversation_feedback — the data layer for OpenUI's automatic self-improvement
 * loop. Each completed assistant turn is stored with an `implicit_rating` (1–5)
 * derived from the user's reaction, and an optional `explicit_rating` from the
 * 👍/👎 buttons. The weekly prompt refiner (promptRefiner.ts) reads the
 * low-rated rows to suggest system-prompt improvements. All of this stays in the
 * local SQLite DB — no rows are uploaded.
 */
export interface FeedbackRow {
  id: string
  conversation_id: string | null
  user_message: string | null
  assistant_response: string | null
  /** 1 (bad) – 5 (great); defaults to a neutral 3 until the next message scores it. */
  implicit_rating: number
  /** 1 (👎) or 5 (👍) when the user clicks a rating button, else null. */
  explicit_rating: number | null
  timestamp: number
}

/** Default (neutral) implicit rating for a freshly recorded turn. */
const NEUTRAL_RATING = 3

/**
 * Record one completed assistant turn. Starts neutral (3); the next user message
 * may upgrade it to 5 or downgrade it to 1 via {@link applySignalToLast}.
 * Returns the new row id.
 */
export function recordTurn(
  conversationId: string | null,
  userMessage: string,
  assistantResponse: string
): string {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO conversation_feedback
         (id, conversation_id, user_message, assistant_response, implicit_rating)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, conversationId, userMessage, assistantResponse, NEUTRAL_RATING)
  return id
}

/**
 * Re-score the most recent turn in a conversation based on the sentiment of the
 * FOLLOWING user message: a negative signal ("no", "wrong", "try again") sets
 * the previous response's implicit_rating to 1; a positive signal ("perfect",
 * "thanks", "yes exactly") sets it to 5. No-op when there is no prior row.
 */
export function applySignalToLast(
  conversationId: string | null,
  signal: 'positive' | 'negative'
): void {
  const rating = signal === 'negative' ? 1 : 5
  // Scope to the conversation when known so a signal can't bleed across threads.
  const last = (
    conversationId
      ? getDb()
          .prepare(
            `SELECT id FROM conversation_feedback
             WHERE conversation_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1`
          )
          .get(conversationId)
      : getDb()
          .prepare(
            `SELECT id FROM conversation_feedback
             ORDER BY timestamp DESC, rowid DESC LIMIT 1`
          )
          .get()
  ) as { id: string } | undefined

  if (!last) return
  getDb()
    .prepare('UPDATE conversation_feedback SET implicit_rating = ? WHERE id = ?')
    .run(rating, last.id)
}

/**
 * Apply an explicit 👍/👎 to the most recently recorded turn (across all
 * conversations — the renderer rates "the last response shown"). Returns the id
 * of the updated row, or null when there is nothing to rate.
 */
export function setExplicitRatingOnLast(rating: 1 | 5): string | null {
  const last = getDb()
    .prepare('SELECT id FROM conversation_feedback ORDER BY timestamp DESC, rowid DESC LIMIT 1')
    .get() as { id: string } | undefined
  if (!last) return null
  getDb()
    .prepare('UPDATE conversation_feedback SET explicit_rating = ? WHERE id = ?')
    .run(rating, last.id)
  return last.id
}

/**
 * Rows the weekly refiner learns from: turns the user reacted poorly to in the
 * window starting at `sinceTs` (unix seconds). A turn counts as "failing" when
 * its implicit_rating is low (≤2) OR the user gave an explicit 👎 (rating 1).
 */
export function getFailingTurnsSince(sinceTs: number): FeedbackRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM conversation_feedback
       WHERE timestamp >= ?
         AND (implicit_rating <= 2 OR explicit_rating = 1)
       ORDER BY timestamp ASC`
    )
    .all(sinceTs) as FeedbackRow[]
}

/** Diagnostics / tests: total recorded turns. */
export function countFeedback(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM conversation_feedback').get() as {
    n: number
  }
  return row.n
}
