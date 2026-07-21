import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const Jimp = require('jimp')
import { imageEditRegistry, imageEditToolSchemas, anchorPosition } from './imageEdit'

const dir = mkdtempSync(join(homedir(), '.openui-image-test-'))
const srcPng = join(dir, 'src.png')

beforeAll(async () => {
  // A small 40×20 red image to exercise the real jimp round-trip.
  const img = new Jimp(40, 20, 0xff0000ff)
  await img.writeAsync(srcPng)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('anchorPosition (pure)', () => {
  it('places watermarks at the requested corner/center', () => {
    expect(anchorPosition('top-left', 100, 100, 20, 10)).toEqual({ x: 12, y: 12 })
    expect(anchorPosition('center', 100, 100, 20, 10)).toEqual({ x: 40, y: 45 })
    const br = anchorPosition('bottom-right', 100, 100, 20, 10)
    expect(br.x).toBe(68)
    expect(br.y).toBe(78)
  })
})

describe('image tools', () => {
  it('reads image info (read-only)', async () => {
    const r = await imageEditRegistry.get_image_info({ path: srcPng })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('40×20')
    expect(r.output).toContain('image/png')
  })

  it('resizes, deriving a sibling output when none is given', async () => {
    const r = await imageEditRegistry.resize_image({ path: srcPng, width: 20 })
    expect(r.ok).toBe(true)
    const out = join(dir, 'src-resized.png')
    expect(existsSync(out)).toBe(true)
    const info = await imageEditRegistry.get_image_info({ path: out })
    expect(info.output).toContain('20×10') // height auto-scaled, aspect preserved
  })

  it('crops within bounds and rejects an out-of-bounds rectangle', async () => {
    const ok = await imageEditRegistry.crop_image({ path: srcPng, x: 0, y: 0, width: 10, height: 10, output_path: join(dir, 'c.png') })
    expect(ok.ok).toBe(true)
    const bad = await imageEditRegistry.crop_image({ path: srcPng, x: 0, y: 0, width: 999, height: 999 })
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/exceeds/i)
  })

  it('converts to jpeg and refuses webp', async () => {
    const jpg = await imageEditRegistry.convert_image({ path: srcPng, format: 'jpeg' })
    expect(jpg.ok).toBe(true)
    expect(existsSync(join(dir, 'src-converted.jpeg'))).toBe(true)
    const webp = await imageEditRegistry.convert_image({ path: srcPng, format: 'webp' })
    expect(webp.ok).toBe(false)
    expect(webp.error).toMatch(/webp/i)
  })

  it('watermarks with text', async () => {
    const r = await imageEditRegistry.watermark_image({ path: srcPng, text_or_image: 'DRAFT', position: 'bottom-right', output_path: join(dir, 'wm.png') })
    expect(r.ok).toBe(true)
    expect(existsSync(join(dir, 'wm.png'))).toBe(true)
  })

  it('rejects a missing file and a bad position', async () => {
    const missing = await imageEditRegistry.get_image_info({ path: join(dir, 'ghost.png') })
    expect(missing.ok).toBe(false)
    const badPos = await imageEditRegistry.watermark_image({ path: srcPng, text_or_image: 'x', position: 'middle' })
    expect(badPos.ok).toBe(false)
  })

  it('exposes exactly the five image schemas', () => {
    const names = imageEditToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(['convert_image', 'crop_image', 'get_image_info', 'resize_image', 'watermark_image'])
  })
})
