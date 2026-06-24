/**
 * tools.ts — OS automation tools the agent can invoke from the Electron main
 * process. Cross-platform: macOS (AppleScript) + Windows (PowerShell) + Linux
 * (best-effort fallbacks).
 *
 * SECURITY: these functions give the model real control over the machine —
 * launching apps, searching the filesystem, editing the Calendar, and
 * synthesising mouse/keyboard input. They must only ever run as a direct result
 * of an explicit user request routed through the agent loop, never speculatively.
 *
 * PLATFORM: open_app, search_files, and control_calendar select a backend at
 * call time via process.platform:
 *   macOS   → AppleScript via node-osascript (lazy-loaded)
 *   Windows → PowerShell (Start-Process / Get-ChildItem / Outlook COM)
 *   Linux   → best-effort xdg-open / find (limited functionality)
 * Mouse/keyboard tools use @nut-tree/nut-js which is cross-platform.
 *
 * Native packages are loaded lazily with require() rather than a static
 * import, so the bundle typechecks and builds even when they are not yet
 * installed. A missing or unsupported package surfaces as a friendly
 * ToolResult error instead of crashing the agent loop.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { desktopCapturer } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { checkAccessibility, type PermissionTarget } from './permissions'
import { githubToolSchemas, githubRegistry } from './github'
import { figmaToolSchemas, figmaRegistry } from './figma'

// execFile (no shell) is used so arguments are passed as an argv array —
// there is no shell to interpret quotes, pipes, $(...) or `;`.
const execFileAsync = promisify(execFile)

// Platform flags evaluated once at module load — tools branch on these
// rather than calling process.platform on every invocation.
const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'

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

// ── macOS helpers (AppleScript via node-osascript) ────────────────────────────

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

/**
 * Escape a JS string for safe interpolation into an AppleScript double-quoted
 * string literal.
 *
 * SECURITY: node-osascript's variable-injection helper serialises strings as
 * '"' + value + '"' with NO escaping, so any '"' in a value breaks out of the
 * literal and the rest of the value is executed as AppleScript. We therefore
 * build the full script ourselves with every untrusted value passed through
 * this escaper and never use the package's variable injection.
 */
function asStringLiteral(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * Run a fully-formed AppleScript via node-osascript. All dynamic values must
 * already be embedded as escaped literals via asStringLiteral() — the broken
 * built-in serialiser is never exercised.
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

// ── Windows helpers (PowerShell) ──────────────────────────────────────────────

/**
 * Absolute path to the Windows PowerShell binary.
 *
 * SECURITY: invoking a bare "powershell.exe" lets Windows' CreateProcess search
 * order resolve the name, which — depending on process configuration — can
 * include the current working directory. A planted powershell.exe in the CWD
 * would then run instead of the real interpreter (binary-planting / search-order
 * hijack → code execution). Resolving the full path under %SystemRoot% removes
 * that ambiguity.
 */
function powerShellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

// Hard wall-clock bound on every PowerShell child (also guards against a hung
// Outlook COM call) plus a 1 MiB stdout cap.
const PS_TIMEOUT_MS = 15_000
const PS_MAX_BUFFER = 1024 * 1024

/**
 * Spawn PowerShell with a fixed argv and an optional set of EXTRA ENVIRONMENT
 * VARIABLES.
 *
 * SECURITY — parameterization, not concatenation. Untrusted values (app names,
 * search queries, calendar fields) are passed ONLY through the child's
 * environment and read inside the script via `$env:NAME`. They never appear in
 * the command/script text, so they can never be re-parsed as PowerShell code,
 * regardless of their contents. This is the PowerShell equivalent of a
 * parameterized query and replaces all string-building of dynamic values.
 */
function runPowerShellArgs(
  args: string[],
  extraEnv?: Record<string, string>
): Promise<{ stdout: string }> {
  return execFileAsync(powerShellPath(), ['-NoProfile', '-NonInteractive', ...args], {
    maxBuffer: PS_MAX_BUFFER,
    timeout: PS_TIMEOUT_MS,
    windowsHide: true,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env
  })
}

/**
 * Execute a single-line PowerShell command via -Command and return stdout.
 * The `command` text MUST be static; supply any untrusted data through
 * `extraEnv` and reference it as `$env:NAME` inside the command.
 */
async function runPowerShell(command: string, extraEnv?: Record<string, string>): Promise<string> {
  const { stdout } = await runPowerShellArgs(['-Command', command], extraEnv)
  return stdout.trim()
}

/**
 * Execute a multi-line PowerShell script via -EncodedCommand (base64-encoded
 * UTF-16LE). This sidesteps all command-line quoting issues — the script text
 * is decoded verbatim by PowerShell with no shell interpretation. As with
 * runPowerShell, untrusted data MUST be supplied via `extraEnv` and read as
 * `$env:NAME`; never interpolate it into the script text.
 */
async function runPowerShellScript(
  script: string,
  extraEnv?: Record<string, string>
): Promise<string> {
  // PowerShell -EncodedCommand accepts base64(UTF-16LE).
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await runPowerShellArgs(['-EncodedCommand', encoded], extraEnv)
  return stdout.trim()
}

// ── common helpers ────────────────────────────────────────────────────────────

/**
 * Whitelist of characters allowed in an application name. Real app names are
 * short and contain only letters, digits, spaces and a few punctuation marks;
 * rejecting anything else is defence-in-depth on top of the per-platform escaping.
 */
const APP_NAME_RE = /^[A-Za-z0-9 ._+()&'-]{1,128}$/

/**
 * Windows executables open_app refuses to launch. Pairing open_app with
 * type_text turns "launch a program" into arbitrary code execution (open a
 * shell / scripting host, then synthesise keystrokes into it); regedit/reg and
 * the listed system tools also tamper with the registry and machine config.
 * Blocking them by base name raises the bar for an injection-steered model.
 *
 * NOTE: this is defence-in-depth, NOT a complete control — type_text can still
 * target a shell the user already has focused. The real mitigation is the
 * user-confirmation gate recommended for state-changing tools (see
 * SECURITY_AUDIT.md). Matched case-insensitively, with any ".exe" stripped.
 */
const WIN_BLOCKED_APPS = new Set([
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'bash', 'sh', 'zsh', 'wsl',
  'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
  'regedit', 'regedt32', 'reg', 'bcdedit', 'wmic'
])

/**
 * search_files result paths under these segments are withheld from the model.
 * They sit INSIDE the user's home folder (so confining the search to $HOME does
 * not exclude them) yet hold credentials, tokens and browser profiles —
 * AppData\Roaming on Windows, ~/.ssh, ~/.aws and friends elsewhere. search_files
 * only ever returns paths, so dropping these keeps the model from enumerating
 * sensitive material it has no need to see.
 */
const SENSITIVE_PATH_RE =
  /(^|[\\/])(AppData|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|Library[\\/]Keychains)([\\/]|$)/i

/** Lazily load nut-js, falling back to the community fork (same public API). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadNut(): any {
  return requireFirst(['@nut-tree/nut-js', '@nut-tree-fork/nut-js'])
}

// ── Playwright browser automation ─────────────────────────────────────────────

// Singleton headful Chromium browser and page.  null before the first
// browser_navigate call, or after the browser is closed/crashed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pwBrowser: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pwPage: any = null

/**
 * Lazy-load Playwright (must be `npm install`-ed separately, along with
 * `npx playwright install chromium`) and return the shared Page, launching a
 * headful Chromium window if none is already open.  The same browser window
 * persists across tool calls so the user can watch OpenUI work.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOrCreatePage(): Promise<any> {
  if (_pwPage) return _pwPage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pw = requireFirst(['playwright']) as any
  _pwBrowser = await pw.chromium.launch({ headless: false })
  _pwPage = await _pwBrowser.newPage()
  // Reset state if the browser is closed by the user or crashes.
  _pwBrowser.on('disconnected', () => {
    _pwBrowser = null
    _pwPage = null
  })
  return _pwPage
}

/**
 * Gracefully close the Playwright browser.  Should be called from the main
 * process before the Electron app quits so Chromium exits cleanly.
 */
export async function closeBrowser(): Promise<void> {
  if (_pwBrowser) {
    try {
      await _pwBrowser.close()
    } catch {
      // ignore — process exit will kill the child anyway
    }
    _pwBrowser = null
    _pwPage = null
  }
}

// Only http/https URLs are permitted — file://, javascript:, data: and similar
// schemes could read local files, execute scripts, or bypass navigation.
const ALLOWED_URL_SCHEME = /^https?:\/\//i
const MAX_URL_LEN = 2048
// CSS selectors provided by the model are length-bounded as a light sanity check.
const MAX_SELECTOR_LEN = 512

// ── tool implementations ──────────────────────────────────────────────────────

/**
 * Launch or focus an application by name.
 * macOS: AppleScript `tell application … to activate`
 * Windows: PowerShell `Start-Process`
 * Linux: xdg-open (best-effort)
 */
async function open_app(args: Record<string, unknown>): Promise<ToolResult> {
  const raw =
    typeof args.appName === 'string' ? args.appName : typeof args.name === 'string' ? args.name : ''
  const appName = raw.trim()
  if (!appName) return { ok: false, error: 'open_app requires a string "appName".' }
  if (!APP_NAME_RE.test(appName)) {
    return {
      ok: false,
      error: `open_app received an invalid application name: ${JSON.stringify(appName)}.`
    }
  }
  try {
    if (IS_MAC) {
      await runAppleScript(`tell application ${asStringLiteral(appName)} to activate`)
    } else if (IS_WIN) {
      const base = appName.toLowerCase().replace(/\.exe$/, '').trim()
      if (WIN_BLOCKED_APPS.has(base)) {
        return {
          ok: false,
          error: `open_app refuses to launch "${appName}": shells, scripting hosts and registry tools are blocked for safety.`
        }
      }
      // The app name is passed out-of-band via the environment and read as a
      // value ($env:OPENUI_APP); it never appears in the command text, so it
      // cannot be parsed as PowerShell code.
      await runPowerShell('Start-Process -FilePath $env:OPENUI_APP', { OPENUI_APP: appName })
    } else {
      // Linux best-effort: xdg-open treats the argument as a file/URI/app name.
      await execFileAsync('xdg-open', [appName])
    }
    return { ok: true, output: `Activated ${appName}.` }
  } catch (err) {
    return {
      ok: false,
      error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Search the filesystem and return matching file paths.
 * macOS:   Spotlight mdfind (no shell — query passed as argv element)
 * Windows: PowerShell Get-ChildItem (home dir, depth 5, filter *query*)
 * Linux:   find (home dir, maxdepth 6, case-insensitive name match)
 */
async function search_files(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { ok: false, error: 'search_files requires a string "query".' }
  if (query.length > 512) return { ok: false, error: 'search_files "query" is too long.' }
  try {
    let rawOutput: string
    if (IS_MAC) {
      // execFile passes `query` as a single argv element to mdfind — no shell
      // is spawned, so shell metacharacters in the query are inert.
      const { stdout } = await execFileAsync('mdfind', [query], { maxBuffer: 1024 * 1024 })
      rawOutput = stdout
    } else if (IS_WIN) {
      // The query is passed out-of-band via the environment and referenced as a
      // VALUE inside the filter ("*$q*"), never concatenated into the command
      // text — so its contents can never be parsed as PowerShell code.
      // -Path is hard-pinned to $HOME and -Filter matches leaf names only (no
      // path separators / ".."), so the search cannot traverse out of the home
      // directory regardless of the query.
      rawOutput = await runPowerShell(
        '$q = $env:OPENUI_QUERY; ' +
          'Get-ChildItem -Path $HOME -Recurse -Depth 5 -Filter "*$q*" ' +
          '-ErrorAction SilentlyContinue | ' +
          'Select-Object -First 20 -ExpandProperty FullName',
        { OPENUI_QUERY: query }
      )
    } else {
      // Linux: find with -iname; query is passed as a literal argv element.
      const { stdout } = await execFileAsync(
        'find',
        [process.env.HOME ?? '/', '-maxdepth', '6', '-iname', `*${query}*`],
        { maxBuffer: 1024 * 1024 }
      )
      rawOutput = stdout
    }
    const files = rawOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      // Withhold credential / token / browser-profile directories (AppData,
      // ~/.ssh, ~/.aws, Keychains, …) even though they live inside $HOME.
      .filter((p) => !SENSITIVE_PATH_RE.test(p))
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

/**
 * Create an event in, or list today's events from, the system calendar.
 * macOS:   AppleScript against Calendar.app
 * Windows: PowerShell Outlook COM (requires Microsoft Outlook to be installed)
 * Linux:   not supported
 */
async function control_calendar(args: Record<string, unknown>): Promise<ToolResult> {
  const action = (typeof args.action === 'string' ? args.action : '').trim().toLowerCase()
  const rawDetails = args.eventDetails
  const details =
    typeof rawDetails === 'object' && rawDetails !== null && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

  // ── macOS path (AppleScript / Calendar.app) ─────────────────────────────────
  if (IS_MAC) {
    if (action === 'create') {
      const title = str(details.title) || str(details.summary)
      if (!title)
        return {
          ok: false,
          error: 'control_calendar "create" requires a string eventDetails.title.'
        }
      const calName = str(details.calendar) || 'Calendar'
      const start = str(details.start)
      const end = str(details.end)
      const notes = str(details.notes)

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
        return {
          ok: true,
          output: out ? `Today's events:\n${out}` : 'No events scheduled today.'
        }
      } catch (err) {
        return {
          ok: false,
          error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    return {
      ok: false,
      error: `Unknown calendar action "${action}". Use "create" or "list".`
    }
  }

  // ── Windows path (Outlook COM via PowerShell) ────────────────────────────────
  if (IS_WIN) {
    if (action === 'list') {
      // The date values come from Get-Date (not user input) so no escaping needed.
      const script = `
try {
  $ol  = New-Object -ComObject Outlook.Application -ErrorAction Stop
  $ns  = $ol.GetNamespace('MAPI')
  $cal = $ns.GetDefaultFolder(9)
  $items = $cal.Items
  $items.Sort('[Start]')
  $items.IncludeRecurrences = $true
  $s = (Get-Date).ToString('MM/dd/yyyy HH:mm')
  $e = (Get-Date).AddDays(1).ToString('MM/dd/yyyy HH:mm')
  $f = $items.Restrict("[Start] >= '$s' AND [Start] < '$e'")
  $lines = @()
  foreach ($item in $f) { $lines += "$($item.Subject) @ $($item.Start)" }
  if ($lines.Count -eq 0) { 'No events scheduled today.' } else { $lines -join [char]10 }
} catch { 'Calendar not available (Microsoft Outlook required): ' + $_.Exception.Message }
`
      try {
        const output = await runPowerShellScript(script)
        return { ok: true, output: output || 'No events scheduled today.' }
      } catch (err) {
        return {
          ok: false,
          error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    if (action === 'create') {
      const title = str(details.title) || str(details.summary)
      if (!title)
        return {
          ok: false,
          error: 'control_calendar "create" requires a string eventDetails.title.'
        }
      const notes = str(details.notes)
      const startStr = str(details.start)
      const endStr = str(details.end)

      // Every untrusted value is passed out-of-band via the child's environment
      // and read with $env:… inside the script. There is NO interpolation of
      // user data into the script text, so PowerShell injection is structurally
      // impossible here. [DateTime]::Parse receives the value as a string and
      // throws (caught below) on anything that is not a valid date.
      const script = `
try {
  $ol   = New-Object -ComObject Outlook.Application -ErrorAction Stop
  $appt = $ol.CreateItem(1)
  $appt.Subject = $env:OPENUI_CAL_TITLE
  $appt.Body    = $env:OPENUI_CAL_NOTES
  if ($env:OPENUI_CAL_START) { $appt.Start = [DateTime]::Parse($env:OPENUI_CAL_START) }
  if ($env:OPENUI_CAL_END) { $appt.End = [DateTime]::Parse($env:OPENUI_CAL_END) } else { $appt.End = $appt.Start.AddHours(1) }
  $appt.Save()
  'Created calendar event: ' + $appt.Subject
} catch { 'Calendar not available (Microsoft Outlook required): ' + $_.Exception.Message }
`
      try {
        const output = await runPowerShellScript(script, {
          OPENUI_CAL_TITLE: title,
          OPENUI_CAL_NOTES: notes,
          OPENUI_CAL_START: startStr,
          OPENUI_CAL_END: endStr
        })
        return { ok: true, output: output || `Created event "${title}".` }
      } catch (err) {
        return {
          ok: false,
          error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    return {
      ok: false,
      error: `Unknown calendar action "${action}". Use "create" or "list".`
    }
  }

  // ── other platforms ──────────────────────────────────────────────────────────
  return {
    ok: false,
    error: 'control_calendar requires macOS (Calendar.app) or Windows (Microsoft Outlook).'
  }
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
 * macOS requires Screen Recording permission (System Settings → Privacy &
 * Security → Screen Recording). On Windows, Electron's desktopCapturer works
 * without additional OS permissions.
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
          'No screen sources found. ' +
          (IS_MAC
            ? 'Ensure Screen Recording permission is granted in System Settings → Privacy & Security → Screen Recording.'
            : 'Ensure the app has permission to capture the screen.')
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

/**
 * Navigate the shared headful Chromium browser to a URL.
 * Launches Chromium on the first call.  Only http/https URLs are accepted.
 */
async function browser_navigate(args: Record<string, unknown>): Promise<ToolResult> {
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  if (!url) return { ok: false, error: 'browser_navigate requires a string "url".' }
  if (url.length > MAX_URL_LEN) return { ok: false, error: 'browser_navigate "url" is too long.' }
  if (!ALLOWED_URL_SCHEME.test(url)) {
    return { ok: false, error: 'browser_navigate only accepts http:// and https:// URLs.' }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = await getOrCreatePage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const title: string = await page.title()
    return { ok: true, output: `Navigated to ${url}. Page title: "${title}".` }
  } catch (err) {
    return {
      ok: false,
      error: `browser_navigate failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Click an element on the current browser page using a CSS selector.
 * browser_navigate must be called first.
 */
async function browser_click(args: Record<string, unknown>): Promise<ToolResult> {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (!selector) return { ok: false, error: 'browser_click requires a string "selector".' }
  if (selector.length > MAX_SELECTOR_LEN) {
    return { ok: false, error: 'browser_click "selector" is too long.' }
  }
  if (!_pwPage) {
    return { ok: false, error: 'No browser page is open. Call browser_navigate first.' }
  }
  try {
    await _pwPage.click(selector, { timeout: 10_000 })
    return { ok: true, output: `Clicked element matching "${selector}".` }
  } catch (err) {
    return {
      ok: false,
      error: `browser_click failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Extract all visible text from the body of the current browser page.
 * Returns up to 12 000 characters so the model can reason about the content.
 */
async function browser_extract_text(_args: Record<string, unknown>): Promise<ToolResult> {
  if (!_pwPage) {
    return { ok: false, error: 'No browser page is open. Call browser_navigate first.' }
  }
  try {
    const raw: unknown = await _pwPage.evaluate(() => document.body?.innerText ?? '')
    const text = (typeof raw === 'string' ? raw : String(raw)).slice(0, 12_000)
    return { ok: true, output: text || '(page has no visible text)' }
  } catch (err) {
    return {
      ok: false,
      error: `browser_extract_text failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Fill a text input or textarea on the current browser page.
 * Clears any existing value before typing.
 */
async function browser_fill_input(args: Record<string, unknown>): Promise<ToolResult> {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  const text = typeof args.text === 'string' ? args.text : ''
  if (!selector) return { ok: false, error: 'browser_fill_input requires a string "selector".' }
  if (selector.length > MAX_SELECTOR_LEN) {
    return { ok: false, error: 'browser_fill_input "selector" is too long.' }
  }
  if (!_pwPage) {
    return { ok: false, error: 'No browser page is open. Call browser_navigate first.' }
  }
  try {
    await _pwPage.fill(selector, text, { timeout: 10_000 })
    return { ok: true, output: `Filled "${selector}" with ${text.length} character(s).` }
  } catch (err) {
    return {
      ok: false,
      error: `browser_fill_input failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

// ── schemas + dispatch (the LLM-facing surface) ──────────────────────────────

/** JSON schemas the agent injects into the system prompt so the LLM can call. */
export const toolSchemas: ToolSchema[] = [
  ...githubToolSchemas,
  ...figmaToolSchemas,
  {
    name: 'open_app',
    description:
      'Launch or focus an application by name. ' +
      'On macOS, use the display name (e.g. "Safari", "Calendar"). ' +
      'On Windows, use the executable name (e.g. "notepad", "msedge", "code").',
    parameters: {
      type: 'object',
      properties: { appName: { type: 'string', description: 'The application name to open.' } },
      required: ['appName']
    }
  },
  {
    name: 'search_files',
    description:
      'Search the local filesystem for files matching a query and return their paths. ' +
      'Uses Spotlight (mdfind) on macOS, Get-ChildItem on Windows, and find on Linux.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Filename keyword or search text.' } },
      required: ['query']
    }
  },
  {
    name: 'control_calendar',
    description:
      "Create an event in, or list today's events from, the system calendar. " +
      'Uses Calendar.app on macOS and Microsoft Outlook (via COM) on Windows.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Either "create" or "list".',
          enum: ['create', 'list']
        },
        eventDetails: {
          type: 'object',
          description:
            'For "create": {title, start, end, calendar, notes}. ' +
            'Dates are natural strings, e.g. "June 24, 2026 11:00 AM".'
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
      'Call this before move_mouse()/left_click() when the target element has no automation API ' +
      '(e.g. browser tabs, VS Code extension panels, web apps). ' +
      'macOS requires Screen Recording permission in System Settings → Privacy & Security.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the headful Chromium browser controlled by Playwright. ' +
      'Accepts only http:// and https:// URLs. Launches the browser automatically on the first call. ' +
      'Prefer this over the visual navigation workflow (read_screen → move_mouse → left_click) ' +
      'for ALL web-based tasks: booking flights, scraping websites, filling web forms, reading prices, ' +
      'searching the web, or any task where the primary surface is a web page.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to navigate to (must start with http:// or https://).'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_click',
    description:
      'Click an element on the current Playwright browser page using a CSS selector. ' +
      'Call browser_navigate first to open a page.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the element to click.' }
      },
      required: ['selector']
    }
  },
  {
    name: 'browser_extract_text',
    description:
      'Extract all visible text from the current Playwright browser page body (up to 12 000 characters). ' +
      'Use after browser_navigate to read page content, inspect form labels, or scrape data.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'browser_fill_input',
    description:
      'Fill a text input or textarea on the current Playwright browser page. ' +
      'Clears any existing value before typing.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the input or textarea to fill.' },
        text: { type: 'string', description: 'The text to type into the element.' }
      },
      required: ['selector', 'text']
    }
  }
]

const registry: Record<string, Executor> = {
  open_app,
  search_files,
  control_calendar,
  move_mouse,
  left_click,
  type_text,
  read_screen,
  browser_navigate,
  browser_click,
  browser_extract_text,
  browser_fill_input,
  ...githubRegistry,
  ...figmaRegistry
}

/**
 * Validate an LLM-supplied argument object against a tool's JSON schema before
 * the executor runs. This is the trust boundary between model output (which may
 * be steered by prompt injection in tool results / screen contents) and code
 * that drives the OS. Returns an error string, or null when the args are valid.
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
    case 'browser_navigate':
      return `Navigate to ${String(args.url ?? '')}`
    case 'browser_click':
      return `Click "${String(args.selector ?? '')}"`
    case 'browser_extract_text':
      return 'Extract page text'
    case 'browser_fill_input':
      return `Fill "${String(args.selector ?? '')}"`
    case 'list_open_prs':
      return `List open PRs in ${String(args.repo ?? '')}`
    case 'get_pr_diff':
      return `Get diff for PR #${String(args.pr_number ?? '')} in ${String(args.repo ?? '')}`
    case 'post_pr_comment':
      return `Post review on PR #${String(args.pr_number ?? '')} in ${String(args.repo ?? '')}`
    case 'get_figma_file':
      return `Get Figma file ${String(args.file_key ?? '')}`
    case 'export_figma_frames':
      return `Analyse Figma frames in ${String(args.file_key ?? '')}`
    case 'create_figma_comment':
      return `Comment on Figma file ${String(args.file_key ?? '')}`
    default:
      return name
  }
}
