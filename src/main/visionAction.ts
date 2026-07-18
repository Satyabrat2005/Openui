/**
 * visionAction.ts — the pure protocol layer for the generalised
 * screenshot→reason→act loop (`computer_use` in tools.ts).
 *
 * WHY THIS IS SEPARATE: `tools.ts` imports `electron` (desktopCapturer, nut-js …)
 * at module load, so it cannot be imported in the plain-Node unit-test
 * environment. The parsing + coordinate-scaling logic below is the part that is
 * easy to get subtly wrong and injection-exposed (it turns untrusted vision-model
 * output into real mouse/keyboard commands), so it lives here as pure functions
 * with no side effects — exactly the split already used by `toolCallParser.ts`
 * and `fs/pathSafety.ts`. `tools.ts` owns the actual capture + I/O.
 */
import { extractFirstJsonObject } from './toolCallParser'

/**
 * One step the vision model asks the loop to take. `click`/`type` are executed
 * (via move_mouse/left_click/type_text); `done`/`fail` terminate the loop.
 * Coordinates are in the SCREENSHOT's pixel space (not the real display) — the
 * loop scales them with scaleToScreen() before driving the mouse.
 */
export interface VisionAction {
  action: 'click' | 'type' | 'key' | 'scroll' | 'done' | 'fail'
  /** click: x in image-space pixels. */
  x?: number
  /** click: y in image-space pixels. */
  y?: number
  /** type: the text to synthesise into the focused element. */
  text?: string
  /** key: allow-listed combo tokens, joined into a press_keys combo (e.g. ["ctrl","f"]). */
  keys?: string[]
  /** scroll: which way to scroll from the current pointer position. */
  direction?: ScrollDirection
  /** scroll: how many wheel steps (clamped to MAX_SCROLL_AMOUNT). */
  amount?: number
  /** click/type/key/scroll: a short rationale, surfaced in the trajectory. */
  why?: string
  /** done: what was accomplished. */
  summary?: string
  /** fail: why the goal cannot be completed. */
  reason?: string
}

/** The four scroll directions the loop can execute. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right'])

/**
 * Key tokens accepted from the model, normalised to the canonical spelling that
 * `tools.ts:parseKeyCombo` understands (it owns the token → nut-js `Key`
 * mapping and the modifier ordering; this table does not duplicate that work).
 *
 * This is an ALLOW-LIST, and that is deliberate: `parseKeyCombo` accepts the
 * full keyboard because it backs the `press_keys` tool, which a human approves
 * per call. The vision loop is different — its input is model output steered by
 * whatever is on screen, so it must not be able to reach the whole keyboard.
 *
 * The SUPER/Command modifier is deliberately absent. It is the one modifier
 * that reaches an OS-level launcher rather than the focused app, and every
 * route it opens ends in arbitrary code execution once chained with this
 * loop's own `type` action: Win+R → Run dialog, Cmd+Space → Spotlight, and
 * bare Win/Cmd → Start menu, all of which accept a typed command and Enter.
 * Losing Cmd+C/Cmd+V on macOS is the cost; the loop can use menus instead.
 *
 * Letters are also restricted to a/c/v/x/f (select-all, copy, paste, cut,
 * find) so that no unforeseen Ctrl/Alt combo becomes reachable either.
 */
export const ALLOWED_KEYS: Readonly<Record<string, string>> = {
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  space: 'space',
  backspace: 'backspace',
  delete: 'delete',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  a: 'a',
  c: 'c',
  v: 'v',
  x: 'x',
  f: 'f'
}

/** A combo longer than this is not a UI interaction; it is something else. */
const MAX_KEYS_PER_COMBO = 3

/** Wheel steps are clamped so one action cannot scroll a document endlessly. */
export const MAX_SCROLL_AMOUNT = 10

/** Narrow an unknown to a trimmed string, or undefined. */
function optStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length ? t : undefined
}

/**
 * The strict instruction given to the vision model each turn. It fixes the
 * output contract to a single raw JSON action so parseVisionAction() can consume
 * it deterministically, and pins coordinates to the screenshot's own dimensions
 * (which may differ from the real display resolution — see scaleToScreen).
 */
export function buildVisionSystemPrompt(imgW: number, imgH: number): string {
  return [
    'You are OpenUI operating a computer by looking at a screenshot and issuing ONE action at a time to accomplish the user\'s goal.',
    `The screenshot is ${imgW}x${imgH} pixels, origin (0,0) at the top-left.`,
    'Reply with EXACTLY ONE raw JSON object and NOTHING else — no prose, no explanation outside the JSON, no markdown code fences. It must be one of:',
    `{"action":"click","x":<int 0-${imgW}>,"y":<int 0-${imgH}>,"why":"short reason"}`,
    '{"action":"type","text":"text to type into the currently focused field","why":"short reason"}',
    `{"action":"key","keys":["ctrl","f"],"why":"short reason"} — at most 3 keys from: ${Object.keys(ALLOWED_KEYS).join(', ')}`,
    `{"action":"scroll","direction":"up|down|left|right","amount":<int 1-${MAX_SCROLL_AMOUNT}>,"why":"short reason"}`,
    '{"action":"done","summary":"what was accomplished"}',
    '{"action":"fail","reason":"why the goal cannot be completed"}',
    'Guidance: click a field to focus it BEFORE you type into it. Emit "done" as soon as the goal is visibly achieved. Emit "fail" if you are stuck, the goal is impossible, or you would be repeating a step that already did not work.',
    'If a previous step reports that it did not change the screen, do NOT simply repeat it — the target was probably missed. Re-examine the screenshot and pick a different coordinate or approach.'
  ].join('\n')
}

/**
 * Parse a vision-model reply into a validated VisionAction. This is a trust
 * boundary: the reply is model output steered by whatever is on screen, so every
 * field is validated before the loop is allowed to act on it. Returns a tagged
 * result rather than throwing so the caller can feed the error back to the model.
 */
export function parseVisionAction(
  text: string
): { ok: true; action: VisionAction } | { ok: false; error: string } {
  const json = extractFirstJsonObject(text)
  if (!json) {
    return { ok: false, error: `no JSON action found in the reply: ${text.slice(0, 160)}` }
  }
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    return { ok: false, error: `action was not valid JSON: ${json.slice(0, 160)}` }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: 'action must be a JSON object' }
  }
  const o = obj as Record<string, unknown>

  switch (o.action) {
    case 'click': {
      const x = Number(o.x)
      const y = Number(o.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: '"click" requires finite numeric "x" and "y"' }
      }
      return { ok: true, action: { action: 'click', x, y, why: optStr(o.why) } }
    }
    case 'type': {
      if (typeof o.text !== 'string' || o.text.length === 0) {
        return { ok: false, error: '"type" requires a non-empty "text" string' }
      }
      return { ok: true, action: { action: 'type', text: o.text, why: optStr(o.why) } }
    }
    case 'key': {
      if (!Array.isArray(o.keys) || o.keys.length === 0) {
        return { ok: false, error: '"key" requires a non-empty "keys" array' }
      }
      if (o.keys.length > MAX_KEYS_PER_COMBO) {
        return {
          ok: false,
          error: `"key" accepts at most ${MAX_KEYS_PER_COMBO} keys, got ${o.keys.length}`
        }
      }
      const mapped: string[] = []
      for (const raw of o.keys) {
        if (typeof raw !== 'string') {
          return { ok: false, error: '"keys" entries must be strings' }
        }
        const nutKey = ALLOWED_KEYS[raw.trim().toLowerCase()]
        if (!nutKey) {
          return {
            ok: false,
            error: `key ${JSON.stringify(raw)} is not permitted; allowed keys: ${Object.keys(ALLOWED_KEYS).join(', ')}`
          }
        }
        mapped.push(nutKey)
      }
      return { ok: true, action: { action: 'key', keys: mapped, why: optStr(o.why) } }
    }
    case 'scroll': {
      const direction = typeof o.direction === 'string' ? o.direction.trim().toLowerCase() : ''
      if (!SCROLL_DIRECTIONS.has(direction)) {
        return { ok: false, error: '"scroll" requires "direction" of up, down, left or right' }
      }
      // Default to a modest 3-step scroll when the model omits an amount; clamp
      // to at least 1 so a "0" can never make the action a silent no-op that
      // the verifier would then read as a failed step.
      const raw = o.amount === undefined ? 3 : Number(o.amount)
      if (!Number.isFinite(raw)) {
        return { ok: false, error: '"scroll" requires a finite numeric "amount"' }
      }
      const amount = Math.max(1, Math.min(MAX_SCROLL_AMOUNT, Math.round(raw)))
      return {
        ok: true,
        action: { action: 'scroll', direction: direction as ScrollDirection, amount, why: optStr(o.why) }
      }
    }
    case 'done':
      return { ok: true, action: { action: 'done', summary: optStr(o.summary) } }
    case 'fail':
      return { ok: true, action: { action: 'fail', reason: optStr(o.reason) } }
    default:
      return {
        ok: false,
        error:
          `unknown action ${JSON.stringify(o.action)}; ` +
          'expected "click", "type", "key", "scroll", "done" or "fail"'
      }
  }
}

/**
 * Map a coordinate from screenshot pixel space to real-display pixel space.
 *
 * The screen is captured as a thumbnail whose dimensions rarely equal the actual
 * display resolution (Electron preserves aspect ratio but scales to fit the
 * requested box), while the mouse is driven in true display pixels. Without this
 * scaling a click computed on a 1920×1080 thumbnail would land in the wrong place
 * on a 2560×1440 monitor. Falls back to a 1:1 mapping when either dimension is
 * unknown (0), which is the safest no-op.
 */
export function scaleToScreen(
  x: number,
  y: number,
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number
): { x: number; y: number } {
  const sx = imgW > 0 && screenW > 0 ? screenW / imgW : 1
  const sy = imgH > 0 && screenH > 0 ? screenH / imgH : 1
  return { x: Math.round(x * sx), y: Math.round(y * sy) }
}
