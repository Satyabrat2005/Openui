import { describe, it, expect } from 'vitest'
import {
  parseA11yJson,
  formatElementsForPrompt,
  getFocusedWindowElements,
  MAX_A11Y_ELEMENTS,
  type A11yElement
} from './accessibility'

describe('parseA11yJson (pure)', () => {
  it('parses an array, coercing and validating fields', () => {
    const raw = JSON.stringify([
      { role: 'button', name: 'Send', x: 10, y: 20, width: 80, height: 30, enabled: true, focused: false },
      { role: 'edit', name: 'Message', x: 0, y: 0, width: 200, height: 40, enabled: false, focused: true }
    ])
    const els = parseA11yJson(raw)
    expect(els).toHaveLength(2)
    expect(els[0]).toMatchObject({ role: 'button', name: 'Send', width: 80, enabled: true })
    expect(els[1]).toMatchObject({ enabled: false, focused: true })
  })

  it('accepts a single object (PowerShell collapses single-element arrays)', () => {
    const els = parseA11yJson(JSON.stringify({ role: 'button', name: 'OK', x: 1, y: 2, width: 10, height: 10 }))
    expect(els).toHaveLength(1)
    expect(els[0].enabled).toBe(true) // defaults to enabled when unspecified
  })

  it('drops zero-area / invalid entries and tolerates junk', () => {
    expect(parseA11yJson('not json')).toEqual([])
    expect(parseA11yJson('')).toEqual([])
    const els = parseA11yJson(JSON.stringify([{ role: 'x', name: 'y', width: 0, height: 10 }]))
    expect(els).toEqual([])
  })

  it('caps the element count', () => {
    const many = Array.from({ length: MAX_A11Y_ELEMENTS + 50 }, (_, i) => ({
      role: 'button',
      name: `b${i}`,
      x: 0,
      y: 0,
      width: 5,
      height: 5
    }))
    expect(parseA11yJson(JSON.stringify(many)).length).toBe(MAX_A11Y_ELEMENTS)
  })
})

describe('formatElementsForPrompt (pure)', () => {
  const els: A11yElement[] = [
    { role: 'button', name: 'Send', x: 100, y: 100, width: 40, height: 20, enabled: true, focused: false },
    { role: 'edit', name: 'To', x: 0, y: 0, width: 200, height: 40, enabled: false, focused: true }
  ]

  it('converts screen-space centres into screenshot-space click coordinates', () => {
    // screen 2000×1000, screenshot 1000×500 → half scale.
    const block = formatElementsForPrompt(els, 1000, 500, 2000, 1000)
    // "Send" centre is screen (120,110) → image (60,55).
    expect(block).toContain('button "Send" → click (60,55)')
    // "To" is disabled and focused.
    expect(block).toContain('[focused,disabled]')
  })

  it('falls back to 1:1 when screen dimensions are unknown', () => {
    const block = formatElementsForPrompt(els, 0, 0, 0, 0)
    expect(block).toContain('click (120,110)') // no scaling applied
  })

  it('returns empty string when there is nothing to add', () => {
    expect(formatElementsForPrompt([], 100, 100, 100, 100)).toBe('')
  })
})

describe('getFocusedWindowElements (real OS round-trip)', () => {
  it('never throws and always returns an array', async () => {
    // On CI/headless or an unsupported platform this returns []; on a real
    // desktop it returns the focused window's elements. Either way: an array,
    // and it must never throw past the tool boundary.
    const els = await getFocusedWindowElements()
    expect(Array.isArray(els)).toBe(true)
  }, 15_000)
})
