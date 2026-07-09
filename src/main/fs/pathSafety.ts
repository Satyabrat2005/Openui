/**
 * pathSafety.ts — the filesystem trust boundary for LLM-supplied paths.
 *
 * Extracted from tools.ts so it can be unit-tested in isolation (tools.ts pulls
 * in Electron, nut-js and Playwright at import time). Pure and dependency-free
 * apart from node:path / node:os.
 */
import { resolve as resolvePath, join as joinPath, sep } from 'node:path'
import { homedir } from 'node:os'

/**
 * Paths under these segments are always off-limits. They sit INSIDE the user's
 * home folder (so confining to $HOME does not exclude them) yet hold
 * credentials, tokens and browser profiles — AppData\Roaming on Windows, ~/.ssh,
 * ~/.aws and friends elsewhere. On macOS this also covers Library/Application
 * Support (where Chrome/Slack/Discord/VS Code etc. keep tokens), Library/Cookies
 * and Library/Saved Application State, matching the breadth of the Windows
 * AppData exclusion rather than just Keychains.
 */
export const SENSITIVE_PATH_RE =
  /(^|[\\/])(AppData|\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|Library[\\/](Keychains|Application Support|Cookies|Saved Application State))([\\/]|$)/i

/**
 * Resolve an LLM-supplied path to an absolute path and enforce the filesystem
 * trust boundary. This is the equivalent of validateArgs for paths — model
 * output may be steered by prompt injection, so every path crosses this gate.
 *
 * • A leading "~" expands to the user's home directory.
 * • Credential / secret directories (SENSITIVE_PATH_RE: .ssh, .aws, AppData,
 *   Keychains …) are always rejected, for reads and writes alike.
 * • Mutating tools (write/mkdir/move/copy/delete) are additionally confined to
 *   the home directory tree, so an injected model cannot create, overwrite, or
 *   delete files anywhere in the system — only inside the user's own space.
 *
 * Returns the absolute path, or throws Error with a user-safe message.
 */
export function resolveSafePath(raw: unknown, opts: { mutating: boolean }): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('a non-empty string "path" is required.')
  }
  const input = raw.trim()
  if (input.length > 1024) throw new Error('"path" is too long.')
  const expanded =
    input === '~' || input.startsWith('~/') || input.startsWith('~\\')
      ? joinPath(homedir(), input.slice(1))
      : input
  const abs = resolvePath(expanded)
  if (SENSITIVE_PATH_RE.test(abs)) {
    throw new Error('that path is off-limits — it holds credentials or secrets.')
  }
  if (opts.mutating) {
    const home = resolvePath(homedir())
    if (abs !== home && !abs.startsWith(home + sep)) {
      throw new Error(
        `for safety, files can only be created, moved, copied, or deleted inside your home folder (${home}).`
      )
    }
  }
  return abs
}
