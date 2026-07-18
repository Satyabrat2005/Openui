import { describe, it, expect, vi } from 'vitest'
import { runOsLoop, describe as describeAction, type CapturedFrame, type LoopDeps } from './loop'
import type { RawFrame } from './frameState'
import type { VisionAction } from '../visionAction'
import { MAX_CONSECUTIVE_FAILURES } from './retry'

const W = 100
const H = 100

/** A frame filled with one colour — successive `shade` values differ visibly. */
function frame(shade: number): CapturedFrame {
  const data = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = shade
    data[i * 4 + 1] = shade
    data[i * 4 + 2] = shade
    data[i * 4 + 3] = 255
  }
  const raw: RawFrame = { width: W, height: H, data }
  return { raw, pngBuffer: Buffer.alloc(0), base64Image: '', width: W, height: H }
}

/**
 * Build deps whose captures follow a script. `captures` is consumed one frame
 * per capture() call; the last entry repeats forever so a test only has to
 * specify the interesting prefix.
 */
function makeDeps(opts: {
  actions: VisionAction[]
  captures: CapturedFrame[]
  ocr?: (buf: Buffer) => Promise<string[]>
  isAborted?: () => boolean
}): LoopDeps & { execCount: () => number; askCount: () => number; slept: () => number[] } {
  let captureIdx = 0
  let askIdx = 0
  let execCount = 0
  const slept: number[] = []

  return {
    capture: async () => {
      const f = opts.captures[Math.min(captureIdx, opts.captures.length - 1)]
      captureIdx++
      return f
    },
    ask: async () => opts.actions[Math.min(askIdx++, opts.actions.length - 1)],
    execute: async () => {
      execCount++
      return { ok: true }
    },
    ocr: opts.ocr,
    sleep: async (ms: number) => {
      slept.push(ms)
    },
    isAborted: opts.isAborted,
    execCount: () => execCount,
    askCount: () => askIdx,
    slept: () => slept
  }
}

const CLICK: VisionAction = { action: 'click', x: 50, y: 50 }
const DONE: VisionAction = { action: 'done', summary: 'goal reached' }

describe('runOsLoop — happy path', () => {
  it('acts, verifies the change, then finishes on done', async () => {
    // capture order: before(0) → after(1) → before(1) → [done, no capture used]
    const deps = makeDeps({ actions: [CLICK, DONE], captures: [frame(0), frame(255)] })

    const result = await runOsLoop(deps, { goal: 'click the button' })

    expect(result.outcome).toBe('done')
    expect(result.message).toBe('goal reached')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatch(/click \(50,50\)/)
    expect(result.steps[0]).toMatch(/changed near/)
    expect(deps.execCount()).toBe(1)
  })

  it('stops immediately when the model reports it is stuck', async () => {
    const deps = makeDeps({
      actions: [{ action: 'fail', reason: 'the dialog is not present' }],
      captures: [frame(0)]
    })

    const result = await runOsLoop(deps, { goal: 'do something impossible' })

    expect(result.outcome).toBe('failed')
    expect(result.message).toBe('the dialog is not present')
    expect(deps.execCount()).toBe(0)
  })
})

describe('runOsLoop — verification failures', () => {
  it('retries the SAME action once without asking the model again', async () => {
    // Every capture returns an identical frame → verification always fails.
    const deps = makeDeps({ actions: [CLICK], captures: [frame(0)] })

    await runOsLoop(deps, { goal: 'click a dead control' })

    // 3 executions: initial + 1 same-action retry, then escalation re-asks the
    // model (1 more ask → 1 more execute) before the hard stop.
    expect(deps.execCount()).toBe(MAX_CONSECUTIVE_FAILURES)
    // The retry did NOT cost an extra model call — that is its whole purpose.
    expect(deps.askCount()).toBeLessThan(deps.execCount())
  })

  it('hard-stops after consecutive failures instead of looping to the iteration cap', async () => {
    const deps = makeDeps({ actions: [CLICK], captures: [frame(0)] })

    const result = await runOsLoop(deps, { goal: 'click a dead control', maxIterations: 50 })

    expect(result.outcome).toBe('stopped-after-failures')
    expect(result.message).toMatch(new RegExp(`${MAX_CONSECUTIVE_FAILURES} consecutive`))
    // Nowhere near the 50-iteration cap — the failure detector fired first.
    expect(result.iterations).toBeLessThan(5)
  })

  it('feeds the failure reason back to the model on escalation', async () => {
    const deps = makeDeps({ actions: [CLICK], captures: [frame(0)] })
    const feedbacks: (string | undefined)[] = []
    deps.ask = async (input) => {
      feedbacks.push(input.feedback)
      return CLICK
    }

    await runOsLoop(deps, { goal: 'click a dead control' })

    expect(feedbacks[0]).toBeUndefined() // nothing has failed yet
    expect(feedbacks.some((f) => f && /do not repeat it/i.test(f))).toBe(true)
  })

  it('backs off between retries', async () => {
    const deps = makeDeps({ actions: [CLICK], captures: [frame(0)] })
    await runOsLoop(deps, { goal: 'click a dead control', settleMs: 10 })
    // Settle sleeps (10ms) plus at least one backoff sleep that is longer.
    expect(deps.slept().some((ms) => ms > 10)).toBe(true)
  })

  it('surfaces a primitive failure directly rather than retrying it', async () => {
    const deps = makeDeps({ actions: [CLICK], captures: [frame(0)] })
    deps.execute = async () => ({ ok: false, error: 'Accessibility access is required' })

    const result = await runOsLoop(deps, { goal: 'click' })

    // A refused permission is a real error with a real explanation — burning
    // three retries on it would only delay showing the user the fix.
    expect(result.outcome).toBe('failed')
    expect(result.message).toMatch(/Accessibility/)
  })
})

describe('runOsLoop — OCR verification of typing', () => {
  const TYPE: VisionAction = { action: 'type', text: 'quarterly report' }

  it('confirms typing via OCR even when pixels barely moved', async () => {
    const ocr = vi.fn(async () => ['quarterly report'])
    const deps = makeDeps({ actions: [TYPE, DONE], captures: [frame(0)], ocr })

    const result = await runOsLoop(deps, { goal: 'type the title' })

    expect(result.outcome).toBe('done')
    expect(result.steps[0]).toMatch(/visible on screen/)
    expect(ocr).toHaveBeenCalled()
  })

  it('does not run OCR for click actions — it is only worth its cost for typing', async () => {
    const ocr = vi.fn(async () => [])
    const deps = makeDeps({ actions: [CLICK, DONE], captures: [frame(0), frame(255)], ocr })

    await runOsLoop(deps, { goal: 'click the button' })

    expect(ocr).not.toHaveBeenCalled()
  })

  it('falls back to the pixel verdict when OCR throws', async () => {
    const ocr = vi.fn(async () => {
      throw new Error('tesseract exploded')
    })
    const deps = makeDeps({ actions: [TYPE, DONE], captures: [frame(0), frame(255)], ocr })
    const log = vi.fn()
    deps.log = log

    const result = await runOsLoop(deps, { goal: 'type the title' })

    // OCR is an optimisation for verification, never load-bearing.
    expect(result.outcome).toBe('done')
    expect(log).toHaveBeenCalledWith('ocr_failed', expect.objectContaining({ error: 'tesseract exploded' }))
  })
})

describe('runOsLoop — bounds and cancellation', () => {
  it('stops at the iteration limit when the model never emits done', async () => {
    // Alternating frames → every action verifies successfully, so the failure
    // detector never fires and only the iteration cap can stop the loop.
    let n = 0
    const deps = makeDeps({ actions: [CLICK], captures: [] })
    deps.capture = async () => frame(n++ % 2 === 0 ? 0 : 255)

    const result = await runOsLoop(deps, { goal: 'never finish', maxIterations: 4 })

    expect(result.outcome).toBe('iteration-limit')
    expect(result.iterations).toBe(4)
  })

  it('aborts cooperatively mid-task', async () => {
    let aborted = false
    const deps = makeDeps({
      actions: [CLICK, CLICK, DONE],
      captures: [frame(0), frame(255)],
      isAborted: () => aborted
    })
    const originalExecute = deps.execute
    deps.execute = async (a) => {
      aborted = true // user revokes consent during the first action
      return originalExecute(a)
    }

    const result = await runOsLoop(deps, { goal: 'a long task' })

    expect(result.outcome).toBe('aborted')
    expect(result.message).toMatch(/cancelled/i)
  })

  it('checks for abort before doing any work at all', async () => {
    const deps = makeDeps({ actions: [CLICK], captures: [frame(0)], isAborted: () => true })
    const result = await runOsLoop(deps, { goal: 'already cancelled' })
    expect(result.outcome).toBe('aborted')
    expect(deps.execCount()).toBe(0)
  })
})

describe('describe', () => {
  it('renders each action type compactly and truncates long typed text', () => {
    expect(describeAction({ action: 'click', x: 1, y: 2, why: 'the OK button' })).toBe(
      'click (1,2) — the OK button'
    )
    expect(describeAction({ action: 'key', keys: ['LeftControl', 'F'] })).toBe('press LeftControl+F')
    expect(describeAction({ action: 'scroll', direction: 'down', amount: 3 })).toBe('scroll down x3')
    expect(describeAction({ action: 'type', text: 'x'.repeat(200) }).length).toBeLessThan(80)
  })
})
