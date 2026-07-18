/**
 * retry.ts — what to do when an action fails verification.
 *
 * Two failure modes have to be told apart. A click that missed because the UI
 * had not finished painting is worth repeating verbatim after a short wait —
 * cheap, no model call. A click that missed because the model picked the wrong
 * coordinates will fail identically forever, so repeating it is wasted time and
 * the model must be told what happened and asked for a different approach.
 *
 * The policy: retry the same action ONCE with backoff (covers the timing case),
 * then escalate to the model with the failure detail attached (covers the wrong-
 * coordinates case), and hard-stop the whole loop after MAX_CONSECUTIVE_FAILURES
 * distinct failed steps so a stuck loop cannot burn iterations or vision spend
 * indefinitely.
 *
 * Pure state machine — no timers, no I/O. The caller performs the sleep.
 */

/** Consecutive failed steps before the loop aborts entirely. */
export const MAX_CONSECUTIVE_FAILURES = 3

/** Same-action retries before escalating to the model. */
export const MAX_SAME_ACTION_RETRIES = 1

/** Backoff base; attempt N waits BASE * 2^N, capped at MAX_BACKOFF_MS. */
export const BASE_BACKOFF_MS = 400
export const MAX_BACKOFF_MS = 3_000

export interface RetryState {
  /** Failed steps in a row, reset by any successful verification. */
  consecutiveFailures: number
  /** Retries spent on the CURRENT action, reset when the action changes. */
  sameActionRetries: number
}

export type RetryDecision =
  | { kind: 'proceed' }
  | { kind: 'retry-same'; waitMs: number; attempt: number }
  | { kind: 'escalate-to-model'; feedback: string }
  | { kind: 'hard-stop'; reason: string }

export function initialRetryState(): RetryState {
  return { consecutiveFailures: 0, sameActionRetries: 0 }
}

/**
 * Exponential backoff for retry `attempt` (0-based), capped.
 *
 * Capped rather than unbounded because these waits sit in front of a human
 * watching their own cursor move; a 30-second freeze reads as a hang even if it
 * would eventually succeed.
 */
export function backoffMs(attempt: number): number {
  if (attempt < 0) return BASE_BACKOFF_MS
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt)
}

/**
 * Advance the retry state after one verified step.
 *
 * `failed` comes from verifier.isFailure(). `detail` is the verifier's
 * human-readable explanation, forwarded to the model on escalation so it can
 * see WHY the step did not take rather than just that it did not.
 */
export function nextDecision(
  state: RetryState,
  failed: boolean,
  detail: string
): { state: RetryState; decision: RetryDecision } {
  if (!failed) {
    // Any success clears both counters: the loop is making progress again.
    return {
      state: { consecutiveFailures: 0, sameActionRetries: 0 },
      decision: { kind: 'proceed' }
    }
  }

  const consecutiveFailures = state.consecutiveFailures + 1

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      state: { consecutiveFailures, sameActionRetries: state.sameActionRetries },
      decision: {
        kind: 'hard-stop',
        reason:
          `${consecutiveFailures} consecutive actions had no effect on the screen. ` +
          `Last failure: ${detail}`
      }
    }
  }

  if (state.sameActionRetries < MAX_SAME_ACTION_RETRIES) {
    const attempt = state.sameActionRetries
    return {
      state: { consecutiveFailures, sameActionRetries: attempt + 1 },
      decision: { kind: 'retry-same', waitMs: backoffMs(attempt), attempt: attempt + 1 }
    }
  }

  // Same action has already been retried — stop guessing and ask the model.
  return {
    state: { consecutiveFailures, sameActionRetries: 0 },
    decision: {
      kind: 'escalate-to-model',
      feedback: `The previous action did not work: ${detail}. Choose a DIFFERENT approach — do not repeat it.`
    }
  }
}
