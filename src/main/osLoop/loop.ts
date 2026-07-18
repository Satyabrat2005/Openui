/**
 * loop.ts — the assembled capture → extract → reason → act → VERIFY loop.
 *
 * This is the orchestration shell for Phase 1. It owns control flow only; every
 * capability it needs (screen capture, OCR, the model call, input synthesis,
 * sleeping) arrives as an injected dependency. That is what makes the loop —
 * including its retry and hard-stop behaviour, the parts most likely to contain
 * an expensive bug — unit-testable with fakes, without granting a test process
 * control of the mouse.
 *
 * Relationship to the old code: `computer_use` in tools.ts previously inlined a
 * capture→ask→act loop with no verification. It now supplies the dependencies
 * and calls runOsLoop(), so tier gating, HITL approval and permission checks all
 * stay exactly where they were.
 */
import type { VisionAction } from '../visionAction'
import { diffFrames, type RawFrame } from './frameState'
import { verifyAction, isFailure, type VerifyOptions } from './verifier'
import { initialRetryState, nextDecision, type RetryState } from './retry'

/** One captured frame in both the forms the loop needs. */
export interface CapturedFrame {
  /** Decoded RGBA, for pixel diffing. */
  raw: RawFrame
  /** PNG bytes, for OCR. */
  pngBuffer: Buffer
  /** Base64 PNG, for the vision model. */
  base64Image: string
  width: number
  height: number
}

export interface AskInput {
  frame: CapturedFrame
  goal: string
  /** Compact history of prior steps, including verification outcomes. */
  priorActions: string[]
  /** Verifier feedback to surface when the last step failed. */
  feedback?: string
}

export interface ExecResult {
  ok: boolean
  error?: string
}

export interface LoopDeps {
  capture: () => Promise<CapturedFrame>
  ask: (input: AskInput) => Promise<VisionAction>
  execute: (action: VisionAction) => Promise<ExecResult>
  /** OCR a frame into normalised lines. Optional — only used to verify typing. */
  ocr?: (pngBuffer: Buffer) => Promise<string[]>
  sleep: (ms: number) => Promise<void>
  /** Structured trace hook (runLog in production, a spy in tests). */
  log?: (event: string, payload: Record<string, unknown>) => void
  /** Cooperative cancellation — checked at every step boundary. */
  isAborted?: () => boolean
}

export interface LoopOptions {
  goal: string
  maxIterations?: number
  /** Pause after an action so the UI can repaint before the verifying capture. */
  settleMs?: number
  verify?: VerifyOptions
}

export type LoopOutcome = 'done' | 'failed' | 'aborted' | 'stopped-after-failures' | 'iteration-limit'

export interface LoopResult {
  outcome: LoopOutcome
  /** Model's own summary on 'done', or the failure reason otherwise. */
  message: string
  steps: string[]
  iterations: number
}

const DEFAULT_MAX_ITERATIONS = 12
const DEFAULT_SETTLE_MS = 600

/**
 * Run the loop until the goal is met, the model gives up, the iteration cap is
 * reached, or too many steps in a row fail verification.
 */
export async function runOsLoop(deps: LoopDeps, opts: LoopOptions): Promise<LoopResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
  const log = deps.log ?? ((): void => {})

  const steps: string[] = []
  let retryState: RetryState = initialRetryState()
  let feedback: string | undefined
  let iterations = 0

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1

    if (deps.isAborted?.()) {
      return { outcome: 'aborted', message: 'The task was cancelled.', steps, iterations }
    }

    const before = await deps.capture()
    const action = await deps.ask({ frame: before, goal: opts.goal, priorActions: steps, feedback })
    feedback = undefined
    log('action_chosen', { step: iterations, action: action.action, why: action.why })

    if (action.action === 'done') {
      return {
        outcome: 'done',
        message: action.summary ?? `Completed "${opts.goal}".`,
        steps,
        iterations
      }
    }
    if (action.action === 'fail') {
      return {
        outcome: 'failed',
        message: action.reason ?? 'The model reported it was stuck.',
        steps,
        iterations
      }
    }

    // ── Execute, then verify, retrying the same action per the retry policy ──
    let settled = false
    while (!settled) {
      if (deps.isAborted?.()) {
        return { outcome: 'aborted', message: 'The task was cancelled.', steps, iterations }
      }

      const exec = await deps.execute(action)
      if (!exec.ok) {
        // A refused/failed primitive (missing permission, nut-js error) is not
        // a verification failure — it is a hard error with a real explanation,
        // so surface it rather than burning retries on it.
        return {
          outcome: 'failed',
          message: exec.error ?? 'The action could not be executed.',
          steps,
          iterations
        }
      }

      await deps.sleep(settleMs)
      const after = await deps.capture()
      const diff = diffFrames(before.raw, after.raw)

      // OCR is only worth its cost (seconds per frame) when reading text back
      // is what confirms the action — i.e. for typing.
      let beforeLines: string[] | undefined
      let afterLines: string[] | undefined
      if (action.action === 'type' && deps.ocr) {
        try {
          ;[beforeLines, afterLines] = await Promise.all([
            deps.ocr(before.pngBuffer),
            deps.ocr(after.pngBuffer)
          ])
        } catch (err) {
          // OCR is an optimisation for verification, never load-bearing: fall
          // back to the pixel-diff verdict rather than failing the step.
          log('ocr_failed', { step: iterations, error: err instanceof Error ? err.message : String(err) })
        }
      }

      const result = verifyAction(action, diff, { ...opts.verify, beforeLines, afterLines })
      const failed = isFailure(result.verdict)
      log('action_verified', {
        step: iterations,
        verdict: result.verdict,
        changedRatio: Number(diff.changedRatio.toFixed(5))
      })

      const { state, decision } = nextDecision(retryState, failed, result.detail)
      retryState = state

      switch (decision.kind) {
        case 'proceed':
          steps.push(`${iterations}. ${describe(action)} — ${result.detail}`)
          settled = true
          break

        case 'retry-same':
          log('action_retry', { step: iterations, attempt: decision.attempt, waitMs: decision.waitMs })
          await deps.sleep(decision.waitMs)
          // Loop again with the SAME action — covers the "UI had not repainted
          // yet" case without spending a model call.
          break

        case 'escalate-to-model':
          steps.push(`${iterations}. ${describe(action)} — FAILED: ${result.detail}`)
          feedback = decision.feedback
          settled = true
          break

        case 'hard-stop':
          steps.push(`${iterations}. ${describe(action)} — FAILED: ${result.detail}`)
          log('loop_hard_stop', { step: iterations, reason: decision.reason })
          return {
            outcome: 'stopped-after-failures',
            message: decision.reason,
            steps,
            iterations
          }
      }
    }
  }

  return {
    outcome: 'iteration-limit',
    message: `Reached the ${maxIterations}-step limit without completing "${opts.goal}".`,
    steps,
    iterations
  }
}

/** Compact, log-safe description of an action (typed text is truncated). */
export function describe(action: VisionAction): string {
  switch (action.action) {
    case 'click':
      return `click (${action.x},${action.y})${action.why ? ` — ${action.why}` : ''}`
    case 'type':
      return `type "${(action.text ?? '').slice(0, 60)}"${action.why ? ` — ${action.why}` : ''}`
    case 'key':
      return `press ${(action.keys ?? []).join('+')}${action.why ? ` — ${action.why}` : ''}`
    case 'scroll':
      return `scroll ${action.direction} x${action.amount ?? 1}${action.why ? ` — ${action.why}` : ''}`
    default:
      return action.action
  }
}
