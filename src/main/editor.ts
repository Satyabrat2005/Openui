/**
 * editor.ts — open the agent's project folder in the user's editor.
 *
 * Why this exists: the coding agent writes real files, but until now it wrote
 * them into a userData directory nobody ever opens, so a successful build was
 * indistinguishable from the model hallucinating one. Launching VS Code on the
 * first write makes the work visible as it happens.
 *
 * Auto-open is ARMED per interactive builder session and fires at most once, so
 * a ten-file build opens one window rather than ten. The unattended autonomous
 * runner never arms it — a background task that popped an editor window over
 * whatever the user was doing would be hostile.
 */
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { resolveApp } from './appResolver'
import { enumerateInstalledApps, launchInstalledAppInDir } from './appIndex'

const IS_WIN = process.platform === 'win32'

/** How the folder ended up in front of the user, for logging/telemetry. */
export type EditorLaunch = 'vscode' | 'named-app' | 'file-browser' | 'failed'

let armed = false
/** Preferred editor/tool name for the next auto-open, e.g. "antigravity". */
let preferredEditor: string | null = null

/**
 * Arm auto-open for the next write. Call once per interactive build session.
 * `preferred`, when given, names an installed app (e.g. "antigravity") the
 * user asked to hand the project off to — resolved via appResolver's fuzzy
 * matching against the real installed-app index, same as open_app. A miss or
 * ambiguous match just falls through to the normal VS Code / file-browser path.
 */
export function armEditorAutoOpen(preferred?: string | null): void {
  armed = true
  preferredEditor = preferred?.trim() || null
}

/** Disarm without opening anything (used by tests and unattended runs). */
export function disarmEditorAutoOpen(): void {
  armed = false
  preferredEditor = null
}

/**
 * Open `dir` if auto-open is armed, then disarm. Never throws and never
 * blocks the caller's write — a missing editor must not fail a file write.
 */
export async function maybeOpenEditorOnFirstWrite(dir: string): Promise<EditorLaunch | null> {
  if (!armed) return null
  // Disarm before awaiting, so concurrent writes cannot both launch a window.
  armed = false
  const preferred = preferredEditor
  preferredEditor = null
  try {
    return await openInEditor(dir, preferred)
  } catch {
    return 'failed'
  }
}

/**
 * VS Code aliases the user might type ("vscode", "code", "vs code") that mean
 * "just use the default flow", not a distinct third-party app to resolve.
 */
const VSCODE_ALIASES = new Set(['vscode', 'vs code', 'code', 'visual studio code'])

/**
 * Try to launch `dir` in a named installed app (e.g. "antigravity"). Returns
 * true when it launched, false when the name was empty, a VS Code alias, not
 * installed, or ambiguous — all of which fall through to the normal VS Code /
 * file-browser flow rather than failing the build.
 */
async function tryOpenNamedEditor(dir: string, preferred: string | null): Promise<boolean> {
  if (!preferred) return false
  const norm = preferred.toLowerCase().trim()
  if (VSCODE_ALIASES.has(norm)) return false
  try {
    const apps = await enumerateInstalledApps()
    const match = resolveApp(preferred, apps)
    if (!match) return false
    await launchInstalledAppInDir(match, dir)
    return true
  } catch {
    return false
  }
}

/**
 * Standard VS Code install locations on Windows. We launch `Code.exe` directly
 * rather than the `code.cmd` shim on PATH: a .cmd needs `shell: true` to spawn,
 * and a shell spawn does not quote its arguments — which breaks the moment the
 * project path contains a space (`C:\Users\Jane Doe\OpenUI Projects\...`).
 */
function windowsCodeCandidates(): string[] {
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft VS Code'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code')
  ].filter((r): r is string => Boolean(r))
  return roots.map((r) => join(r, 'Code.exe'))
}

/** Absolute path to a launchable VS Code, or null when it is not installed. */
async function findVsCode(): Promise<string | null> {
  if (!IS_WIN) return 'code' // resolved off PATH by spawn; ENOENT falls back below
  for (const candidate of windowsCodeCandidates()) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // try the next install root
    }
  }
  return null
}

/**
 * Spawn a detached GUI process. Resolves once the child is running, rejects if
 * it could not be spawned at all (e.g. `code` is not on PATH). We must not
 * await the child's *exit* — an editor window outlives the build.
 */
function spawnDetached(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Open `dir` in a named installed app when one was requested and resolves
 * (e.g. "open it in Antigravity"), otherwise VS Code, falling back to the OS
 * file browser when neither is installed. Returns which one actually came up.
 */
export async function openInEditor(dir: string, preferred?: string | null): Promise<EditorLaunch> {
  if (await tryOpenNamedEditor(dir, preferred ?? null)) return 'named-app'

  const exe = await findVsCode()
  if (exe) {
    try {
      await spawnDetached(exe, ['-n', dir])
      return 'vscode'
    } catch {
      // Not installed, or not where we looked — show the folder instead.
    }
  }
  const err = await shell.openPath(dir)
  return err ? 'failed' : 'file-browser'
}
