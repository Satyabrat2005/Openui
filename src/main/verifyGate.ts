/**
 * verifyGate.ts — a small, pure state machine that stops the agent from
 * reporting success it never earned.
 *
 * The failure it guards against: a model (especially a small local one via
 * Ollama) opens an app or writes nothing, then replies in prose — "I built your
 * site!", "Done, it's working now!" — and the loop treats that natural-language
 * reply as an unconditional "task complete" signal. The UI ticks every step
 * green even though no file-writing / action tool ever ran and no verifier ever
 * passed.
 *
 * The gate distinguishes three situations that a bare "the model stopped calling
 * tools" cannot:
 *   1. read-only task, nothing to verify         → accept (nothing was claimed).
 *   2. wrote/changed the tree, never verified it  → NOT done: run a verifier.
 *   3. claimed completion but touched nothing     → NOT done: actually do it.
 *
 * It is deliberately pure (no Electron / IO) so the classification is unit
 * tested in isolation; agent.ts wires it into both the builder session and the
 * general OS-automation loop.
 */

/**
 * Tools whose SUCCESSFUL execution changes the workspace or the outside world.
 * A successful call to one of these is evidence that real work happened. The set
 * spans the sandbox coding toolset, the desktop file tools, and the messaging /
 * browser side-effect tools (some of which live on feature branches — listing a
 * name that isn't registered yet is a harmless no-op).
 */
const MUTATING_TOOLS = new Set<string>([
  // sandbox coding tools
  'write_file',
  'edit_file',
  'install_dependencies',
  // desktop file / clipboard / calendar / input tools
  'create_folder',
  'create_file',
  'delete_file',
  'copy_file',
  'move_file',
  'write_clipboard',
  'control_calendar',
  'type_text',
  // messaging + browser side effects
  'send_whatsapp_message',
  'open_whatsapp_chat',
  'browser_fill_input',
  'browser_click',
  // repo / design side effects
  'create_repo',
  'open_pull_request',
  'post_pr_comment',
  'create_figma_comment',
  'write_spreadsheet',
  'update_cells'
])

/**
 * Tools that, when they PASS, are positive evidence the changed code actually
 * runs. These follow codingTools.ts's convention: they always return ok:true and
 * carry a PASSED/OK-or-FAILED marker in their output text, so "passed" is read
 * from the marker, never from result.ok.
 */
const VERIFIER_TOOLS = new Set<string>([
  'run_script',
  'run_tests',
  'run_pytest',
  'run_python',
  'run_cpp'
])

/** Exact success/failure markers emitted by the coding verifier tools. */
const VERIFIER_FAIL_MARKERS = [
  'TESTS FAILED',
  'PYTEST FAILED',
  'SCRIPT FAILED',
  'PYTHON RUN FAILED',
  'CPP RUN FAILED',
  'INSTALL FAILED'
]
const VERIFIER_PASS_MARKERS = [
  'TESTS PASSED',
  'PYTEST PASSED',
  'SCRIPT OK',
  'PYTHON RUN OK',
  'CPP RUN OK',
  'INSTALL OK'
]

/**
 * Phrases a model uses when it BELIEVES it finished — used to catch a prose
 * reply that claims completion while no mutating tool ever ran. Intentionally
 * broad: the gate only consults this when a side effect was expected, so a
 * false positive at worst costs one extra "are you sure?" round-trip.
 */
const COMPLETION_PATTERNS: RegExp[] = [
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:built|created|made|added|wrote|written|set\s?up|implemented|generated|finished|completed|opened|sent|done)\b/i,
  /\b(?:here'?s|here is)\s+your\b/i,
  /\b(?:it'?s|its|everything'?s|all)\s+(?:working|done|ready|complete|finished|set)\b/i,
  /\b(?:all\s+)?(?:done|finished|completed)\b/i,
  /\byou'?re\s+all\s+set\b/i,
  /\bworking\s+now\b/i,
  /\bhas\s+been\s+(?:built|created|opened|written|set\s?up|completed|sent)\b/i,
  /\bsuccessfully\s+(?:built|created|wrote|written|set\s?up|completed|sent|opened)\b/i,
  /\bthe\s+(?:website|site|app|project|folder|file|code|message)\s+(?:is|has\s+been)\b/i,
  /\b(?:built|created|made|done|finished|completed|ready|sent)\s+it\b/i
]

/** True when a coding verifier's output reports a pass (and not a failure). */
export function verifierPassed(output?: string): boolean {
  if (!output) return false
  if (VERIFIER_FAIL_MARKERS.some((m) => output.includes(m))) return false
  return VERIFIER_PASS_MARKERS.some((m) => output.includes(m))
}

/** A successful call to this tool changes the workspace / the outside world. */
export function mutatesWorkspace(tool: string): boolean {
  return MUTATING_TOOLS.has(tool)
}

/** This tool, when it passes, is evidence the changed code actually runs. */
export function isVerifier(tool: string): boolean {
  return VERIFIER_TOOLS.has(tool)
}

/** A reply that begins with "GIVE UP" is an honest terminal failure, not a claim. */
export function isGiveUp(text: string): boolean {
  return /^\s*give\s?up\b/i.test(text)
}

/** The prose reads like the model thinks it finished the work. */
export function claimsCompletion(text: string): boolean {
  if (isGiveUp(text)) return false
  return COMPLETION_PATTERNS.some((re) => re.test(text))
}

export interface HasUnverifiedOpts {
  /**
   * Whether the task was supposed to have a side effect (a build / write / send).
   * When false, a completion-claiming reply with no mutation is a normal
   * read-only answer and is accepted. Defaults to true (a builder session always
   * expects a side effect).
   */
  sideEffectExpected?: boolean
}

export type VerifyAction = 'accept' | 'nudge' | 'reject'

export interface VerifyDecision {
  action: VerifyAction
  /** Present for 'nudge' (push back to the model) and 'reject' (tell the user). */
  message?: string
}

export interface VerifyGateOptions {
  /** How many times onFinalReply asks the model to continue before giving up. */
  maxNudges?: number
}

/**
 * Tracks evidence of real work across a turn and decides whether a prose "done"
 * reply may be accepted, nudged, or rejected as unverified.
 */
export class VerifyGate {
  private touchedTree = false
  private verified = false
  private nudges = 0
  private readonly maxNudges: number

  constructor(opts: VerifyGateOptions = {}) {
    this.maxNudges = opts.maxNudges ?? 2
  }

  /** Feed every executed tool call so the gate can accumulate evidence. */
  recordToolCall(tool: string, result: { ok: boolean; output?: string }): void {
    if (mutatesWorkspace(tool) && result.ok) {
      this.touchedTree = true
      // A fresh mutation invalidates any earlier green verifier: what passed is
      // no longer what's on disk, so the work must be re-verified.
      this.verified = false
    }
    if (isVerifier(tool) && verifierPassed(result.output)) {
      this.verified = true
    }
  }

  get touchedWorkspace(): boolean {
    return this.touchedTree
  }

  get isVerified(): boolean {
    return this.verified
  }

  get nudgeCount(): number {
    return this.nudges
  }

  /**
   * True when the model is about to report success it hasn't earned:
   *   • it mutated the tree but never ran a passing verifier, OR
   *   • it CLAIMED completion in prose but never called a mutating tool at all
   *     (only when a side effect was expected).
   */
  hasUnverifiedWork(replyText: string, opts: HasUnverifiedOpts = {}): boolean {
    if (isGiveUp(replyText)) return false
    if (this.touchedTree && !this.verified) return true
    const sideEffectExpected = opts.sideEffectExpected ?? true
    if (sideEffectExpected && !this.touchedTree && claimsCompletion(replyText)) return true
    return false
  }

  /**
   * Decide what to do with a natural-language final reply. 'accept' when the
   * work is backed by evidence (or nothing actionable was claimed); 'nudge'
   * while the budget remains (push back, naming the concrete next tool);
   * 'reject' once the budget is spent (tell the user it is unverified).
   */
  onFinalReply(
    replyText: string,
    opts: HasUnverifiedOpts & { nextAction?: string } = {}
  ): VerifyDecision {
    if (!this.hasUnverifiedWork(replyText, opts)) return { action: 'accept' }
    if (this.nudges >= this.maxNudges) {
      return { action: 'reject', message: this.rejectMessage() }
    }
    this.nudges++
    return { action: 'nudge', message: this.nudgeMessage(opts.nextAction) }
  }

  /**
   * The pushback shown to the model. Names the exact tool it should call next so
   * a weak model has the best chance of recovering instead of drifting.
   */
  nudgeMessage(nextAction?: string): string {
    if (!this.touchedTree) {
      const call = nextAction ?? 'write_file / edit_file (or the relevant action tool)'
      return (
        `You are describing the work as done, but no file-writing or action tool was ever called this turn — so nothing actually happened. ` +
        `Call ${call} now to really do it, then reply. If you genuinely cannot, reply beginning with "GIVE UP:" and explain why.`
      )
    }
    const call = nextAction ?? 'run_script (the build) or run_tests'
    return (
      `You changed files but never ran a passing verifier this turn, so there is no evidence the result works. ` +
      `Call ${call} to confirm it, fix anything that fails, then reply. If you cannot get it to pass, reply beginning with "GIVE UP:".`
    )
  }

  /** The honest note prepended to the user-facing reply once nudges are spent. */
  rejectMessage(): string {
    if (!this.touchedTree) {
      return (
        '⚠️ This did NOT complete: I described the work but no file was actually written and no action tool ran, ' +
        'and I could not recover after being prompted. Nothing was changed on disk.'
      )
    }
    return (
      '⚠️ This is UNVERIFIED: files were changed but I could not get a build or test to pass to confirm it works. ' +
      'Please review before relying on it.'
    )
  }
}
