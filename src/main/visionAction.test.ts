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
  it('embeds the screenshot dimensions and every action verb', () => {
    const p = buildVisionSystemPrompt(1280, 800)
    expect(p).toContain('1280x800')
    for (const verb of ['click', 'type', 'key', 'scroll', 'done', 'fail']) {
      expect(p).toContain(`"${verb}"`)
    }
  })

  it('tells the model not to repeat a step that reported no effect', () => {
    // Without this the model reliably re-issues the same failing coordinates,
    // which is what the retry policy is trying to avoid paying for.
    expect(buildVisionSystemPrompt(800, 600)).toMatch(/do NOT simply repeat it/)
  })
})

describe('parseVisionAction — key', () => {
  it('normalises key tokens to the spelling parseKeyCombo understands', () => {
    const r = parseVisionAction('{"action":"key","keys":["ctrl","f"],"why":"open find"}')
    expect(r).toEqual({
      ok: true,
      action: { action: 'key', keys: ['ctrl', 'f'], why: 'open find' }
    })
  })

  it('accepts aliases and is case-insensitive', () => {
    // Aliases collapse to one canonical token so the combo handed to
    // press_keys is stable regardless of how the model spelled it.
    expect(parseVisionAction('{"action":"key","keys":["ESC"]}')).toEqual({
      ok: true,
      action: { action: 'key', keys: ['escape'], why: undefined }
    })
    expect(parseVisionAction('{"action":"key","keys":["Return"]}')).toEqual({
      ok: true,
      action: { action: 'key', keys: ['enter'], why: undefined }
    })
  })

  it('makes every OS launcher unreachable', () => {
    // Each of these ends in arbitrary code execution when chained with this
    // loop's own `type` action, so the Super/Command modifier is not on the
    // allow-list at all — not merely restricted in what it can combine with.
    for (const combo of [
      '["meta","r"]', // Run dialog
      '["cmd","space"]', // Spotlight
      '["win"]', // Start menu
      '["cmd"]',
      '["super","e"]'
    ]) {
      const r = parseVisionAction(`{"action":"key","keys":${combo}}`)
      expect(r.ok, `${combo} must be rejected`).toBe(false)
    }
  })

  it('still allows ordinary in-app editing and navigation shortcuts', () => {
    expect(parseVisionAction('{"action":"key","keys":["ctrl","a"]}').ok).toBe(true)
    expect(parseVisionAction('{"action":"key","keys":["ctrl","v"]}').ok).toBe(true)
    expect(parseVisionAction('{"action":"key","keys":["tab"]}').ok).toBe(true)
    expect(parseVisionAction('{"action":"key","keys":["pagedown"]}').ok).toBe(true)
  })

  it('rejects keys outside the allow-list', () => {
    // The allow-list is a security boundary: page content steers the model, so
    // an unconstrained key field is a route to Win+R / Cmd+Space → run command.
    const r = parseVisionAction('{"action":"key","keys":["meta","r"]}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not permitted/)
  })

  it('rejects an empty, oversized, or non-string key list', () => {
    expect(parseVisionAction('{"action":"key","keys":[]}').ok).toBe(false)
    expect(parseVisionAction('{"action":"key","keys":["ctrl","shift","alt","f"]}').ok).toBe(false)
    expect(parseVisionAction('{"action":"key","keys":[123]}').ok).toBe(false)
    expect(parseVisionAction('{"action":"key"}').ok).toBe(false)
  })
})

describe('parseVisionAction — scroll', () => {
  it('parses a direction and amount', () => {
    expect(parseVisionAction('{"action":"scroll","direction":"down","amount":5}')).toEqual({
      ok: true,
      action: { action: 'scroll', direction: 'down', amount: 5, why: undefined }
    })
  })

  it('defaults a missing amount to a modest scroll', () => {
    const r = parseVisionAction('{"action":"scroll","direction":"up"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.action.amount).toBe(3)
  })

  it('clamps the amount into range', () => {
    const big = parseVisionAction('{"action":"scroll","direction":"down","amount":9999}')
    expect(big.ok).toBe(true)
    if (big.ok) expect(big.action.amount).toBe(10)

    // 0 would be a silent no-op that the verifier then reads as a failed step.
    const zero = parseVisionAction('{"action":"scroll","direction":"down","amount":0}')
    expect(zero.ok).toBe(true)
    if (zero.ok) expect(zero.action.amount).toBe(1)
  })

  it('rejects a missing or unknown direction', () => {
    expect(parseVisionAction('{"action":"scroll"}').ok).toBe(false)
    expect(parseVisionAction('{"action":"scroll","direction":"sideways"}').ok).toBe(false)
    expect(parseVisionAction('{"action":"scroll","direction":"down","amount":"abc"}').ok).toBe(false)
  })
})
