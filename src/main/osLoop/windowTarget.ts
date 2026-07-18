/**
 * windowTarget.ts — enumerate, find, focus and reposition OS windows.
 *
 * Scope note: nut-js 4.2 already exposes `getWindows`, `getActiveWindow`,
 * `windowWithTitle` and a Window class with getTitle/getRegion/move/resize/
 * focus/minimize/restore across all three platforms via its libnut bindings
 * (all of which are installed). There is therefore no AppleScript / Win32 /
 * xdotool code here — writing platform-native window control would be
 * re-implementing what the dependency already does.
 *
 * What this module adds on top is the part nut-js does NOT provide: matching a
 * human phrase ("word", "the browser") to a window, and turning a window's
 * bounds into something the capture and click paths can be scoped to.
 *
 * Every function degrades gracefully. Window enumeration is the least reliable
 * surface in nut-js — it throws on some Linux WMs and returns partial data when
 * a window dies mid-enumeration — so failures return empty/null rather than
 * propagating, and callers fall back to whole-screen automation.
 */
import { bestWindow, isTargetableWindow, type WindowBounds, type WindowInfo } from './windowMatch'

/** Per-window nut-js calls are bounded so a hung compositor cannot wedge a run. */
const WINDOW_CALL_TIMEOUT_MS = 2_000

/** Lazily load nut-js, falling back to the community fork (same public API). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadNut(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@nut-tree/nut-js')
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@nut-tree-fork/nut-js')
  }
}

/** Reject after `ms` so one unresponsive window cannot stall enumeration. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Enumerate every open window with a non-empty title and a targetable size.
 *
 * Untitled and tiny windows are filtered out because they are almost always
 * invisible helper / message-only windows, never something a user means when
 * they say "focus my editor". On a real desktop this cuts 263 raw handles to
 * the ~150 that are actually user-facing.
 */
export async function listWindows(): Promise<WindowInfo[]> {
  let handles: unknown[]
  try {
    const nut = loadNut()
    handles = await withTimeout(nut.getWindows(), WINDOW_CALL_TIMEOUT_MS, 'getWindows')
  } catch (err) {
    console.warn('[windowTarget] window enumeration unavailable:', errText(err))
    return []
  }

  const out: WindowInfo[] = []
  for (let i = 0; i < handles.length; i++) {
    const info = await describeWindow(handles[i], i)
    if (info && info.title.trim() && isTargetableWindow(info.bounds)) out.push(info)
  }
  return out
}

/** Read title + bounds off one nut-js Window, or null if it cannot be read. */
async function describeWindow(handle: unknown, index: number): Promise<WindowInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = handle as any
    const [title, region] = await Promise.all([
      withTimeout(Promise.resolve(w.getTitle()), WINDOW_CALL_TIMEOUT_MS, 'getTitle'),
      withTimeout(Promise.resolve(w.getRegion()), WINDOW_CALL_TIMEOUT_MS, 'getRegion')
    ])
    return {
      handle: index,
      title: String(title ?? ''),
      bounds: {
        left: Number(region?.left ?? 0),
        top: Number(region?.top ?? 0),
        width: Number(region?.width ?? 0),
        height: Number(region?.height ?? 0)
      }
    }
  } catch {
    // A window that closed mid-enumeration: skip it, do not fail the sweep.
    return null
  }
}

/** The nut-js Window object behind a WindowInfo.handle, or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleFor(info: WindowInfo): Promise<any | null> {
  try {
    const nut = loadNut()
    const handles = (await withTimeout(
      nut.getWindows(),
      WINDOW_CALL_TIMEOUT_MS,
      'getWindows'
    )) as unknown[]
    return handles[info.handle] ?? null
  } catch {
    return null
  }
}

/** The currently focused window, or null when it cannot be determined. */
export async function activeWindow(): Promise<WindowInfo | null> {
  try {
    const nut = loadNut()
    const handle = await withTimeout(nut.getActiveWindow(), WINDOW_CALL_TIMEOUT_MS, 'getActiveWindow')
    return await describeWindow(handle, -1)
  } catch (err) {
    console.warn('[windowTarget] active window unavailable:', errText(err))
    return null
  }
}

/**
 * Find the window best matching a human phrase ("word", "chrome", "my editor").
 * Returns null rather than a low-confidence guess — see MIN_WINDOW_MATCH_SCORE.
 */
export async function findWindow(query: string): Promise<WindowInfo | null> {
  return bestWindow(await listWindows(), query)
}

export interface WindowActionResult {
  ok: boolean
  error?: string
}

/**
 * Bring a window to the foreground.
 *
 * Restores first: a minimized window cannot receive focus on Windows, and
 * focusing it silently no-ops, which would leave the automation loop typing
 * into whatever was actually in front.
 */
export async function focusWindow(info: WindowInfo): Promise<WindowActionResult> {
  const w = await handleFor(info)
  if (!w) return { ok: false, error: `Window "${info.title}" is no longer open.` }
  try {
    if (typeof w.restore === 'function') {
      await withTimeout(Promise.resolve(w.restore()), WINDOW_CALL_TIMEOUT_MS, 'restore').catch(
        () => undefined // not all platforms implement restore; focus may still work
      )
    }
    await withTimeout(Promise.resolve(w.focus()), WINDOW_CALL_TIMEOUT_MS, 'focus')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `Could not focus "${info.title}": ${errText(err)}` }
  }
}

/** Move and/or resize a window. Omitted fields are left unchanged. */
export async function setWindowBounds(
  info: WindowInfo,
  target: Partial<WindowBounds>
): Promise<WindowActionResult> {
  const w = await handleFor(info)
  if (!w) return { ok: false, error: `Window "${info.title}" is no longer open.` }
  const nut = loadNut()
  try {
    if (target.left !== undefined || target.top !== undefined) {
      const left = target.left ?? info.bounds.left
      const top = target.top ?? info.bounds.top
      await withTimeout(Promise.resolve(w.move(new nut.Point(left, top))), WINDOW_CALL_TIMEOUT_MS, 'move')
    }
    if (target.width !== undefined || target.height !== undefined) {
      const width = Math.max(1, target.width ?? info.bounds.width)
      const height = Math.max(1, target.height ?? info.bounds.height)
      await withTimeout(
        Promise.resolve(w.resize(new nut.Size(width, height))),
        WINDOW_CALL_TIMEOUT_MS,
        'resize'
      )
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `Could not reposition "${info.title}": ${errText(err)}` }
  }
}

/**
 * Re-read a window's current bounds.
 *
 * Callers that scope clicks to a window must refresh bounds after focusing it:
 * focusing frequently un-maximises or shifts a window, and a stale rectangle
 * would place every subsequent click at an offset.
 */
export async function refreshBounds(info: WindowInfo): Promise<WindowBounds | null> {
  const w = await handleFor(info)
  if (!w) return null
  const fresh = await describeWindow(w, info.handle)
  return fresh?.bounds ?? null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type { WindowInfo, WindowBounds } from './windowMatch'
