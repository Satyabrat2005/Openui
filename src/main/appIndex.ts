/**
 * appIndex.ts — enumerate and launch installed desktop apps.
 *
 * Pulled out of tools.ts so a caller that only needs "what's installed, launch
 * X" (editor.ts's named-editor handoff, e.g. "open this in Antigravity") does
 * not have to import tools.ts's full OS-automation surface (Electron,
 * Playwright, Google APIs, ...). open_app/list_apps in tools.ts import these
 * same functions, so there remains exactly one installed-app index and one
 * launch path, not two that could drift apart.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { homedir } from 'node:os'
import type { InstalledApp } from './appResolver'
import { runPowerShellScript } from './powershell'

export type { InstalledApp }

const execFileAsync = promisify(execFile)

const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'

/** Launch a resolved app by its Start-menu AppID (Store/UWP + registered desktop). */
const WIN_LAUNCH_APPID_SCRIPT = `
$ErrorActionPreference = 'Stop'
Start-Process ('shell:AppsFolder\\' + $env:OPENUI_LAUNCH_TARGET)
`.trim()

/** Launch a resolved app by a full path to its .exe/.lnk. */
const WIN_LAUNCH_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath $env:OPENUI_LAUNCH_TARGET
`.trim()

/**
 * Static index script for the OpenUI app resolver: enumerate every installed app
 * the user could open, as JSON. Two sources cover the vast majority of apps:
 *   • Get-StartApps — Store/UWP apps + registered desktop apps, each with an
 *     AppUserModelID we can launch via shell:AppsFolder.
 *   • Start-menu .lnk shortcuts — path-launchable, and a safety net for anything
 *     Get-StartApps misses.
 * Takes NO user input, so nothing untrusted is ever spliced into the script.
 */
const WIN_LIST_APPS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$apps = New-Object System.Collections.ArrayList
foreach ($a in (Get-StartApps)) {
  if ($a.Name) {
    [void]$apps.Add([pscustomobject]@{ name = [string]$a.Name; appId = [string]$a.AppID; path = ''; source = 'startapps' })
  }
}
$roots = @(
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:AppData 'Microsoft\\Windows\\Start Menu\\Programs')
)
foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root) {
    Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      [void]$apps.Add([pscustomobject]@{ name = [string]$_.BaseName; appId = ''; path = [string]$_.FullName; source = 'shortcut' })
    }
  }
}
# @(...) guarantees a JSON array even when only one app is found.
ConvertTo-Json -InputObject @($apps) -Compress -Depth 3
`.trim()

// In-memory index of installed apps. Enumerating shells out to PowerShell (a few
// hundred ms), so a short TTL cache keeps rapid "open X / open Y" sequences snappy
// without going stale as the user installs/uninstalls apps across a session.
let _winAppCache: { at: number; apps: InstalledApp[] } | null = null
const WIN_APP_CACHE_TTL_MS = 60_000

/** Enumerate installed Windows apps (cached), for the resolver + list_apps. */
export async function enumerateWindowsApps(): Promise<InstalledApp[]> {
  if (_winAppCache && Date.now() - _winAppCache.at < WIN_APP_CACHE_TTL_MS) {
    return _winAppCache.apps
  }
  const out = await runPowerShellScript(WIN_LIST_APPS_SCRIPT)
  let parsed: unknown
  try {
    parsed = JSON.parse(out || '[]')
  } catch {
    parsed = []
  }
  const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  const apps: InstalledApp[] = []
  for (const raw of arr) {
    const a = raw as Record<string, unknown>
    const name = typeof a?.name === 'string' ? a.name.trim() : ''
    if (!name) continue
    apps.push({
      name,
      appId: typeof a.appId === 'string' && a.appId ? a.appId : undefined,
      path: typeof a.path === 'string' && a.path ? a.path : undefined,
      source: a.source === 'shortcut' ? 'shortcut' : 'startapps'
    })
  }
  _winAppCache = { at: Date.now(), apps }
  return apps
}

// Standard locations for .app bundles. readdir (not `mdfind`) so this works
// even when Spotlight is disabled or still indexing.
const MAC_APP_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  joinPath(homedir(), 'Applications')
]

let _macAppCache: { at: number; apps: InstalledApp[] } | null = null
const MAC_APP_CACHE_TTL_MS = 60_000

/** Enumerate installed macOS apps (cached), for the resolver + list_apps. */
export async function enumerateMacApps(): Promise<InstalledApp[]> {
  if (_macAppCache && Date.now() - _macAppCache.at < MAC_APP_CACHE_TTL_MS) {
    return _macAppCache.apps
  }
  const apps: InstalledApp[] = []
  for (const dir of MAC_APP_DIRS) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue
      apps.push({
        name: entry.slice(0, -'.app'.length),
        path: joinPath(dir, entry),
        source: 'app-bundle'
      })
    }
  }
  _macAppCache = { at: Date.now(), apps }
  return apps
}

/** Enumerate installed apps for the current platform ([] on unsupported platforms). */
export async function enumerateInstalledApps(): Promise<InstalledApp[]> {
  if (IS_MAC) return enumerateMacApps()
  if (IS_WIN) return enumerateWindowsApps()
  return []
}

/** Launch a resolved Windows app by AppID (preferred) or path. Throws on failure. */
export async function launchWindowsApp(match: InstalledApp): Promise<void> {
  if (match.appId) {
    await runPowerShellScript(WIN_LAUNCH_APPID_SCRIPT, { OPENUI_LAUNCH_TARGET: match.appId })
  } else if (match.path) {
    await runPowerShellScript(WIN_LAUNCH_PATH_SCRIPT, { OPENUI_LAUNCH_TARGET: match.path })
  } else {
    throw new Error(`No launch target for "${match.name}".`)
  }
}

/** Launch a resolved macOS app by its bundle path. Throws on failure. */
export async function launchMacApp(match: InstalledApp): Promise<void> {
  if (!match.path) throw new Error(`No launch target for "${match.name}".`)
  await execFileAsync('open', ['-a', match.path])
}

/** Launch a resolved app for the current platform. Throws on failure. */
export async function launchInstalledApp(match: InstalledApp): Promise<void> {
  if (IS_WIN) return launchWindowsApp(match)
  if (IS_MAC) return launchMacApp(match)
  throw new Error('Launching a resolved app is only supported on Windows and macOS.')
}

/**
 * Launch a resolved Windows app with `dir` as a single launch argument (the
 * editor-handoff case: "open this project in Antigravity"). The argument is
 * quoted inside the script so a project path containing spaces still arrives
 * as one argument, not two. Only possible when the app was indexed with a
 * real path (a Start-menu .lnk shortcut) — Store/UWP apps launched via
 * shell:AppsFolder cannot take arguments this way, so those fall back to a
 * bare launch: the app opens, but the user must browse to the folder.
 */
export async function launchWindowsAppInDir(match: InstalledApp, dir: string): Promise<void> {
  if (!match.path) return launchWindowsApp(match)
  const script = `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath $env:OPENUI_LAUNCH_TARGET -ArgumentList @('"' + $env:OPENUI_LAUNCH_ARG + '"')
`.trim()
  await runPowerShellScript(script, { OPENUI_LAUNCH_TARGET: match.path, OPENUI_LAUNCH_ARG: dir })
}

/** Launch a resolved macOS app with `dir` opened in it. Throws on failure. */
export async function launchMacAppInDir(match: InstalledApp, dir: string): Promise<void> {
  if (!match.path) throw new Error(`No launch target for "${match.name}".`)
  await execFileAsync('open', ['-a', match.path, dir])
}

/** Launch a resolved app for the current platform with `dir` opened in it, when possible. */
export async function launchInstalledAppInDir(match: InstalledApp, dir: string): Promise<void> {
  if (IS_WIN) return launchWindowsAppInDir(match, dir)
  if (IS_MAC) return launchMacAppInDir(match, dir)
  throw new Error('Launching a resolved app is only supported on Windows and macOS.')
}
