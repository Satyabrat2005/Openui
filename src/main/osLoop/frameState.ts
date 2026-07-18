/**
 * frameState.ts — pure visual state extraction and frame-to-frame diffing.
 *
 * This is the missing half of the screenshot→reason→act loop. The existing
 * `computer_use` loop executed an action, slept 600ms, and assumed it worked;
 * the model only discovered a missed click on the NEXT turn, by looking at a
 * screenshot that still showed the old state — and often just repeated the same
 * failing click. This module gives the loop an objective answer to "did that
 * action actually do anything, and did it happen where I aimed?".
 *
 * Everything here is PURE (no Electron, no nut-js, no fs), following the same
 * split as visionAction.ts and fs/pathSafety.ts, so the logic that decides
 * whether to retry a real mouse click is unit-testable without an OS.
 * Decoding PNG bytes into RawFrames is the caller's job (see loop.ts).
 */

/** A decoded frame: raw RGBA bytes plus dimensions. */
export interface RawFrame {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, length === width * height * 4. */
  data: Uint8Array
}

/** Axis-aligned bounding box in frame pixel space, inclusive of both corners. */
export interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The result of comparing two consecutive frames. */
export interface FrameDiff {
  /** Pixels whose colour changed beyond the per-pixel threshold. */
  changedPixels: number
  totalPixels: number
  /** changedPixels / totalPixels, in [0,1]. */
  changedRatio: number
  /** Tight box around everything that changed, or null when nothing did. */
  changeBox: BBox | null
  /** Centre of changeBox, or null when nothing changed. */
  changeCentre: { x: number; y: number } | null
}

/**
 * Per-pixel colour-distance threshold handed to pixelmatch (0–1, higher is more
 * tolerant). 0.1 is pixelmatch's own default and is deliberately not loosened:
 * anti-aliasing and subpixel text rendering differ slightly between otherwise
 * identical frames, but 0.1 already absorbs that, while still catching a focus
 * ring or a caret appearing.
 */
const PIXEL_THRESHOLD = 0.1

/** Colour pixelmatch paints differing pixels; see boundingBoxOfDiff. */
const DIFF_COLOR: [number, number, number] = [255, 0, 0]

/** Thrown-free guard: two frames can only be compared at identical dimensions. */
export function framesComparable(a: RawFrame, b: RawFrame): boolean {
  return a.width === b.width && a.height === b.height && a.width > 0 && a.height > 0
}

/**
 * Compare two frames and describe what changed.
 *
 * Returns an all-zero diff (rather than throwing) when the frames are not
 * comparable — a resolution change between captures is a real possibility (the
 * user unplugs a monitor mid-task) and must degrade to "cannot tell", not crash
 * a running automation.
 */
export function diffFrames(before: RawFrame, after: RawFrame): FrameDiff {
  const totalPixels = after.width * after.height
  if (!framesComparable(before, after)) {
    return { changedPixels: 0, totalPixels, changedRatio: 0, changeBox: null, changeCentre: null }
  }

  const { width, height } = after
  const output = new Uint8Array(width * height * 4)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pixelmatch = require('pixelmatch') as (
    a: Uint8Array,
    b: Uint8Array,
    out: Uint8Array | null,
    w: number,
    h: number,
    opts?: {
      threshold?: number
      diffColor?: [number, number, number]
      includeAA?: boolean
    }
  ) => number

  const changedPixels = pixelmatch(before.data, after.data, output, width, height, {
    threshold: PIXEL_THRESHOLD,
    // Pin the diff colour: boundingBoxOfDiff identifies changed pixels BY this
    // colour (see there for why alpha cannot be used), so it must not drift
    // with a pixelmatch default change.
    diffColor: DIFF_COLOR,
    // Anti-aliased edges are painted in a different colour (aaColor) and are
    // excluded from both the count and the box — they are rendering noise, not
    // a UI response.
    includeAA: false
  })

  const changeBox = boundingBoxOfDiff(output, width, height)
  return {
    changedPixels,
    totalPixels,
    changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
    changeBox,
    changeCentre: changeBox ? centreOf(changeBox) : null
  }
}

/**
 * Scan a pixelmatch output image for the bounding box of changed pixels.
 *
 * We want the box rather than a count because WHERE the screen changed is what
 * tells us a click landed on its target instead of somewhere else entirely.
 *
 * Changed pixels are identified BY COLOUR, not by alpha. pixelmatch v4 renders
 * UNCHANGED pixels as an opaque faded greyscale copy of the first image, so
 * every pixel in the output has alpha 255 and an alpha test matches the whole
 * frame. Differing pixels are painted DIFF_COLOR (red) and anti-aliased edges
 * a different colour again, so testing for "sufficiently red" selects exactly
 * the real differences and ignores both greyscale (r==g==b) and AA pixels.
 */
export function boundingBoxOfDiff(
  output: Uint8Array,
  width: number,
  height: number
): BBox | null {
  const isDiffPixel = (i: number): boolean =>
    output[i] >= 200 && output[i + 1] <= 100 && output[i + 2] <= 100
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let found = false

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4
    for (let x = 0; x < width; x++) {
      if (!isDiffPixel(rowStart + x * 4)) continue
      found = true
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }

  return found ? { x0, y0, x1, y1 } : null
}

/** Centre point of a box, rounded to whole pixels. */
export function centreOf(box: BBox): { x: number; y: number } {
  return {
    x: Math.round((box.x0 + box.x1) / 2),
    y: Math.round((box.y0 + box.y1) / 2)
  }
}

/** True when (x,y) lies inside the box, expanded by `pad` pixels on each side. */
export function boxContains(box: BBox, x: number, y: number, pad = 0): boolean {
  return x >= box.x0 - pad && x <= box.x1 + pad && y >= box.y0 - pad && y <= box.y1 + pad
}

/** Area of a box in pixels. */
export function boxArea(box: BBox): number {
  return Math.max(0, box.x1 - box.x0 + 1) * Math.max(0, box.y1 - box.y0 + 1)
}

/**
 * Lines present in `after` but not `before`, and vice versa.
 *
 * OCR text deltas are what verify a `type` action: pixels change when a caret
 * blinks, but the typed string appearing in the recognised text is positive
 * evidence the keystrokes reached the intended field.
 */
export function textDelta(
  beforeLines: readonly string[],
  afterLines: readonly string[]
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(beforeLines)
  const afterSet = new Set(afterLines)
  return {
    added: afterLines.filter((l) => !beforeSet.has(l)),
    removed: beforeLines.filter((l) => !afterSet.has(l))
  }
}

/**
 * Whether `needle` appears in any of the given OCR lines.
 *
 * Matching is case-insensitive and whitespace-collapsed because OCR routinely
 * mangles spacing and capitalisation; requiring an exact match would report
 * successful typing as a failure. Short needles (< 3 chars) are not matched at
 * all — they produce false positives against arbitrary screen text.
 */
export function textContains(lines: readonly string[], needle: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const target = norm(needle)
  if (target.length < 3) return false
  return lines.some((line) => norm(line).includes(target))
}
