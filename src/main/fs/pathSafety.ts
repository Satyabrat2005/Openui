/**
 * pathSafety.ts — the filesystem trust boundary for LLM-supplied paths.
 *
 * Extracted from tools.ts so it can be unit-tested in isolation (tools.ts pulls
 * in Electron, nut-js and Playwright at import time). Pure and dependency-free
 * apart from node:path / node:os.
 */
import { resolve as resolvePath, join as joinPath, dirname, sep, isAbsolute } from 'node:path'
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
 * System-level secret/credential stores that live OUTSIDE the user's home folder.
 * Reads aren't confined to home (a user's own project files legitimately live on
 * other drives), so these system stores would otherwise be readable. Blocks the
 * Windows registry hive directory (SAM/SYSTEM/SECURITY), the Unix shadow/password
 * and sudoers files, private TLS keys, host SSH keys, and the macOS local
 * directory database. Only checked for paths that are NOT under the user's home,
 * so it never false-positives on a user file that merely happens to contain an
 * "etc" segment.
 */
export const SYSTEM_SECRET_PATH_RE =
  /(^|[\\/])(Windows[\\/]System32[\\/]config([\\/]|$)|etc[\\/](shadow|gshadow|master\.passwd|sudoers)([\\/]|$)|etc[\\/]ssl[\\/]private([\\/]|$)|etc[\\/]ssh([\\/]|$)|var[\\/]db[\\/]dslocal([\\/]|$))/i

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
 * • Reads are intentionally NOT confined to home (a user's own project/data
 *   files legitimately live on other drives or shared locations), but reads of
 *   paths OUTSIDE home still refuse two categories: system-level secret stores
 *   (SYSTEM_SECRET_PATH_RE — registry hives, /etc/shadow, TLS keys …) and other
 *   users' home directories.
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
      : isAbsolute(input)
        ? input
        : joinPath(homedir(), input)
  const abs = resolvePath(expanded)
  if (SENSITIVE_PATH_RE.test(abs)) {
    throw new Error('that path is off-limits — it holds credentials or secrets.')
  }
  const home = resolvePath(homedir())
  const underHome = abs === home || abs.startsWith(home + sep)
  if (opts.mutating) {
    if (!underHome) {
      throw new Error(
        `for safety, files can only be created, moved, copied, or deleted inside your home folder (${home}).`
      )
    }
  } else if (!underHome) {
    // Reads are NOT confined to home — a user's own project/data files
    // legitimately live on other drives (D:\, external disks) or shared
    // locations. But two categories of out-of-home path are still refused:
    //   • system-level secret stores (registry hives, /etc/shadow, TLS keys …)
    if (SYSTEM_SECRET_PATH_RE.test(abs)) {
      throw new Error('that path is off-limits — it holds system credentials or secrets.')
    }
    //   • other users' home directories — a single-user desktop assistant has no
    //     business reading another account's private files. usersRoot is the
    //     parent of this user's home (e.g. C:\Users, /home, /Users); a sibling
    //     under it that isn't this user's home is someone else's profile.
    const usersRoot = dirname(home)
    const usersRootIsFsRoot = usersRoot === dirname(usersRoot)
    if (!usersRootIsFsRoot && abs.startsWith(usersRoot + sep)) {
      throw new Error("that path is off-limits — it's inside another user's home folder.")
    }
  }
  return abs
}
