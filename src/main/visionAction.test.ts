import { describe, it, expect } from 'vitest'
import { parseVisionAction, scaleToScreen, buildVisionSystemPrompt } from './visionAction'

describe('parseVisionAction — valid actions', () => {
  it('parses a click with integer coordinates', () => {
    const r = parseVisionAction('{"action":"click","x":120,"y":340,"why":"open menu"}')
    expect(r).toEqual({ ok: true, action: { action: 'click', x: 120, y: 340, why: 'open menu' } })
  })

  it('parses a click and coerces numeric strings', () => {
    const r = parseVisionAction('{"action":"click","x":"10","y":"20"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.action).toMatchObject({ action: 'click', x: 10, y: 20 })
  })

  it('parses a type action', () => {
    const r = parseVisionAction('{"action":"type","text":"hello world","why":"fill search"}')
    expect(r).toEqual({
      ok: true,
      action: { action: 'type', text: 'hello world', why: 'fill search' }
    })
  })

  it('parses done and fail', () => {
    expect(parseVisionAction('{"action":"done","summary":"logged in"}')).toEqual({
      ok: true,
      action: { action: 'done', summary: 'logged in' }
    })
    expect(parseVisionAction('{"action":"fail","reason":"no button"}')).toEqual({
      ok: true,
      action: { action: 'fail', reason: 'no button' }
    })
  })

  it('tolerates prose / code fences around the JSON (embedded-object recovery)', () => {
    const r = parseVisionAction('Sure, here is the action:\n```json\n{"action":"click","x":5,"y":6}\n```')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.action).toMatchObject({ action: 'click', x: 5, y: 6 })
  })

  it('drops empty/whitespace optional fields to undefined', () => {
    const r = parseVisionAction('{"action":"done","summary":"   "}')
    expect(r).toEqual({ ok: true, action: { action: 'done', summary: undefined } })
  })
})

describe('parseVisionAction — rejects malformed / unsafe output', () => {
  it('rejects a reply with no JSON object', () => {
    const r = parseVisionAction('I clicked the button for you.')
    expect(r.ok).toBe(false)
  })

  it('rejects a click missing coordinates', () => {
    expect(parseVisionAction('{"action":"click","x":10}').ok).toBe(false)
    expect(parseVisionAction('{"action":"click","x":"abc","y":2}').ok).toBe(false)
  })

  it('rejects a type action with empty text', () => {
    expect(parseVisionAction('{"action":"type","text":""}').ok).toBe(false)
    expect(parseVisionAction('{"action":"type"}').ok).toBe(false)
  })

  it('rejects an unknown action verb', () => {
    const r = parseVisionAction('{"action":"drag","x":1,"y":2}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown action/)
  })

  it('rejects a JSON array or non-object', () => {
    expect(parseVisionAction('[1,2,3]').ok).toBe(false)
  })
})

describe('scaleToScreen', () => {
  it('scales up from a smaller thumbnail to a larger display', () => {
    // 1920x1080 thumbnail → 2560x1440 display: factor 4/3.
    expect(scaleToScreen(960, 540, 1920, 1080, 2560, 1440)).toEqual({ x: 1280, y: 720 })
  })

  it('is a no-op when image and screen dimensions match', () => {
    expect(scaleToScreen(100, 200, 1920, 1080, 1920, 1080)).toEqual({ x: 100, y: 200 })
  })

  it('falls back to 1:1 when a dimension is unknown (0)', () => {
    expect(scaleToScreen(100, 200, 0, 0, 2560, 1440)).toEqual({ x: 100, y: 200 })
    expect(scaleToScreen(100, 200, 1920, 1080, 0, 0)).toEqual({ x: 100, y: 200 })
  })

  it('rounds to whole pixels', () => {
    expect(scaleToScreen(10, 10, 3, 3, 10, 10)).toEqual({ x: 33, y: 33 })
  })
})

describe('buildVisionSystemPrompt', () => {
  it('embeds the screenshot dimensions and the four action verbs', () => {
    const p = buildVisionSystemPrompt(1280, 800)
    expect(p).toContain('1280x800')
    for (const verb of ['click', 'type', 'done', 'fail']) expect(p).toContain(`"${verb}"`)
  })
})
