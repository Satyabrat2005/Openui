/**
 * powershell.ts — shared low-level PowerShell execution primitives.
 *
 * Pulled out of tools.ts so a module that only needs to shell out to PowerShell
 * (appIndex.ts's app enumeration/launch) doesn't have to import tools.ts's full
 * OS-automation surface (Electron, Playwright, Google APIs, ...). Every other
 * PowerShell caller in tools.ts (calendar/Outlook COM, open_app's resolver
 * fallback, ...) imports these same functions, so there remains exactly one
 * child-process invocation path and one security boundary for all of it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Hard wall-clock bound on every PowerShell child (also guards against a hung
// Outlook COM call) plus a 1 MiB stdout cap.
const PS_TIMEOUT_MS = 15_000
const PS_MAX_BUFFER = 1024 * 1024

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
export function powerShellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

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
export function runPowerShellArgs(
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
export async function runPowerShell(command: string, extraEnv?: Record<string, string>): Promise<string> {
  const { stdout } = await runPowerShellArgs(['-Command', command], extraEnv)
  return stdout.trim()
}

export async function runPowerShellScript(script: string, extraEnv?: Record<string, string>): Promise<string> {
  // PowerShell -EncodedCommand accepts base64(UTF-16LE).
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await runPowerShellArgs(['-EncodedCommand', encoded], extraEnv)
  return stdout.trim()
}
