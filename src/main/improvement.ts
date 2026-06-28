/**
 * improvement.ts — shared primitives for OpenUI's automatic self-improvement
 * loop, kept dependency-light (DB only) so both the agent (`agent.ts`) and the
 * weekly refiner (`promptRefiner.ts`) can use them without an import cycle.
 *
 * The loop, end to end:
 *   1. agent.ts records every completed turn into `conversation_feedback` and
 *      scores it from the user's next message (see classifyFeedbackSignal).
 *   2. The 👍/👎 buttons add an explicit rating.
 *   3. promptRefiner.ts, weekly, turns the failing turns into an improved
 *      system prompt stored under CUSTOM_SYSTEM_PROMPT.
 *   4. agent.ts loads that improved prompt on the next turn (see getCustomSystemPrompt).
 *
 * A single user-facing toggle (AI_IMPROVEMENT_ENABLED, default on) gates the
 * *application* of what was learned and the weekly refine job. Raw feedback is
 * still recorded locally regardless, so turning the toggle on later has history
 * to learn from.
 */
import { database } from './database'

export const SETTINGS = {
  /** boolean — master switch for the self-improvement loop (default: true). */
  AI_IMPROVEMENT_ENABLED: 'ai_improvement_enabled',
  /** string — the latest refined system prompt, or unset to use the default. */
  CUSTOM_SYSTEM_PROMPT: 'custom_system_prompt',
  /** number (unix seconds) — when the refiner last ran, to avoid double-runs. */
  LAST_REFINE_AT: 'last_prompt_refine_at'
} as const

/**
 * Whether the self-improvement loop is active. Defaults to ON when the user has
 * never touched the toggle (setting absent → null). Fails safe to ON only when
 * the value is genuinely unset; an explicit `false` disables it.
 */
export function isImprovementEnabled(): boolean {
  try {
    const v = database.settings.getSetting(SETTINGS.AI_IMPROVEMENT_ENABLED)
    return v === null || v === undefined ? true : v === true
  } catch {
    return false
  }
}

/**
 * The refined system prompt to use for this turn, or null to fall back to the
 * built-in default. Returns null when the loop is disabled so toggling off
 * instantly reverts to stock behaviour without deleting what was learned.
 */
export function getCustomSystemPrompt(): string | null {
  try {
    if (!isImprovementEnabled()) return null
    const v = database.settings.getSetting(SETTINGS.CUSTOM_SYSTEM_PROMPT)
    return typeof v === 'string' && v.trim().length > 0 ? v : null
  } catch {
    return null
  }
}

export function setCustomSystemPrompt(prompt: string): void {
  database.settings.setSetting(SETTINGS.CUSTOM_SYSTEM_PROMPT, prompt)
}

// ── Implicit feedback signal detection ────────────────────────────────────────

// Negative reactions. "no" is included but guarded against the common benign
// phrases ("no problem", "no worries") so a polite follow-up isn't read as a
// complaint about the previous answer.
const NEGATIVE_RE =
  /\b(?:no(?!\s+(?:problem|worries|prob|thanks))|nope|nah|wrong|incorrect|that'?s not right|not right|that'?s not what|not what i|try again|didn'?t work|doesn'?t work|does not work|still (?:broken|wrong|failing)|that'?s wrong)\b/i

// Positive reactions.
const POSITIVE_RE =
  /\b(?:perfect|great|thanks|thank you|awesome|amazing|excellent|nice|good job|well done|exactly|that'?s right|that works|works now|love it|brilliant|spot on)\b/i

/**
 * Classify a user message as a reaction to the PREVIOUS assistant turn.
 * Positive takes precedence over negative when both match (e.g. "no problem,
 * thanks!"), and the benign-"no" guard above keeps most false positives out.
 */
export function classifyFeedbackSignal(text: string): 'positive' | 'negative' | null {
  const t = text.trim()
  if (!t) return null
  if (POSITIVE_RE.test(t)) return 'positive'
  if (NEGATIVE_RE.test(t)) return 'negative'
  return null
}
