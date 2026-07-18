import { describe, it, expect } from 'vitest'
import {
  diffFrames,
  boundingBoxOfDiff,
  boxContains,
  centreOf,
  framesComparable,
  textDelta,
  textContains,
  type RawFrame
} from './frameState'

/** Build a solid-colour RGBA frame. */
function solidFrame(width: number, height: number, rgb: [number, number, number]): RawFrame {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

/** Paint an axis-aligned rectangle into an existing frame. */
function paintRect(
  frame: RawFrame,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number]
): RawFrame {
  const data = new Uint8Array(frame.data)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * frame.width + x) * 4
      data[i] = rgb[0]
      data[i + 1] = rgb[1]
      data[i + 2] = rgb[2]
      data[i + 3] = 255
    }
  }
  return { ...frame, data }
}

describe('framesComparable', () => {
  it('rejects mismatched dimensions and zero-sized frames', () => {
    expect(framesComparable(solidFrame(10, 10, [0, 0, 0]), solidFrame(10, 10, [0, 0, 0]))).toBe(true)
    expect(framesComparable(solidFrame(10, 10, [0, 0, 0]), solidFrame(20, 10, [0, 0, 0]))).toBe(false)
    expect(framesComparable(solidFrame(0, 0, [0, 0, 0]), solidFrame(0, 0, [0, 0, 0]))).toBe(false)
  })
})

describe('diffFrames', () => {
  it('reports no change for identical frames', () => {
    const a = solidFrame(40, 40, [255, 255, 255])
    const diff = diffFrames(a, solidFrame(40, 40, [255, 255, 255]))
    expect(diff.changedPixels).toBe(0)
    expect(diff.changedRatio).toBe(0)
    expect(diff.changeBox).toBeNull()
    expect(diff.changeCentre).toBeNull()
  })

  it('locates a changed region and centres the box on it', () => {
    const before = solidFrame(100, 100, [255, 255, 255])
    const after = paintRect(before, 20, 30, 29, 39, [0, 0, 0])

    const diff = diffFrames(before, after)

    expect(diff.changedPixels).toBe(100) // a 10x10 rectangle
    expect(diff.totalPixels).toBe(10_000)
    expect(diff.changedRatio).toBeCloseTo(0.01, 5)
    expect(diff.changeBox).toEqual({ x0: 20, y0: 30, x1: 29, y1: 39 })
    expect(diff.changeCentre).toEqual({ x: 25, y: 35 })
  })

  it('degrades to an empty diff rather than throwing when resolution changes mid-task', () => {
    const diff = diffFrames(solidFrame(100, 100, [0, 0, 0]), solidFrame(50, 50, [255, 255, 255]))
    expect(diff.changedPixels).toBe(0)
    expect(diff.changeBox).toBeNull()
    expect(diff.totalPixels).toBe(2_500)
  })

  it('ignores sub-threshold colour noise', () => {
    // A one-step colour shift is below pixelmatch's 0.1 threshold — this is the
    // anti-aliasing / subpixel-rendering case that must not read as a change.
    const before = solidFrame(50, 50, [128, 128, 128])
    const after = solidFrame(50, 50, [129, 128, 128])
    expect(diffFrames(before, after).changedPixels).toBe(0)
  })
})

describe('boundingBoxOfDiff', () => {
  it('returns null when no pixel differs', () => {
    expect(boundingBoxOfDiff(new Uint8Array(4 * 25), 5, 5)).toBeNull()
  })

  it('spans every differing pixel, including disjoint regions', () => {
    const out = new Uint8Array(10 * 10 * 4)
    // Paint pixelmatch's diff colour (red); see boundingBoxOfDiff on why
    // changed pixels are identified by colour rather than alpha.
    const markDiff = (x: number, y: number): void => {
      const i = (y * 10 + x) * 4
      out[i] = 255
      out[i + 3] = 255
    }
    markDiff(1, 1)
    markDiff(8, 6)
    expect(boundingBoxOfDiff(out, 10, 10)).toEqual({ x0: 1, y0: 1, x1: 8, y1: 6 })
  })

  it('ignores greyscale (unchanged) and anti-aliasing (yellow) pixels', () => {
    const out = new Uint8Array(4 * 4 * 4)
    const paint = (x: number, y: number, rgb: [number, number, number]): void => {
      const i = (y * 4 + x) * 4
      out[i] = rgb[0]
      out[i + 1] = rgb[1]
      out[i + 2] = rgb[2]
      out[i + 3] = 255
    }
    paint(0, 0, [128, 128, 128]) // unchanged, faded greyscale
    paint(1, 1, [255, 255, 0]) // anti-aliased edge
    expect(boundingBoxOfDiff(out, 4, 4)).toBeNull()
  })
})

describe('boxContains', () => {
  const box = { x0: 10, y0: 10, x1: 20, y1: 20 }

  it('tests containment with and without padding', () => {
    expect(boxContains(box, 15, 15)).toBe(true)
    expect(boxContains(box, 10, 20)).toBe(true) // corners are inclusive
    expect(boxContains(box, 30, 15)).toBe(false)
    expect(boxContains(box, 30, 15, 10)).toBe(true) // within padding
  })
})

describe('centreOf', () => {
  it('rounds the centre to whole pixels', () => {
    expect(centreOf({ x0: 0, y0: 0, x1: 3, y1: 3 })).toEqual({ x: 2, y: 2 })
  })
})

describe('textDelta', () => {
  it('reports lines added and removed between frames', () => {
    const delta = textDelta(['File', 'Edit', 'Untitled'], ['File', 'Edit', 'report.txt'])
    expect(delta.added).toEqual(['report.txt'])
    expect(delta.removed).toEqual(['Untitled'])
  })
})

describe('textContains', () => {
  it('matches case-insensitively and tolerates OCR whitespace mangling', () => {
    expect(textContains(['Save   As...'], 'save as...')).toBe(true)
    expect(textContains(['HELLO WORLD'], 'hello world')).toBe(true)
  })

  it('refuses needles too short to match reliably', () => {
    // "ok" would match "Booking", "Look", "Token" … — a false confirmation.
    expect(textContains(['Booking reference'], 'ok')).toBe(false)
  })

  it('returns false when the text is absent', () => {
    expect(textContains(['File', 'Edit'], 'quarterly report')).toBe(false)
  })
})
