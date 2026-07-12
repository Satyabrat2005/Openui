/**
 * preconditionClassifier.ts — recognizes "this will never work without setup"
 * tool errors, distinct from ordinary transient/tool-misuse failures.
 *
 * Missing an app, a connection, a config value, or a subscription tier is not
 * something retrying the same tool call again will fix. The general
 * OS-automation loop in agent.ts uses this to stop and explain instead of
 * silently burning its whole turn budget retrying an identical blocker.
 *
 * Deliberately pure and narrow: a false negative just means the loop runs its
 * normal course (today's behavior); a false positive would cut off a retry
 * that might have actually succeeded, so the patterns below stick to the
 * concrete phrasings tools in this codebase are known to emit rather than
 * guessing at generic failure language.
 */

const PRECONDITION_PATTERNS: RegExp[] = [
  /is not connected/i,
  /is not configured/i,
  /is not installed/i,
  /not installed or not on PATH/i,
  /No browser session is connected/i,
  /Could not find an application named/i,
  /requires a Pro subscription/i,
  /requires an? .* subscription/i,
  /Upgrade to (Pro|Enterprise)/i,
  /voice limit reached/i,
  /is not configured on the server/i,
  /is temporarily unavailable/i
]

/** True when `error` describes a missing precondition rather than a one-off failure. */
export function looksLikeMissingPrecondition(error: string | null | undefined): boolean {
  if (!error) return false
  return PRECONDITION_PATTERNS.some((re) => re.test(error))
}
