/**
 * imageEdit.ts — image manipulation tools for the OpenUI agent (Part 6.3).
 *
 * Self-contained tool module (schemas + registry) mirroring spreadsheet.ts.
 * Tools:
 *   get_image_info(path)                                   — read-only metadata
 *   resize_image(path, width, height, output_path?)        — scale
 *   crop_image(path, x, y, width, height, output_path?)    — cut a rectangle
 *   convert_image(path, format, output_path?)              — change file format
 *   watermark_image(path, text_or_image, position, ...)    — overlay text/image
 *
 * LIBRARY CHOICE — jimp:
 *   jimp is ALREADY a dependency (the osLoop capture layer decodes PNGs with it
 *   for screenshot diffing), so exposing image editing needs no new package and
 *   no native build step — a real win over sharp, which ships prebuilt native
 *   binaries per platform/arch that complicate the electron-builder pipeline.
 *   The pinned jimp 0.22 covers PNG / JPEG / BMP / TIFF / GIF. It does NOT do
 *   WebP (WebP support only landed in jimp v1); convert_image therefore reports
 *   WebP as unsupported rather than pretending — upgrading to jimp v1 is the
 *   path if WebP ever becomes a hard requirement.
 *
 * SECURITY / SAFETY:
 *   - Every path passes through resolveSafePath(): reads blocked from sensitive
 *     dirs; writes confined to the home tree.
 *   - Memory guard: a file-size pre-check (before decode) plus a decoded
 *     pixel-budget check (after decode, before any second buffer is allocated)
 *     plus an output-dimension cap keep one huge image from exhausting RAM.
 *   - The four mutating tools are registered in STATE_CHANGING_TOOLS (tools.ts);
 *     get_image_info is read-only and is not.
 */

import { resolveSafePath } from './fs/pathSafety'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'
import { stat } from 'node:fs/promises'
import { dirname, join as joinPath, basename, extname } from 'node:path'

// Guards against decoding / producing an image large enough to exhaust memory.
const MAX_FILE_BYTES = 100 * 1024 * 1024 // 100 MB on disk (pre-decode gate)
const MAX_SOURCE_PIXELS = 60_000_000 // ~60 MP decoded (e.g. 8000×7500) — reject beyond
const MAX_OUTPUT_DIM = 20_000 // per side, for a requested resize/crop
const MAX_WATERMARK_TEXT = 500

// Formats jimp 0.22 can WRITE, mapped to their MIME type. WebP intentionally
// absent — see the library-choice note above.
const FORMAT_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  gif: 'image/gif'
}

// Where a text/image watermark is anchored.
const POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'])
const IMAGE_EXT_RE = /\.(png|jpe?g|bmp|tiff?|gif)$/i

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadJimp(): any {
  return require('jimp')
}

/**
 * Resolve + size-check a source image path, then decode it. Returns the jimp
 * image or an error string (never throws). Centralises the memory guards so
 * every tool gets them.
 */
async function readSourceImage(
  raw: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ image: any; path: string } | { error: string }> {
  let path: string
  try {
    path = resolveSafePath(raw, { mutating: false })
  } catch (e) {
    return { error: errText(e) }
  }
  let info
  try {
    info = await stat(path)
  } catch {
    return { error: `image not found — "${String(raw)}".` }
  }
  if (info.size > MAX_FILE_BYTES) {
    return { error: `image file is too large (${info.size} bytes, cap ${MAX_FILE_BYTES}).` }
  }
  try {
    const Jimp = loadJimp()
    const image = await Jimp.read(path)
    const pixels = image.bitmap.width * image.bitmap.height
    if (pixels > MAX_SOURCE_PIXELS) {
      return {
        error: `image is too large to process safely (${image.bitmap.width}×${image.bitmap.height} = ${pixels} px, cap ${MAX_SOURCE_PIXELS}).`
      }
    }
    return { image, path }
  } catch (e) {
    return { error: `could not decode image: ${errText(e)}` }
  }
}

/** Derive a sibling output path when the caller doesn't give one, e.g. photo → photo-resized.png. */
function deriveOutput(srcPath: string, suffix: string, newExt?: string): string {
  const ext = newExt ?? (extname(srcPath).replace(/^\./, '') || 'png')
  const base = basename(srcPath, extname(srcPath))
  return joinPath(dirname(srcPath), `${base}-${suffix}.${ext}`)
}

/** Resolve an output path (mutating) or fall back to a derived sibling of src. */
function resolveOutput(raw: unknown, srcPath: string, suffix: string, newExt?: string): string | { error: string } {
  const target = typeof raw === 'string' && raw.trim() ? raw : deriveOutput(srcPath, suffix, newExt)
  try {
    return resolveSafePath(target, { mutating: true })
  } catch (e) {
    return { error: errText(e) }
  }
}

// ── get_image_info ──────────────────────────────────────────────────────────────

async function get_image_info(args: Record<string, unknown>): Promise<ToolResult> {
  const src = await readSourceImage(args.path)
  if ('error' in src) return { ok: false, error: `get_image_info: ${src.error}` }
  try {
    const size = (await stat(src.path)).size
    const { width, height } = src.image.bitmap
    const mime = typeof src.image.getMIME === 'function' ? src.image.getMIME() : 'unknown'
    return {
      ok: true,
      output: `${src.path}\n  format: ${mime}\n  dimensions: ${width}×${height} px\n  file size: ${size} bytes`
    }
  } catch (e) {
    return { ok: false, error: `get_image_info failed: ${errText(e)}` }
  }
}

// ── resize_image ──────────────────────────────────────────────────────────────

async function resize_image(args: Record<string, unknown>): Promise<ToolResult> {
  const src = await readSourceImage(args.path)
  if ('error' in src) return { ok: false, error: `resize_image: ${src.error}` }

  const Jimp = loadJimp()
  const hasW = args.width !== undefined && args.width !== null
  const hasH = args.height !== undefined && args.height !== null
  if (!hasW && !hasH) {
    return { ok: false, error: 'resize_image requires a "width" and/or "height" (in pixels).' }
  }
  const width = hasW ? Number(args.width) : Jimp.AUTO
  const height = hasH ? Number(args.height) : Jimp.AUTO
  for (const [label, v] of [['width', width], ['height', height]] as const) {
    if (v !== Jimp.AUTO && (!Number.isFinite(v) || v <= 0 || v > MAX_OUTPUT_DIM)) {
      return { ok: false, error: `resize_image: "${label}" must be between 1 and ${MAX_OUTPUT_DIM}.` }
    }
  }

  const out = resolveOutput(args.output_path, src.path, 'resized')
  if (typeof out !== 'string') return { ok: false, error: `resize_image: ${out.error}` }
  try {
    src.image.resize(width, height)
    await src.image.writeAsync(out)
    return { ok: true, output: `Resized to ${src.image.bitmap.width}×${src.image.bitmap.height} px → ${out}.` }
  } catch (e) {
    return { ok: false, error: `resize_image failed: ${errText(e)}` }
  }
}

// ── crop_image ────────────────────────────────────────────────────────────────

async function crop_image(args: Record<string, unknown>): Promise<ToolResult> {
  const src = await readSourceImage(args.path)
  if ('error' in src) return { ok: false, error: `crop_image: ${src.error}` }

  const x = Number(args.x)
  const y = Number(args.y)
  const w = Number(args.width)
  const h = Number(args.height)
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0) {
    return { ok: false, error: 'crop_image requires finite "x","y" (≥0) and "width","height" (>0).' }
  }
  const { width: sw, height: sh } = src.image.bitmap
  if (x + w > sw || y + h > sh) {
    return { ok: false, error: `crop_image: rectangle (${x},${y},${w}×${h}) exceeds the ${sw}×${sh} image bounds.` }
  }

  const out = resolveOutput(args.output_path, src.path, 'cropped')
  if (typeof out !== 'string') return { ok: false, error: `crop_image: ${out.error}` }
  try {
    src.image.crop(x, y, w, h)
    await src.image.writeAsync(out)
    return { ok: true, output: `Cropped to ${w}×${h} px at (${x},${y}) → ${out}.` }
  } catch (e) {
    return { ok: false, error: `crop_image failed: ${errText(e)}` }
  }
}

// ── convert_image ─────────────────────────────────────────────────────────────

async function convert_image(args: Record<string, unknown>): Promise<ToolResult> {
  const rawFormat = typeof args.format === 'string' ? args.format.trim().toLowerCase().replace(/^\./, '') : ''
  if (rawFormat === 'webp') {
    return {
      ok: false,
      error: 'convert_image: WebP is not supported by the bundled image library (jimp 0.22). Use png, jpeg, bmp, tiff, or gif.'
    }
  }
  const mime = FORMAT_MIME[rawFormat]
  if (!mime) {
    return { ok: false, error: `convert_image: unsupported "format" — use one of: ${Object.keys(FORMAT_MIME).join(', ')}.` }
  }

  const src = await readSourceImage(args.path)
  if ('error' in src) return { ok: false, error: `convert_image: ${src.error}` }

  const canonicalExt = rawFormat === 'jpg' ? 'jpg' : rawFormat === 'tif' ? 'tiff' : rawFormat
  const out = resolveOutput(args.output_path, src.path, 'converted', canonicalExt)
  if (typeof out !== 'string') return { ok: false, error: `convert_image: ${out.error}` }
  try {
    const buf = await src.image.getBufferAsync(mime)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(out, buf)
    return { ok: true, output: `Converted to ${mime} → ${out}.` }
  } catch (e) {
    return { ok: false, error: `convert_image failed: ${errText(e)}` }
  }
}

// ── watermark_image ─────────────────────────────────────────────────────────────

/** Compute the (x,y) top-left origin for a wm of size (ww,wh) over a base (bw,bh). */
export function anchorPosition(
  position: string,
  bw: number,
  bh: number,
  ww: number,
  wh: number,
  margin = 12
): { x: number; y: number } {
  const right = Math.max(margin, bw - ww - margin)
  const bottom = Math.max(margin, bh - wh - margin)
  switch (position) {
    case 'top-left':
      return { x: margin, y: margin }
    case 'top-right':
      return { x: right, y: margin }
    case 'bottom-left':
      return { x: margin, y: bottom }
    case 'center':
      return { x: Math.max(0, Math.round((bw - ww) / 2)), y: Math.max(0, Math.round((bh - wh) / 2)) }
    case 'bottom-right':
    default:
      return { x: right, y: bottom }
  }
}

async function watermark_image(args: Record<string, unknown>): Promise<ToolResult> {
  const overlay = typeof args.text_or_image === 'string' ? args.text_or_image.trim() : ''
  if (!overlay) {
    return { ok: false, error: 'watermark_image requires "text_or_image": watermark text, or a path to an image.' }
  }
  const position = typeof args.position === 'string' ? args.position.trim().toLowerCase() : 'bottom-right'
  if (!POSITIONS.has(position)) {
    return { ok: false, error: `watermark_image: "position" must be one of: ${[...POSITIONS].join(', ')}.` }
  }

  const src = await readSourceImage(args.path)
  if ('error' in src) return { ok: false, error: `watermark_image: ${src.error}` }

  const Jimp = loadJimp()
  const { width: bw, height: bh } = src.image.bitmap
  const out = resolveOutput(args.output_path, src.path, 'watermarked')
  if (typeof out !== 'string') return { ok: false, error: `watermark_image: ${out.error}` }

  try {
    if (IMAGE_EXT_RE.test(overlay)) {
      // Image watermark: composite the overlay image at the anchor position.
      const wmSrc = await readSourceImage(overlay)
      if ('error' in wmSrc) return { ok: false, error: `watermark_image (overlay): ${wmSrc.error}` }
      const { width: ww, height: wh } = wmSrc.image.bitmap
      const { x, y } = anchorPosition(position, bw, bh, ww, wh)
      src.image.composite(wmSrc.image, x, y, {
        mode: Jimp.BLEND_SOURCE_OVER,
        opacitySource: 0.6,
        opacityDest: 1
      })
    } else {
      // Text watermark: render with a bundled bitmap font.
      if (overlay.length > MAX_WATERMARK_TEXT) {
        return { ok: false, error: `watermark_image: text is too long (limit ${MAX_WATERMARK_TEXT}).` }
      }
      const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE)
      const tw = typeof Jimp.measureText === 'function' ? Jimp.measureText(font, overlay) : overlay.length * 16
      const th = typeof Jimp.measureTextHeight === 'function' ? Jimp.measureTextHeight(font, overlay, bw) : 32
      const { x, y } = anchorPosition(position, bw, bh, tw, th)
      src.image.print(font, x, y, overlay)
    }
    await src.image.writeAsync(out)
    return { ok: true, output: `Watermarked (${position}) → ${out}.` }
  } catch (e) {
    return { ok: false, error: `watermark_image failed: ${errText(e)}` }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const imageEditToolSchemas: ToolSchema[] = [
  {
    name: 'get_image_info',
    description:
      'Read an image\'s format, pixel dimensions, and file size WITHOUT modifying it. ' +
      'Read-only — call this first to plan a resize/crop.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the image (png/jpeg/bmp/tiff/gif).' } },
      required: ['path']
    }
  },
  {
    name: 'resize_image',
    description:
      'Resize an image to a new width and/or height in pixels. Omit one dimension to scale it ' +
      'automatically and preserve aspect ratio. Writes to output_path, or to "<name>-resized.<ext>" ' +
      'next to the source if omitted (the original is never overwritten unless you pass its path).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source image.' },
        width: { type: 'number', description: 'Target width in pixels. Omit to auto-scale from height.' },
        height: { type: 'number', description: 'Target height in pixels. Omit to auto-scale from width.' },
        output_path: { type: 'string', description: 'Optional destination path inside your home folder.' }
      },
      required: ['path']
    }
  },
  {
    name: 'crop_image',
    description:
      'Crop a rectangle out of an image. (x,y) is the top-left corner; width/height are the ' +
      'rectangle size in pixels; the rectangle must fit inside the image. Writes to output_path, ' +
      'or to "<name>-cropped.<ext>" if omitted.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source image.' },
        x: { type: 'number', description: 'Left edge of the crop, in pixels (≥0).' },
        y: { type: 'number', description: 'Top edge of the crop, in pixels (≥0).' },
        width: { type: 'number', description: 'Crop width in pixels (>0).' },
        height: { type: 'number', description: 'Crop height in pixels (>0).' },
        output_path: { type: 'string', description: 'Optional destination path inside your home folder.' }
      },
      required: ['path', 'x', 'y', 'width', 'height']
    }
  },
  {
    name: 'convert_image',
    description:
      'Convert an image to another format: png, jpeg, bmp, tiff, or gif. (WebP is not supported.) ' +
      'Writes to output_path, or to "<name>-converted.<newext>" next to the source if omitted.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source image.' },
        format: { type: 'string', description: 'Target format.', enum: ['png', 'jpeg', 'jpg', 'bmp', 'tiff', 'tif', 'gif'] },
        output_path: { type: 'string', description: 'Optional destination path inside your home folder.' }
      },
      required: ['path', 'format']
    }
  },
  {
    name: 'watermark_image',
    description:
      'Overlay a watermark onto an image — either a line of text or another image (pass its path). ' +
      'Choose a corner or the center via "position". Writes to output_path, or to ' +
      '"<name>-watermarked.<ext>" if omitted.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the base image.' },
        text_or_image: {
          type: 'string',
          description:
            'The watermark: plain text (e.g. "CONFIDENTIAL"), OR a path to an overlay image ' +
            '(ending in .png/.jpg/.bmp/.tiff/.gif — e.g. a logo).'
        },
        position: {
          type: 'string',
          description: 'Where to place the watermark.',
          enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']
        },
        output_path: { type: 'string', description: 'Optional destination path inside your home folder.' }
      },
      required: ['path', 'text_or_image', 'position']
    }
  }
]

export const imageEditRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  get_image_info,
  resize_image,
  crop_image,
  convert_image,
  watermark_image
}
