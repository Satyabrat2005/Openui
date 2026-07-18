import { describe, it, expect } from 'vitest'
import {
  backoffMs,
  initialRetryState,
  nextDecision,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_CONSECUTIVE_FAILURES,
  type RetryState
} from './retry'

describe('backoffMs', () => {
  it('doubles per attempt from the base delay', () => {
    expect(backoffMs(0)).toBe(BASE_BACKOFF_MS)
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS * 2)
    expect(backoffMs(2)).toBe(BASE_BACKOFF_MS * 4)
  })

  it('caps so a retry never reads as a hang to the watching user', () => {
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS)
  })

  it('treats a negative attempt as the base delay', () => {
    expect(backoffMs(-1)).toBe(BASE_BACKOFF_MS)
  })
})

describe('nextDecision', () => {
  it('proceeds and clears both counters on success', () => {
    const dirty: RetryState = { consecutiveFailures: 2, sameActionRetries: 1 }
    const { state, decision } = nextDecision(dirty, false, '')
    expect(decision).toEqual({ kind: 'proceed' })
    expect(state).toEqual({ consecutiveFailures: 0, sameActionRetries: 0 })
  })

  it('retries the same action first — the UI-not-repainted-yet case', () => {
    const { state, decision } = nextDecision(initialRetryState(), true, 'nothing changed')
    expect(decision.kind).toBe('retry-same')
    if (decision.kind === 'retry-same') {
      expect(decision.waitMs).toBe(BASE_BACKOFF_MS)
      expect(decision.attempt).toBe(1)
    }
    expect(state.consecutiveFailures).toBe(1)
    expect(state.sameActionRetries).toBe(1)
  })

  it('escalates to the model once the same action has been retried', () => {
    const afterRetry: RetryState = { consecutiveFailures: 1, sameActionRetries: 1 }
    const { state, decision } = nextDecision(afterRetry, true, 'the click probably missed its target')

    expect(decision.kind).toBe('escalate-to-model')
    if (decision.kind === 'escalate-to-model') {
      // The model must receive WHY it failed, plus an explicit instruction not
      // to repeat — otherwise it reliably re-issues the same coordinates.
      expect(decision.feedback).toMatch(/probably missed/)
      expect(decision.feedback).toMatch(/do not repeat it/i)
    }
    // Same-action budget resets so the NEXT action gets its own retry.
    expect(state.sameActionRetries).toBe(0)
    expect(state.consecutiveFailures).toBe(2)
  })

  it('hard-stops after the consecutive-failure limit rather than looping forever', () => {
    const brink: RetryState = { consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1, sameActionRetries: 0 }
    const { decision } = nextDecision(brink, true, 'still nothing changed')

    expect(decision.kind).toBe('hard-stop')
    if (decision.kind === 'hard-stop') {
      expect(decision.reason).toMatch(new RegExp(`${MAX_CONSECUTIVE_FAILURES} consecutive`))
      expect(decision.reason).toMatch(/still nothing changed/)
    }
  })

  it('reaches hard-stop through a realistic retry→escalate→stop sequence', () => {
    let state = initialRetryState()
    const kinds: string[] = []
    for (let i = 0; i < 5; i++) {
      const step = nextDecision(state, true, 'no effect')
      state = step.state
      kinds.push(step.decision.kind)
      if (step.decision.kind === 'hard-stop') break
    }
    expect(kinds).toEqual(['retry-same', 'escalate-to-model', 'hard-stop'])
  })

  it('does not hard-stop when successes interrupt the failure streak', () => {
    let state = initialRetryState()
    for (let i = 0; i < 10; i++) {
      const failStep = nextDecision(state, true, 'no effect')
      state = failStep.state
      expect(failStep.decision.kind).not.toBe('hard-stop')
      state = nextDecision(state, false, '').state
    }
  })
})
