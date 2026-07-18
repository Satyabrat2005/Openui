import { describe, it, expect } from 'vitest'
import { decodePngToRawFrame } from './capture'
import { diffFrames } from './frameState'

/**
 * Integration check of the REAL visual pipeline: encode PNGs with jimp, decode
 * them back through capture.ts, and diff them with pixelmatch. The frameState
 * unit tests use synthetic RGBA buffers, which cannot catch a channel-order or
 * buffer-view mistake in the decode step — this can.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const Jimp = require('jimp') as any

async function pngOf(
  width: number,
  height: number,
  fill: number,
  rect?: { x: number; y: number; w: number; h: number; color: number }
): Promise<Buffer> {
  const img = new Jimp(width, height, fill)
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) img.setPixelColor(rect.color, x, y)
    }
  }
  return img.getBufferAsync(Jimp.MIME_PNG)
}

describe('decodePngToRawFrame', () => {
  it('decodes a PNG to RGBA with correct dimensions and buffer length', async () => {
    const frame = await decodePngToRawFrame(await pngOf(40, 25, 0xff0000ff))

    expect(frame.width).toBe(40)
    expect(frame.height).toBe(25)
    expect(frame.data.length).toBe(40 * 25 * 4)
  })

  it('preserves RGBA channel order', async () => {
    // Opaque red: 0xRRGGBBAA in jimp's int format.
    const frame = await decodePngToRawFrame(await pngOf(4, 4, 0xff0000ff))

    expect(frame.data[0]).toBe(255) // R
    expect(frame.data[1]).toBe(0) // G
    expect(frame.data[2]).toBe(0) // B
    expect(frame.data[3]).toBe(255) // A
  })
})

describe('decode → diff pipeline', () => {
  it('reports no change between two encodings of the same image', async () => {
    const png = await pngOf(60, 60, 0xffffffff)
    const [a, b] = await Promise.all([decodePngToRawFrame(png), decodePngToRawFrame(png)])

    expect(diffFrames(a, b).changedPixels).toBe(0)
  })

  it('locates a real changed region end to end', async () => {
    const before = await decodePngToRawFrame(await pngOf(100, 100, 0xffffffff))
    const after = await decodePngToRawFrame(
      await pngOf(100, 100, 0xffffffff, { x: 20, y: 30, w: 10, h: 10, color: 0x000000ff })
    )

    const diff = diffFrames(before, after)

    expect(diff.changedPixels).toBe(100)
    expect(diff.changeBox).toEqual({ x0: 20, y0: 30, x1: 29, y1: 39 })
    expect(diff.changeCentre).toEqual({ x: 25, y: 35 })
  })
})
