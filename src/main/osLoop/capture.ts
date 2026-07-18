/**
 * capture.ts — PNG bytes → RawFrame (RGBA) decoding for the diffing layer.
 *
 * Electron's desktopCapturer hands back a PNG; pixelmatch needs raw RGBA. jimp
 * is already in the tree (nut-js depends on it) and is now declared directly in
 * package.json so this does not rely on hoisting.
 *
 * Kept out of frameState.ts so that module stays pure and synchronous — this is
 * the only piece of the visual pipeline that does real decoding work.
 */
import type { RawFrame } from './frameState'

/**
 * Decode a PNG buffer into an RGBA frame.
 *
 * Note on cost: this runs twice per verified step (before + after) on a
 * full-resolution frame, ~100–200ms each. That is well under the settle time we
 * already wait, so it is not on the critical path — but it IS why OCR is called
 * only for `type` actions rather than every frame.
 */
export async function decodePngToRawFrame(pngBuffer: Buffer): Promise<RawFrame> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const Jimp = require('jimp') as any
  const image = await Jimp.read(pngBuffer)
  const { data, width, height } = image.bitmap as {
    data: Buffer
    width: number
    height: number
  }
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }
}
