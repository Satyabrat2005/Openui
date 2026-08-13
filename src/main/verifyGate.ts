/**
 * verifyGate.ts — makes "I built it" mean "I ran it".
 *
 * Both coding loops (the unattended runner in autonomous.ts and the interactive
 * builder in agent.ts) end a turn the same way: the model either calls a tool or
 * replies in prose, and prose means "I'm done". Nothing checked that the model
 * had actually run anything, which left two ways to report a success that was
 * never observed:
 *
 *   1. Never verify at all. Write files, reply "I built your site!", stop.
 *   2. Verify, then keep editing. `run_tests` goes green, the model then fixes a
 *      typo with edit_file and declares victory. The green run described a tree
 *      that no longer exists.
 *
 * This gate closes both. It watches every tool result: a passing verifier sets
 * the verified flag, and ANY later change to the source tree clears it again
 * (see mutatesWorkspace). When the model tries to finish with unverified work,
 * the gate answers 'nudge' — the loop pushes back, naming the verifier this
 * project type expects, and keeps going. Nudges are capped so a model that
 * simply refuses cannot spin the loop; after that the run ends honestly as a
 * failure rather than a fake pass.
 *
 * Deliberately pure: no Electron, no filesystem, no model calls. The rule that
 * decides whether we shipped something we never ran is worth testing directly.
 */
import { mutatesWorkspace } from './codingTools'

/**
 * The verification contract for one project type. Structurally satisfied by
 * ProjectProfile, so a profile can be passed straight in.
 */
export interface VerificationSpec {
  /** Tool names that count as verification here, e.g. ['run_tests']. */
  verifiers: readonly string[]
  /** 'pass'/'fail' when `tool` IS a verifier for this type, null otherwise. */
  verdict(tool: string, output: string): 'pass' | 'fail' | null
}

/** What the loop should do with a plain-prose (non-tool-call) reply. */
export type FinalDecision =
  /** The model said "GIVE UP:" — honour it and stop. */
  | 'give_up'
  /** Nothing unverified is outstanding (or we're out of nudges): let it finish. */
  | 'accept'
  /** Unverified work exists — push back and keep the loop running. */
  | 'nudge'

/** How many times we'll ask the model to verify before letting the run end red. */
const DEFAULT_MAX_NUDGES = 2

/** Grounds on which a "GIVE UP:" reply is challenged once before being honoured. */
export type GiveUpChallenge =
  /** A verifier passed against the tree as it stands — the give-up contradicts it. */
  | 'contradicted'
  /** Files were written but nothing was ever verified — the give-up is a guess. */
  | 'untested'

export class VerifyGate {
  /** A verifier passed AND nothing has touched the tree since. */
  private verified = false
  /** Whether any tool has ever changed the source tree in this run. */
  private touchedTree = false
  private nudgesUsed = 0

  constructor(
    private readonly spec: VerificationSpec,
    private readonly maxNudges: number = DEFAULT_MAX_NUDGES
  ) {}

  /**
   * Feed every tool result through this, in order. Failed calls are ignored: a
   * write that errored changed nothing, and a verifier that could not run is not
   * a verdict about the code.
   */
  observe(tool: string, args: Record<string, unknown>, ok: boolean, output: string): void {
    if (!ok) return

    if (mutatesWorkspace(tool, args)) {
      this.touchedTree = true
      // Whatever we knew about this tree is now about a tree that no longer exists.
      this.verified = false
      return
    }

    // A verifier's verdict replaces the previous one in both directions: a later
    // red run must be able to un-verify an earlier green one.
    const verdict = this.spec.verdict(tool, output)
    if (verdict !== null) this.verified = verdict === 'pass'
  }

  /** True when a verifier passed and the tree has not changed since. */
  get isVerified(): boolean {
    return this.verified
  }

  /**
   * True when the model wrote code that no passing verifier has since covered.
   * A run that never touched the tree has nothing to verify, so it is not
   * "unverified" — that would trap read-only tasks in a nudge loop.
   */
  get hasUnverifiedWork(): boolean {
    return this.touchedTree && !this.verified
  }

  /**
   * Decide what to do about a prose reply. Consumes a nudge when it returns
   * 'nudge', so calling this twice for the same reply will eventually exhaust
   * the budget — call it exactly once per prose turn.
   */
  onFinalReply(responseText: string): FinalDecision {
    if (/^\s*GIVE UP:/i.test(responseText)) {
      if (this.giveUpChallenge(responseText)) {
        this.nudgesUsed++
        return 'nudge'
      }
      return 'give_up'
    }
    if (!this.hasUnverifiedWork) return 'accept'
    if (this.nudgesUsed >= this.maxNudges) return 'accept'
    this.nudgesUsed++
    return 'nudge'
  }

  /**
   * Whether this GIVE UP should be challenged once before it is honoured, and
   * on what grounds. Null means honour it immediately.
   *
   * Both grounds were measured on merged main, where GIVE UP accounted for 8 of
   * 18 builder runs and 6 of those had already written files:
   *
   *   'contradicted' — a verifier PASSED against the code exactly as it stands,
   *     and the model declared defeat anyway. Observed shape: write index.html →
   *     open_in_browser → list_files (which IS the website profile's verifier,
   *     and passes) → "GIVE UP: there are no tests or scripts to run".
   *
   *   'untested' — files were written but no verifier was ever run, so the
   *     give-up is a guess about work nobody checked. Observed shape: the model
   *     recites the profile's own guidance ("calling list_files counts as
   *     verification for a static site") and then gives up instead of calling it.
   *
   * A run that never touched the tree is NOT challenged: nothing was built, so
   * "I can't do this" is a real answer, not a false negative.
   *
   * Challenging costs one turn and never invents a pass — if the model gives up
   * again the answer stands, so a genuinely broken build still terminates.
   */
  giveUpChallenge(responseText: string): GiveUpChallenge | null {
    if (!/^\s*GIVE UP:/i.test(responseText)) return null
    if (this.nudgesUsed >= this.maxNudges) return null
    if (this.verified) return 'contradicted'
    if (this.touchedTree) return 'untested'
    return null
  }

  /** Pushback text for a challenged GIVE UP. */
  giveUpMessage(kind: GiveUpChallenge): string {
    const named = this.spec.verifiers.length ? this.spec.verifiers.join(' / ') : 'the verification tool'
    if (kind === 'contradicted') {
      return (
        `You said GIVE UP, but ${named} already passed against the project exactly as it stands now — ` +
        'nothing is failing. If the work is done, do NOT give up: reply in plain natural language ' +
        'summarising what you built, and say plainly what was and was not exercised (for example that ' +
        'a static site has no test suite and was not smoke-run). Only give up again if something is ' +
        'genuinely broken, and name it.'
      )
    }
    return (
      'You said GIVE UP, but you have written files and never ran a single verification, so nothing ' +
      `has actually failed yet — you are guessing. Call ${named} now and read the result. ` +
      'If this is a static site with no test suite, list_files is the verification for it: call it, ' +
      'then finish with a plain summary saying the site is static and was not smoke-run. ' +
      'Only give up if a verifier actually reports a failure you cannot fix.'
    )
  }

  /** Short label for the task-list row shown while the gate is pushing back. */
  get nudgeLabel(): string {
    return 'Verification required'
  }

  /**
   * The message pushed back into the conversation on a 'nudge'. It names this
   * project type's verifier so the model does not have to guess which tool the
   * loop is watching, and it leaves GIVE UP available so an impossible task can
   * still terminate honestly.
   */
  nudgeMessage(): string {
    const tools = this.spec.verifiers
    const named =
      tools.length === 0
        ? 'the verification tool for this project'
        : tools.length === 1
          ? tools[0]
          : `${tools.slice(0, -1).join(', ')} or ${tools[tools.length - 1]}`
    return (
      'You replied with a summary, but you have changed files since the last passing ' +
      'verification — nothing yet shows the project still works. Do not summarise yet.\n' +
      `Call ${named} now, read the output, and fix any failure with edit_file before finishing.\n` +
      'If the task genuinely cannot be made to pass, reply in plain text starting with "GIVE UP:" ' +
      'and explain why. Never claim a result you did not observe in this workspace.'
    )
  }
}
