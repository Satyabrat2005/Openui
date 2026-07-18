import { describe, it, expect } from 'vitest'
import { verifyAction, isFailure } from './verifier'
import type { FrameDiff } from './frameState'
import type { VisionAction } from '../visionAction'

/** A diff with a given changed ratio and change box. */
function diff(changedRatio: number, box: FrameDiff['changeBox'] = null): FrameDiff {
  return {
    changedPixels: Math.round(changedRatio * 1_000_000),
    totalPixels: 1_000_000,
    changedRatio,
    changeBox: box,
    changeCentre: box ? { x: Math.round((box.x0 + box.x1) / 2), y: Math.round((box.y0 + box.y1) / 2) } : null
  }
}

const NOTHING = diff(0)
/** Below the no-change threshold — a blinking caret, not a UI response. */
const CARET_NOISE = diff(0.0001)

describe('verifyAction — click', () => {
  const click: VisionAction = { action: 'click', x: 100, y: 100 }

  it('confirms when the screen changed near the click point', () => {
    const result = verifyAction(click, diff(0.05, { x0: 50, y0: 50, x1: 150, y1: 150 }))
    expect(result.verdict).toBe('confirmed')
  })

  it('confirms a large change that starts away from the click but is within the radius', () => {
    // Clicking a menu bar opens a dropdown below it — the changed region does
    // not contain the click point, but is close enough to be its consequence.
    const result = verifyAction(click, diff(0.05, { x0: 100, y0: 120, x1: 300, y1: 400 }))
    expect(result.verdict).toBe('confirmed')
  })

  it('reports no-change when nothing happened', () => {
    const result = verifyAction(click, NOTHING)
    expect(result.verdict).toBe('no-change')
    expect(result.detail).toMatch(/probably missed/)
  })

  it('treats sub-threshold caret noise as no-change', () => {
    expect(verifyAction(click, CARET_NOISE).verdict).toBe('no-change')
  })

  it('reports unexpected-change when the screen changed far from the click', () => {
    const result = verifyAction(click, diff(0.05, { x0: 1500, y0: 900, x1: 1900, y1: 1000 }))
    expect(result.verdict).toBe('unexpected-change')
    expect(result.detail).toMatch(/away from the click point/)
  })

  it('honours a custom click radius', () => {
    const far = diff(0.05, { x0: 400, y0: 400, x1: 420, y1: 420 })
    expect(verifyAction(click, far, { clickRadiusPx: 10 }).verdict).toBe('unexpected-change')
    expect(verifyAction(click, far, { clickRadiusPx: 1000 }).verdict).toBe('confirmed')
  })
})

describe('verifyAction — type', () => {
  const type: VisionAction = { action: 'type', text: 'quarterly report' }

  it('confirms when the typed text is readable on screen afterwards', () => {
    const result = verifyAction(type, NOTHING, {
      beforeLines: ['Untitled'],
      afterLines: ['quarterly report']
    })
    // OCR evidence outranks the pixel diff — this is the whole point of
    // running OCR for type actions.
    expect(result.verdict).toBe('confirmed')
    expect(result.detail).toMatch(/visible on screen/)
  })

  it('reports no-change when nothing changed and the text is not readable', () => {
    const result = verifyAction(type, NOTHING, { afterLines: ['Untitled'] })
    expect(result.verdict).toBe('no-change')
    expect(result.detail).toMatch(/no field was focused/)
  })

  it('confirms on pixel change alone when text cannot be read back', () => {
    // Password fields and short strings legitimately land here.
    const result = verifyAction(type, diff(0.02), { afterLines: ['••••••••'] })
    expect(result.verdict).toBe('confirmed')
    expect(result.detail).toMatch(/could not be read back/)
  })

  it('works with no OCR lines supplied at all', () => {
    expect(verifyAction(type, diff(0.02)).verdict).toBe('confirmed')
    expect(verifyAction(type, NOTHING).verdict).toBe('no-change')
  })
})

describe('verifyAction — key and scroll', () => {
  it('confirms any real change, since neither action has an aim point', () => {
    const key: VisionAction = { action: 'key', keys: ['LeftControl', 'F'] }
    const scroll: VisionAction = { action: 'scroll', direction: 'down', amount: 3 }
    expect(verifyAction(key, diff(0.02, { x0: 0, y0: 0, x1: 10, y1: 10 })).verdict).toBe('confirmed')
    expect(verifyAction(scroll, diff(0.4)).verdict).toBe('confirmed')
  })

  it('reports no-change when the key or scroll had no effect', () => {
    const key: VisionAction = { action: 'key', keys: ['Enter'] }
    const result = verifyAction(key, NOTHING)
    expect(result.verdict).toBe('no-change')
    expect(result.detail).toMatch(/Enter/)

    const scroll: VisionAction = { action: 'scroll', direction: 'down' }
    expect(verifyAction(scroll, NOTHING).detail).toMatch(/scrolling down/)
  })
})

describe('verifyAction — terminal actions', () => {
  it('never fails done or fail', () => {
    expect(verifyAction({ action: 'done' }, NOTHING).verdict).toBe('confirmed')
    expect(verifyAction({ action: 'fail' }, NOTHING).verdict).toBe('confirmed')
  })
})

describe('isFailure', () => {
  it('counts only no-change as a failed step', () => {
    expect(isFailure('no-change')).toBe(true)
    expect(isFailure('confirmed')).toBe(false)
    // An off-target change is usually a real effect (a menu opened elsewhere),
    // so it is surfaced to the model but does not trigger retry/hard-stop.
    expect(isFailure('unexpected-change')).toBe(false)
  })
})
