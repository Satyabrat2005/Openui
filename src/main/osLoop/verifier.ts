/**
 * verifier.ts — did the action we just executed actually do what we intended?
 *
 * The loop previously had no answer to this. It clicked, slept, screenshotted,
 * and handed the new frame back to the model, which meant a missed click cost a
 * full vision round-trip to notice and was frequently just repeated. Verifying
 * locally against a pixel diff is both faster and cheaper than asking the model,
 * and it produces a concrete signal ("nothing changed") that we can feed back
 * into the prompt so the model stops repeating a step that does not work.
 *
 * Pure module: takes an action plus a precomputed FrameDiff/OCR lines and
 * returns a verdict. No capture, no input synthesis, no model calls.
 */
import type { VisionAction } from '../visionAction'
import { boxContains, textContains, type FrameDiff } from './frameState'

/**
 * confirmed          — the screen changed in a way consistent with the action.
 * no-change          — the screen is effectively identical; the action did not
 *                      take (missed target, unfocused window, dead control).
 * unexpected-change  — the screen changed, but not where we aimed. Often a
 *                      real effect (a menu opened elsewhere), sometimes a
 *                      misfire, so it is reported but NOT treated as failure.
 */
export type Verdict = 'confirmed' | 'no-change' | 'unexpected-change'

export interface VerificationResult {
  verdict: Verdict
  /** One-line, model-facing explanation appended to the action history. */
  detail: string
}

export interface VerifyOptions {
  /**
   * Below this fraction of changed pixels the frame counts as unchanged.
   *
   * Not zero: a blinking text caret, a clock in the system tray, or a hover
   * highlight all flip a handful of pixels every frame, so an exact-equality
   * test would call every frame "changed" and verify nothing. 0.0005 of a
   * 1920×1080 frame is ~1000 pixels — larger than a caret, far smaller than
   * any real UI response.
   */
  noChangeRatio?: number
  /**
   * How far from the click point the change may be centred and still count as
   * "where we aimed". Generous because clicking a menu item changes the whole
   * dropdown, not just the pixels under the cursor.
   */
  clickRadiusPx?: number
}

const DEFAULT_NO_CHANGE_RATIO = 0.0005
const DEFAULT_CLICK_RADIUS_PX = 250

/**
 * Judge one executed action against the before/after frame diff.
 *
 * `afterLines` / `beforeLines` are OCR text for the two frames; they are only
 * consulted for `type` actions, where text appearing on screen is much stronger
 * evidence than pixel churn (which a caret alone can produce).
 */
export function verifyAction(
  action: VisionAction,
  diff: FrameDiff,
  opts: VerifyOptions & { beforeLines?: readonly string[]; afterLines?: readonly string[] } = {}
): VerificationResult {
  const noChangeRatio = opts.noChangeRatio ?? DEFAULT_NO_CHANGE_RATIO
  const clickRadius = opts.clickRadiusPx ?? DEFAULT_CLICK_RADIUS_PX
  const changed = diff.changedRatio > noChangeRatio
  const pct = (diff.changedRatio * 100).toFixed(2)

  switch (action.action) {
    case 'click': {
      if (!changed) {
        return {
          verdict: 'no-change',
          detail: `the screen did not change after clicking (${pct}% of pixels differ) — the click probably missed its target`
        }
      }
      const { changeBox } = diff
      const x = action.x ?? 0
      const y = action.y ?? 0
      if (changeBox && boxContains(changeBox, x, y, clickRadius)) {
        return { verdict: 'confirmed', detail: `the screen changed near (${x},${y}) as expected` }
      }
      return {
        verdict: 'unexpected-change',
        detail:
          `the screen changed, but away from the click point (${x},${y}) — ` +
          `the change is centred at (${diff.changeCentre?.x ?? '?'},${diff.changeCentre?.y ?? '?'})`
      }
    }

    case 'type': {
      const typed = action.text ?? ''
      // Positive evidence first: the typed string is now visible on screen.
      if (opts.afterLines && textContains(opts.afterLines, typed)) {
        return { verdict: 'confirmed', detail: `the typed text is now visible on screen` }
      }
      if (!changed) {
        return {
          verdict: 'no-change',
          detail:
            `the screen did not change after typing (${pct}% of pixels differ) — ` +
            'no field was focused, or the keystrokes went nowhere'
        }
      }
      // Changed, but we could not read the text back. Short strings and
      // password fields legitimately land here, so this is not a failure.
      return {
        verdict: 'confirmed',
        detail: `the screen changed after typing (text could not be read back to confirm)`
      }
    }

    case 'key':
    case 'scroll': {
      const what = action.action === 'key' ? `pressing ${(action.keys ?? []).join('+')}` : `scrolling ${action.direction}`
      if (!changed) {
        return {
          verdict: 'no-change',
          detail: `the screen did not change after ${what} (${pct}% of pixels differ)`
        }
      }
      // Neither keys nor scrolling have an aim point, so any real change is
      // consistent with the intent — there is nothing to be "off-target" from.
      return { verdict: 'confirmed', detail: `the screen changed after ${what}` }
    }

    default:
      // done/fail terminate the loop and are never verified.
      return { verdict: 'confirmed', detail: 'terminal action; nothing to verify' }
  }
}

/** True for verdicts the retry policy should treat as a failed step. */
export function isFailure(verdict: Verdict): boolean {
  return verdict === 'no-change'
}
