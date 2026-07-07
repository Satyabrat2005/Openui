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
  action: 'click' | 'type' | 'done' | 'fail'
  /** click: x in image-space pixels. */
  x?: number
  /** click: y in image-space pixels. */
  y?: number
  /** type: the text to synthesise into the focused element. */
  text?: string
  /** click/type: a short rationale, surfaced in the trajectory summary. */
  why?: string
  /** done: what was accomplished. */
  summary?: string
  /** fail: why the goal cannot be completed. */
  reason?: string
}

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
    '{"action":"done","summary":"what was accomplished"}',
    '{"action":"fail","reason":"why the goal cannot be completed"}',
    'Guidance: click a field to focus it BEFORE you type into it. Emit "done" as soon as the goal is visibly achieved. Emit "fail" if you are stuck, the goal is impossible, or you would be repeating a step that already did not work.'
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
    case 'done':
      return { ok: true, action: { action: 'done', summary: optStr(o.summary) } }
    case 'fail':
      return { ok: true, action: { action: 'fail', reason: optStr(o.reason) } }
    default:
      return {
        ok: false,
        error: `unknown action ${JSON.stringify(o.action)}; expected "click", "type", "done" or "fail"`
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
