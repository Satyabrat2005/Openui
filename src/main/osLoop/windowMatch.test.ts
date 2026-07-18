import { describe, it, expect } from 'vitest'
import {
  rankWindows,
  bestWindow,
  trailingSegment,
  hasArea,
  isTargetableWindow,
  MIN_WINDOW_DIMENSION,
  windowPointToScreen,
  screenPointInWindow,
  MIN_WINDOW_MATCH_SCORE,
  type WindowInfo
} from './windowMatch'

function win(handle: number, title: string, bounds = { left: 0, top: 0, width: 800, height: 600 }): WindowInfo {
  return { handle, title, bounds }
}

const OPEN_WINDOWS: WindowInfo[] = [
  win(0, 'report.docx - Microsoft Word'),
  win(1, 'tools.ts - Openui - Visual Studio Code'),
  win(2, 'Inbox (12) - Gmail - Google Chrome'),
  win(3, 'Untitled - Notepad')
]

describe('trailingSegment', () => {
  it('extracts the app name from a "document - app" title', () => {
    expect(trailingSegment('report.docx - Microsoft Word')).toBe('Microsoft Word')
    expect(trailingSegment('a - b - Visual Studio Code')).toBe('Visual Studio Code')
  })

  it('handles em-dash and pipe separators', () => {
    expect(trailingSegment('Page — Firefox')).toBe('Firefox')
    expect(trailingSegment('Doc | Notion')).toBe('Notion')
  })

  it('returns the whole title when there is no separator', () => {
    expect(trailingSegment('Calculator')).toBe('Calculator')
    // A hyphen without surrounding spaces is part of the name, not a separator.
    expect(trailingSegment('well-known-app')).toBe('well-known-app')
  })
})

describe('rankWindows', () => {
  it('matches an app name that appears only in the title suffix', () => {
    // The whole point of scoring the trailing segment: "word" is a weak match
    // against the full title but an exact match against "Microsoft Word".
    const ranked = rankWindows(OPEN_WINDOWS, 'word')
    expect(ranked[0].window.title).toMatch(/Microsoft Word/)
  })

  it('ranks a more specific query above a partial one', () => {
    const ranked = rankWindows(OPEN_WINDOWS, 'visual studio code')
    expect(ranked[0].window.handle).toBe(1)
  })

  it('matches on document name as well as app name', () => {
    expect(rankWindows(OPEN_WINDOWS, 'report.docx')[0].window.handle).toBe(0)
  })

  it('returns an empty list for an empty or unmatchable query', () => {
    expect(rankWindows(OPEN_WINDOWS, '')).toEqual([])
    expect(rankWindows(OPEN_WINDOWS, '   ')).toEqual([])
    expect(rankWindows(OPEN_WINDOWS, 'zzzznonexistent')).toEqual([])
  })

  it('is deterministic when scores tie', () => {
    const twoVsCode = [win(0, 'a.ts - Visual Studio Code'), win(1, 'b.ts - Visual Studio Code')]
    const first = rankWindows(twoVsCode, 'visual studio code')
    const second = rankWindows([...twoVsCode].reverse(), 'visual studio code')
    expect(first[0].window.title).toBe(second[0].window.title)
  })
})

describe('bestWindow', () => {
  it('returns the top match when it clears the confidence threshold', () => {
    expect(bestWindow(OPEN_WINDOWS, 'chrome')?.handle).toBe(2)
    expect(bestWindow(OPEN_WINDOWS, 'notepad')?.handle).toBe(3)
  })

  it('returns null rather than a low-confidence guess', () => {
    // Focusing the wrong window and then typing into it is worse than
    // reporting that the window could not be found.
    expect(bestWindow(OPEN_WINDOWS, 'photoshop')).toBeNull()
    expect(bestWindow([], 'word')).toBeNull()
  })

  it('does not accept a match scoring below the threshold', () => {
    const ranked = rankWindows(OPEN_WINDOWS, 'microsoft')
    const top = ranked[0]
    if (top && top.score < MIN_WINDOW_MATCH_SCORE) {
      expect(bestWindow(OPEN_WINDOWS, 'microsoft')).toBeNull()
    }
  })

  it('picks one of several identical-app windows rather than refusing', () => {
    const twoVsCode = [win(0, 'a.ts - Visual Studio Code'), win(1, 'b.ts - Visual Studio Code')]
    expect(bestWindow(twoVsCode, 'visual studio code')).not.toBeNull()
  })
})

describe('hasArea', () => {
  it('rejects zero-area (invisible helper) windows', () => {
    expect(hasArea({ left: 0, top: 0, width: 800, height: 600 })).toBe(true)
    expect(hasArea({ left: 0, top: 0, width: 0, height: 600 })).toBe(false)
    expect(hasArea({ left: 0, top: 0, width: 800, height: 0 })).toBe(false)
  })
})

describe('isTargetableWindow', () => {
  it('accepts normal application windows', () => {
    expect(isTargetableWindow({ left: 0, top: 0, width: 800, height: 600 })).toBe(true)
  })

  it('rejects the tiny message-only windows real desktops are full of', () => {
    // Observed on a real machine: "GDI+ Window (AsusOSD.exe)" at 1x1 has
    // positive area but can never be a click target.
    expect(isTargetableWindow({ left: 0, top: 0, width: 1, height: 1 })).toBe(false)
    expect(isTargetableWindow({ left: 0, top: 0, width: 800, height: 4 })).toBe(false)
  })

  it('uses the documented minimum on both axes', () => {
    const d = MIN_WINDOW_DIMENSION
    expect(isTargetableWindow({ left: 0, top: 0, width: d, height: d })).toBe(true)
    expect(isTargetableWindow({ left: 0, top: 0, width: d - 1, height: d })).toBe(false)
  })
})

describe('windowPointToScreen', () => {
  const bounds = { left: 100, top: 50, width: 800, height: 600 }

  it('offsets a window-relative point by the window origin', () => {
    expect(windowPointToScreen(bounds, 10, 20)).toEqual({ x: 110, y: 70 })
    expect(windowPointToScreen(bounds, 0, 0)).toEqual({ x: 100, y: 50 })
  })

  it('clamps a point outside the window back inside it', () => {
    // Safety property: a scoped run must never click into a DIFFERENT app,
    // which is exactly what per-app consent is meant to prevent.
    expect(windowPointToScreen(bounds, 5000, 5000)).toEqual({ x: 899, y: 649 })
    expect(windowPointToScreen(bounds, -50, -50)).toEqual({ x: 100, y: 50 })
  })

  it('clamps non-finite coordinates to the window origin', () => {
    expect(windowPointToScreen(bounds, NaN, Infinity)).toEqual({ x: 100, y: 50 })
  })

  it('survives a degenerate zero-size window', () => {
    expect(windowPointToScreen({ left: 10, top: 10, width: 0, height: 0 }, 5, 5)).toEqual({
      x: 10,
      y: 10
    })
  })
})

describe('screenPointInWindow', () => {
  const bounds = { left: 100, top: 50, width: 800, height: 600 }

  it('tests absolute containment with a half-open rectangle', () => {
    expect(screenPointInWindow(bounds, 100, 50)).toBe(true)
    expect(screenPointInWindow(bounds, 899, 649)).toBe(true)
    expect(screenPointInWindow(bounds, 900, 650)).toBe(false) // exclusive far edge
    expect(screenPointInWindow(bounds, 99, 50)).toBe(false)
  })
})
