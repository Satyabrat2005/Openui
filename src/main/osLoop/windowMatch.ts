/**
 * windowMatch.ts — pure selection and geometry logic for window targeting.
 *
 * Split from windowTarget.ts (which owns the nut-js calls) for the same reason
 * visionAction.ts is split from tools.ts: choosing WHICH window an instruction
 * refers to, and clamping coordinates into it, is fiddly logic that decides
 * where real clicks land, so it must be testable without an OS.
 *
 * The fuzzy scorer is deliberately the one already used to resolve app names
 * (appResolver.scoreAppName) rather than a second, subtly different one — a
 * window titled "report.docx - Microsoft Word" should match "word" by exactly
 * the same rules that let `open_app word` find it.
 */
import { normalizeAppName, scoreAppName } from '../appResolver'

/** A window's on-screen rectangle, in real display pixels. */
export interface WindowBounds {
  left: number
  top: number
  width: number
  height: number
}

/** One enumerated window. `handle` is opaque — it indexes back to the nut-js object. */
export interface WindowInfo {
  handle: number
  title: string
  bounds: WindowBounds
}

/**
 * Minimum score to accept a window as "the one the user meant".
 *
 * Matches the threshold appResolver uses for launching apps. Below this we
 * return no match rather than a guess, because focusing and then typing into
 * the WRONG window is materially worse than reporting that we could not find
 * it — the keystrokes still land somewhere.
 */
export const MIN_WINDOW_MATCH_SCORE = 50

export interface ScoredWindow {
  window: WindowInfo
  score: number
}

/**
 * Score every window against a query and return them best-first.
 *
 * Window titles are usually "<document> - <app>", so the query is scored
 * against BOTH the full title and its trailing segment (the app name), taking
 * the better of the two. Without that, "word" scores poorly against
 * "report.docx - Microsoft Word" despite being an obvious match.
 */
export function rankWindows(windows: readonly WindowInfo[], query: string): ScoredWindow[] {
  const q = normalizeAppName(query)
  if (!q) return []

  return windows
    .map((window) => {
      const full = normalizeAppName(window.title)
      const appSegment = normalizeAppName(trailingSegment(window.title))
      const score = Math.max(scoreAppName(q, full), scoreAppName(q, appSegment))
      return { window, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.window.title.localeCompare(b.window.title))
}

/**
 * Best matching window, or null when nothing clears the threshold.
 *
 * Ambiguity (two windows tied at the top score) resolves to the first by title
 * order rather than returning null: with several windows of the same app open,
 * every candidate is an equally valid interpretation, and refusing to act would
 * make the common "two VS Code windows" case unusable.
 */
export function bestWindow(windows: readonly WindowInfo[], query: string): WindowInfo | null {
  const ranked = rankWindows(windows, query)
  const top = ranked[0]
  return top && top.score >= MIN_WINDOW_MATCH_SCORE ? top.window : null
}

/** Text after the last " - " / " — " separator, or the whole title. */
export function trailingSegment(title: string): string {
  const parts = title.split(/\s[-—|]\s/)
  return parts.length > 1 ? parts[parts.length - 1] : title
}

/** True when the rectangle has positive area. */
export function hasArea(bounds: WindowBounds): boolean {
  return bounds.width > 0 && bounds.height > 0
}

/**
 * Smallest dimension a window can have and still be something a user means.
 *
 * Measured against a real desktop: enumeration returned 263 windows, 20 of
 * which had positive but tiny geometry — 1×1 message-only windows like
 * "GDI+ Window (AsusOSD.exe)" that belong to tray utilities and overlays. They
 * pass a plain area test but can never be a click target, and leaving them in
 * lets one accidentally win a fuzzy match.
 */
export const MIN_WINDOW_DIMENSION = 32

/** True when a window is big enough to be a plausible automation target. */
export function isTargetableWindow(bounds: WindowBounds): boolean {
  return bounds.width >= MIN_WINDOW_DIMENSION && bounds.height >= MIN_WINDOW_DIMENSION
}

/**
 * Convert a point expressed relative to a window into absolute screen
 * coordinates, clamped to stay inside the window.
 *
 * The clamp is a safety property, not a convenience: when a capture is scoped
 * to one window, a vision model that misjudges an edge would otherwise produce
 * a click OUTSIDE the app it was granted control of — in another app entirely,
 * which is exactly what the per-app consent model exists to prevent.
 */
export function windowPointToScreen(
  bounds: WindowBounds,
  x: number,
  y: number
): { x: number; y: number } {
  const clampedX = clamp(x, 0, Math.max(0, bounds.width - 1))
  const clampedY = clamp(y, 0, Math.max(0, bounds.height - 1))
  return { x: Math.round(bounds.left + clampedX), y: Math.round(bounds.top + clampedY) }
}

/** True when an absolute screen point falls inside the window's rectangle. */
export function screenPointInWindow(bounds: WindowBounds, x: number, y: number): boolean {
  return (
    x >= bounds.left &&
    x < bounds.left + bounds.width &&
    y >= bounds.top &&
    y < bounds.top + bounds.height
  )
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}
