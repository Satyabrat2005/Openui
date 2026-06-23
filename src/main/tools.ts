/**
 * tools.ts — OS automation tools the agent can invoke from the Electron main
 * process.
 *
 * SECURITY: these functions give the model real control over the machine —
 * launching apps, searching the filesystem, editing the Calendar, and
 * synthesising mouse/keyboard input. They must only ever run as a direct result
 * of an explicit user request routed through the agent loop, never speculatively.
 *
 * PLATFORM: `open_app`, `search_files` and `control_calendar` rely on macOS-only
 * facilities (AppleScript via `osascript`, and Spotlight's `mdfind`); they throw
 * a clear error on other platforms. The pointer/keyboard tools use
 * `@nut-tree/nut-js`, which is cross-platform and therefore also usable on
 * Windows/Linux during development.
 *
 * Native packages are loaded lazily with `require()` rather than a static
 * `import`, so the bundle typechecks and builds even when they are not yet
 * installed. A missing or unsupported package surfaces as a friendly
 * `ToolResult` error instead of crashing the agent loop.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { desktopCapturer } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { checkAccessibility, type PermissionTarget } from './permissions'

// execFile (no shell) is used instead of exec so arguments are passed as an
// argv array — there is no shell to interpret quotes, pipes, $(...) or `;`.
const execFileAsync = promisify(execFile)

/** Uniform result shape every tool returns; tools never throw to the loop. */
export interface ToolResult {
  ok: boolean
  output?: string
  error?: string
  /**
   * When set, the agent loop emits openui:permission:denied so the renderer
   * can show a modal guiding the user to grant the required OS permission.
   */
  permissionDenied?: PermissionTarget
}

/** JSON-Schema-style description used both to prompt the LLM and to validate. */
export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
}

/** Which backend tier the agent is running under. */
export type Tier = 'free' | 'pro' | 'enterprise'

/** Runtime context injected by the agent loop into every tool execution. */
export interface ExecutorContext {
  tier: Tier
}

type Executor = (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>

// ── lazy native-module loading ──────────────────────────────────────────────

/** require() the first module name that resolves; throws if none do. */
function requireFirst(names: string[]): unknown {
  const failures: string[] = []
  for (const name of names) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(name)
    } catch (err) {
      failures.push(`${name} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  throw new Error(`Could not load required native module: tried ${failures.join(', ')}`)
}

function assertMac(tool: string): void {
  if (process.platform !== 'darwin') {
    throw new Error(`${tool} is only available on macOS (current platform: ${process.platform}).`)
  }
}

/**
 * Escape a JS string for safe interpolation into an AppleScript double-quoted
 * string literal.
 *
 * SECURITY: `node-osascript`'s variable-injection helper serialises strings as
 * `'"' + value + '"'` with NO escaping, so any `"` in a value breaks out of the
 * literal and the rest of the value is executed as AppleScript (e.g.
 * `do shell script "…"` → arbitrary command execution). We therefore build the
 * full script ourselves with every untrusted value passed through this escaper
 * and never use the package's variable injection.
 */
function asStringLiteral(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * Run a fully-formed AppleScript via `node-osascript`. No variables are passed —
 * all dynamic values must already be embedded as escaped literals (see
 * `asStringLiteral`) by the caller, so the broken serialiser is never exercised.
 */
function runAppleScript(script: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const osascript = requireFirst(['node-osascript']) as any
  return new Promise<string>((resolve, reject) => {
    osascript.execute(script, (err: unknown, result: unknown): void => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(Array.isArray(result) ? result.join(', ') : String(result ?? ''))
    })
  })
}

/**
 * Whitelist of characters allowed in a macOS application name. Real app names
 * are short and contain only letters, digits, spaces and a few punctuation
 * marks; rejecting anything else is defence-in-depth on top of the escaping.
 */
const APP_NAME_RE = /^[A-Za-z0-9 ._+()&'-]{1,128}$/

/** Lazily load nut-js, falling back to the community fork (same public API). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadNut(): any {
  return requireFirst(['@nut-tree/nut-js', '@nut-tree-fork/nut-js'])
}

// ── tool implementations ────────────────────────────────────────────────────

/** Launch or focus a macOS application by name. */
async function open_app(args: Record<string, unknown>): Promise<ToolResult> {
  assertMac('open_app')
  // Only a plain string is accepted — a nested object / array is rejected here
  // (it can never reach the shell as a structured payload).
  const raw = typeof args.appName === 'string' ? args.appName : typeof args.name === 'string' ? args.name : ''
  const appName = raw.trim()
  if (!appName) return { ok: false, error: 'open_app requires a string "appName".' }
  if (!APP_NAME_RE.test(appName)) {
    return { ok: false, error: `open_app received an invalid application name: ${JSON.stringify(appName)}.` }
  }
  try {
    await runAppleScript(`tell application ${asStringLiteral(appName)} to activate`)
    return { ok: true, output: `Activated ${appName}.` }
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Search the filesystem with Spotlight (`mdfind`) and return matching paths. */
async function search_files(args: Record<string, unknown>): Promise<ToolResult> {
  assertMac('search_files')
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { ok: false, error: 'search_files requires a string "query".' }
  if (query.length > 512) return { ok: false, error: 'search_files "query" is too long.' }
  try {
    // execFile passes `query` as a single argv element to mdfind — no shell is
    // spawned, so shell metacharacters in the query are inert. Results are
    // capped in JS instead of piping through `head`.
    const { stdout } = await execFileAsync('mdfind', [query], { maxBuffer: 1024 * 1024 })
    const files = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20)
    if (files.length === 0) return { ok: true, output: `No files matched "${query}".` }
    return { ok: true, output: `Found ${files.length} file(s):\n${files.join('\n')}` }
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Create an event in, or list today's events from, the macOS Calendar. */
async function control_calendar(args: Record<string, unknown>): Promise<ToolResult> {
  assertMac('control_calendar')
  const action = (typeof args.action === 'string' ? args.action : '').trim().toLowerCase()
  // eventDetails must be a plain object when provided (not a string/array).
  const rawDetails = args.eventDetails
  const details =
    typeof rawDetails === 'object' && rawDetails !== null && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : {}

  /** Coerce a detail field to a trimmed string, accepting only string inputs. */
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

  if (action === 'create') {
    const title = str(details.title) || str(details.summary)
    if (!title) return { ok: false, error: 'control_calendar "create" requires a string eventDetails.title.' }
    const calName = str(details.calendar) || 'Calendar'
    const start = str(details.start)
    const end = str(details.end)
    const notes = str(details.notes)

    // start/end are coerced from natural date strings to AppleScript dates.
    // When omitted we default to a one-hour event beginning now. Every dynamic
    // value is inlined as an escaped string literal — never via the (unescaped)
    // node-osascript variable injection.
    const script = [
      'set startDate to (current date)',
      start ? `set startDate to date ${asStringLiteral(start)}` : '',
      'set endDate to startDate + (60 * minutes)',
      end ? `set endDate to date ${asStringLiteral(end)}` : '',
      'tell application "Calendar"',
      `  tell calendar ${asStringLiteral(calName)}`,
      `    make new event with properties {summary:${asStringLiteral(title)}, start date:startDate, end date:endDate, description:${asStringLiteral(notes)}}`,
      '  end tell',
      'end tell',
      'return "created"'
    ]
      .filter(Boolean)
      .join('\n')

    try {
      await runAppleScript(script)
      return { ok: true, output: `Created event "${title}" in calendar "${calName}".` }
    } catch (err) {
      return {
        ok: false,
        error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  if (action === 'list') {
    // Best-effort listing of today's events across every calendar.
    const script = [
      'set todayStart to (current date)',
      'set hours of todayStart to 0',
      'set minutes of todayStart to 0',
      'set seconds of todayStart to 0',
      'set todayEnd to todayStart + (1 * days)',
      'set output to ""',
      'tell application "Calendar"',
      '  repeat with cal in calendars',
      '    repeat with evt in (every event of cal whose start date >= todayStart and start date < todayEnd)',
      '      set output to output & (summary of evt) & " @ " & (start date of evt as string) & linefeed',
      '    end repeat',
      '  end repeat',
      'end tell',
      'return output'
    ].join('\n')
    try {
      const out = (await runAppleScript(script)).trim()
      return { ok: true, output: out ? `Today's events:\n${out}` : 'No events scheduled today.' }
    } catch (err) {
      return {
        ok: false,
        error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  return { ok: false, error: `Unknown calendar action "${action}". Use "create" or "list".` }
}

/** Move the mouse pointer to absolute screen coordinates. */
async function move_mouse(args: Record<string, unknown>): Promise<ToolResult> {
  const x = Number(args.x)
  const y = Number(args.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: 'move_mouse requires numeric "x" and "y".' }
  }
  if (!checkAccessibility()) {
    return {
      ok: false,
      error:
        'Tool execution failed: Missing OS permissions — Accessibility access is required for mouse control. ' +
        'Please grant access in System Settings → Privacy & Security → Accessibility.',
      permissionDenied: 'accessibility'
    }
  }
  try {
    const nut = loadNut()
    await nut.mouse.setPosition(new nut.Point(x, y))
    return { ok: true, output: `Moved pointer to (${x}, ${y}).` }
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Perform a single left-button click at the current pointer position. */
async function left_click(_args: Record<string, unknown>): Promise<ToolResult> {
  if (!checkAccessibility()) {
    return {
      ok: false,
      error:
        'Tool execution failed: Missing OS permissions — Accessibility access is required for mouse control. ' +
        'Please grant access in System Settings → Privacy & Security → Accessibility.',
      permissionDenied: 'accessibility'
    }
  }
  try {
    const nut = loadNut()
    await nut.mouse.leftClick()
    return { ok: true, output: 'Performed a left click.' }
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** Type a string via synthesised keyboard input. */
async function type_text(args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.text ?? '')
  if (!text) return { ok: false, error: 'type_text requires non-empty "text".' }
  if (!checkAccessibility()) {
    return {
      ok: false,
      error:
        'Tool execution failed: Missing OS permissions — Accessibility access is required for keyboard control. ' +
        'Please grant access in System Settings → Privacy & Security → Accessibility.',
      permissionDenied: 'accessibility'
    }
  }
  try {
    const nut = loadNut()
    await nut.keyboard.type(text)
    return { ok: true, output: `Typed ${text.length} character(s).` }
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Capture the primary display and return a description of its UI elements.
 *
 * Pro/Enterprise: sends the screenshot to Claude Vision, which returns each
 * visible element with its approximate X,Y coordinates.
 *
 * Free: runs Tesseract.js OCR locally and returns the extracted text.
 *
 * macOS: the app must have Screen Recording permission granted in
 * System Settings → Privacy & Security → Screen Recording; without it,
 * the captured image will be blank.
 */
async function read_screen(
  _args: Record<string, unknown>,
  context?: ExecutorContext
): Promise<ToolResult> {
  const tier = context?.tier ?? 'free'

  // ── 1. Capture the primary display ────────────────────────────────────────
  let pngBuffer: Buffer
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    if (!sources.length) {
      return {
        ok: false,
        error:
          'No screen sources found. Ensure Screen Recording permission is granted in ' +
          'System Settings → Privacy & Security → Screen Recording.'
      }
    }
    pngBuffer = sources[0].thumbnail.toPNG()
  } catch (err) {
    return {
      ok: false,
      error: `Screen capture failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const base64Image = pngBuffer.toString('base64')

  // ── 2. Analyse: Vision API (pro/enterprise) or local OCR (free) ───────────
  if (tier === 'pro' || tier === 'enterprise') {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: base64Image }
              },
              {
                type: 'text',
                text: 'Describe the UI elements and their X,Y coordinates.'
              }
            ]
          }
        ]
      })
      const description = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      return { ok: true, output: description }
    } catch (err) {
      return {
        ok: false,
        error: `Tool execution failed: screen analysis error — ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  // Free tier: local OCR via tesseract.js (loaded lazily — may not be installed)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Tesseract = requireFirst(['tesseract.js']) as any
    const { data } = (await Tesseract.recognize(pngBuffer, 'eng', {
      logger: () => {} // suppress progress events
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as { data: { text: string } }
    return { ok: true, output: `Screen OCR text:\n${data.text}` }
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: OCR error — ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

// ── schemas + dispatch (the LLM-facing surface) ─────────────────────────────

/** JSON schemas the agent injects into the system prompt so the LLM can call. */
export const toolSchemas: ToolSchema[] = [
  {
    name: 'open_app',
    description: 'Launch or focus a macOS application by name (e.g. "Safari", "Calendar").',
    parameters: {
      type: 'object',
      properties: { appName: { type: 'string', description: 'The application name to open.' } },
      required: ['appName']
    }
  },
  {
    name: 'search_files',
    description: 'Search the local filesystem with Spotlight (mdfind) and return matching paths.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text or raw Spotlight query.' } },
      required: ['query']
    }
  },
  {
    name: 'control_calendar',
    description: "Create an event in, or list today's events from, the macOS Calendar app.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Either "create" or "list".', enum: ['create', 'list'] },
        eventDetails: {
          type: 'object',
          description:
            'For "create": {title, start, end, calendar, notes}. Dates are natural strings, e.g. "June 24, 2026 11:00 AM".'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'move_mouse',
    description: 'Move the mouse pointer to absolute screen coordinates.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in pixels.' },
        y: { type: 'number', description: 'Y coordinate in pixels.' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'left_click',
    description: 'Perform a single left mouse-button click at the current pointer position.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'type_text',
    description: 'Type a string of text via synthesised keyboard input.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to type.' } },
      required: ['text']
    }
  },
  {
    name: 'read_screen',
    description:
      'Capture the primary display as a PNG and analyse its contents. ' +
      'On pro/enterprise tiers, sends the image to Claude Vision which returns a description of every visible UI element with its approximate X,Y coordinates. ' +
      'On the free tier, runs Tesseract OCR locally and returns the extracted text. ' +
      'Call this before move_mouse()/left_click() when the target element has no AppleScript API ' +
      '(e.g. browser tabs, VS Code extension panels, web apps). ' +
      'macOS requires Screen Recording permission in System Settings → Privacy & Security.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

const registry: Record<string, Executor> = {
  open_app,
  search_files,
  control_calendar,
  move_mouse,
  left_click,
  type_text,
  read_screen
}

/**
 * Validate an LLM-supplied argument object against a tool's JSON schema before
 * the executor runs. This is the trust boundary between model output (which may
 * be steered by prompt injection in tool results / screen contents) and code
 * that drives the OS. Returns an error string, or null when the args are valid.
 *
 * Type rules: `string` ⇒ JS string (rejects nested objects/arrays/numbers),
 * `number` ⇒ finite number, `object` ⇒ non-null plain object. `enum` values
 * are checked for membership. Required keys must be present and non-null.
 */
function validateArgs(schema: ToolSchema, args: Record<string, unknown>): string | null {
  for (const key of schema.parameters.required) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return `missing required argument "${key}"`
    }
  }
  for (const [key, spec] of Object.entries(schema.parameters.properties)) {
    if (!(key in args) || args[key] === undefined || args[key] === null) continue
    const val = args[key]
    if (spec.type === 'string') {
      if (typeof val !== 'string') return `"${key}" must be a string`
      if (spec.enum && !spec.enum.includes(val)) {
        return `"${key}" must be one of: ${spec.enum.join(', ')}`
      }
    } else if (spec.type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val)) return `"${key}" must be a finite number`
    } else if (spec.type === 'object') {
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        return `"${key}" must be an object`
      }
    }
  }
  return null
}

/**
 * Execute a tool by name. Never throws — any failure (unknown tool, bad args,
 * platform/package error) is returned as `{ ok: false, error }` so the agent
 * loop can feed the failure back to the model and keep reasoning.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ExecutorContext = { tier: 'free' }
): Promise<ToolResult> {
  const schema = toolSchemas.find((s) => s.name === name)
  const fn = registry[name]
  if (!schema || !fn) return { ok: false, error: `Unknown tool "${name}".` }

  // Reject anything that is not a plain object before per-field validation.
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, error: `Invalid arguments for "${name}": expected an object.` }
  }
  const validationError = validateArgs(schema, args)
  if (validationError) {
    return { ok: false, error: `Invalid arguments for "${name}": ${validationError}.` }
  }

  try {
    return await fn(args, context)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Short human-readable label for a tool call, shown in the task-list UI. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'open_app':
      return `Open ${String(args.appName ?? args.name ?? 'app')}`
    case 'search_files':
      return `Search files for "${String(args.query ?? '')}"`
    case 'control_calendar': {
      const action = String(args.action ?? '')
      const details = (args.eventDetails ?? {}) as Record<string, unknown>
      return action === 'create'
        ? `Add calendar event "${String(details.title ?? details.summary ?? '')}"`
        : 'List calendar events'
    }
    case 'move_mouse':
      return `Move mouse to (${Number(args.x)}, ${Number(args.y)})`
    case 'left_click':
      return 'Left click'
    case 'type_text':
      return 'Type text'
    case 'read_screen':
      return 'Read screen'
    default:
      return name
  }
}
