/**
 * fixTracker.ts — notices when the coding agent keeps failing the same way.
 *
 * Part of the structured debug loop (Task §4). Every time a verifier comes back
 * red, the loop parses it into failure signatures (errorParser.ts) and feeds
 * them here. Because the agent must edit and re-run to see a signature a second
 * time, a signature whose count climbs is a "fix" that did not take — the model
 * is re-patching the same spot. This tracker turns that count into an escalation
 * level so the loop can widen the code it shows the model and steer it toward a
 * caller-side root cause instead of the same dead end.
 *
 * Pure: counts in, guidance out. No fs, no model calls.
 */

/** How hard the loop should lean on the model for a given signature. */
export type Escalation =
  /** First (or infrequent) sighting — normal handling. */
  | 'none'
  /** Seen again after an edit — widen context, suggest looking at the caller. */
  | 'widen'
  /** Persisting across several fixes — the local patch is wrong; change approach. */
  | 'root_cause'

/** Attempts at which each level kicks in. */
const WIDEN_AT = 2
const ROOT_CAUSE_AT = 3

export class FixTracker {
  private counts = new Map<string, number>()

  /**
   * Record one failed verifier run's signatures. Call exactly once per red run,
   * before reading back escalation — each call is "the agent tried again and
   * this is still failing", so every present signature is incremented.
   */
  observeFailures(signatures: readonly string[]): void {
    for (const sig of new Set(signatures)) {
      this.counts.set(sig, (this.counts.get(sig) ?? 0) + 1)
    }
  }

  /** How many red runs have carried this signature. */
  attempts(signature: string): number {
    return this.counts.get(signature) ?? 0
  }

  /** Escalation level for one signature, derived from its attempt count. */
  escalationFor(signature: string): Escalation {
    const n = this.attempts(signature)
    if (n >= ROOT_CAUSE_AT) return 'root_cause'
    if (n >= WIDEN_AT) return 'widen'
    return 'none'
  }

  /**
   * Lines of surrounding code to fetch for a signature. Grows with recurrence so
   * a bug that keeps coming back is shown in progressively wider context (the
   * real cause may be above/below the reported line, or in the caller).
   */
  readRadiusFor(signature: string): number {
    switch (this.escalationFor(signature)) {
      case 'root_cause':
        return 45
      case 'widen':
        return 22
      default:
        return 10
    }
  }

  /**
   * A short instruction to append to the tool result when a signature is
   * recurring, or null when nothing is stuck yet. Names the file:line so the
   * model knows which failure the escalation is about.
   */
  guidanceFor(signature: string): string | null {
    const n = this.attempts(signature)
    const where = signature.split('|')[0]
    if (this.escalationFor(signature) === 'root_cause') {
      return (
        `⚠ This failure at ${where} has survived ${n} fixes. Stop re-patching the same spot — ` +
        `the root cause is almost certainly elsewhere. Read the CALLER(s) of this code and the ` +
        `values flowing in, question an assumption you have been treating as fixed, and consider a ` +
        `different approach rather than another local edit.`
      )
    }
    if (this.escalationFor(signature) === 'widen') {
      return (
        `⚠ The same failure at ${where} came back after your last edit. Your fix did not address ` +
        `the real cause. Look wider than the reported line — check where this value is produced or ` +
        `called from before editing again.`
      )
    }
    return null
  }
}
