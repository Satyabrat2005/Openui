/**
 * OpenUI app-resolution engine.
 *
 * `open_app` used to match an installed app with a plain exact/substring compare
 * in PowerShell, which fails the moment the user's phrasing differs from the
 * registered name ("VS Code" never matches "Visual Studio Code" — it isn't a
 * substring) and can't be unit-tested. This module is the pure, testable core of
 * a better design: the OS layer (tools.ts) *indexes* installed apps into a flat
 * `InstalledApp[]`, this module *ranks* them against the user's phrasing, and the
 * OS layer then *launches* the winner by its AppID or path.
 *
 * It is deliberately platform-agnostic and side-effect free: no `fs`, no
 * `child_process`, no Electron. That keeps the matching logic fast to test and
 * reusable for macOS/Linux indexers later.
 */

export interface InstalledApp {
  /** Display name as the OS reports it, e.g. "Visual Studio Code". */
  name: string
  /** Get-StartApps AppID — launch via `shell:AppsFolder\<appId>` when present. */
  appId?: string
  /** Full path to an .exe/.lnk — launch via Start-Process when present. */
  path?: string
  /** Where the entry came from; used to break score ties (startapps is most reliable). */
  source: 'startapps' | 'shortcut' | 'app-bundle'
}

/**
 * Colloquial → canonical name hints, keyed by NORMALISED alias. These cover the
 * gap between how people ask ("vs code", "ppt", "chrome") and how apps register
 * ("Visual Studio Code", "Microsoft PowerPoint", "Google Chrome"). The value is
 * matched against the index like a second query, so an alias only helps when the
 * canonical app is actually installed — a wrong alias can't launch the wrong app.
 */
const ALIASES: Record<string, string> = {
  'vs code': 'visual studio code',
  vscode: 'visual studio code',
  code: 'visual studio code',
  vs: 'visual studio',
  chrome: 'google chrome',
  edge: 'microsoft edge',
  msedge: 'microsoft edge',
  word: 'microsoft word',
  excel: 'microsoft excel',
  powerpoint: 'microsoft powerpoint',
  ppt: 'microsoft powerpoint',
  outlook: 'microsoft outlook',
  teams: 'microsoft teams',
  vlc: 'vlc media player',
  telegram: 'telegram desktop',
  photoshop: 'adobe photoshop'
}

/** Lowercase, drop a trailing .exe, strip punctuation to spaces, collapse runs. */
export function normalizeAppName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Score how well a normalised query matches a normalised app name (0–100).
 * Higher tiers are more specific matches; the ladder is ordered so a stronger
 * relationship always outranks a weaker one.
 */
export function scoreAppName(queryNorm: string, nameNorm: string): number {
  if (!queryNorm || !nameNorm) return 0
  if (queryNorm === nameNorm) return 100

  // Whole-word prefix ("visual studio" → "visual studio code") beats a raw
  // character prefix ("power" → "powerpoint") beats the reverse containment.
  if (nameNorm.startsWith(queryNorm + ' ')) return 90
  if (nameNorm.startsWith(queryNorm)) return 82
  if (queryNorm.startsWith(nameNorm + ' ') || queryNorm.startsWith(nameNorm)) return 74

  const qTokens = queryNorm.split(' ').filter(Boolean)
  const nTokens = nameNorm.split(' ').filter(Boolean)
  const nSet = new Set(nTokens)

  // Every query word is a whole word of the name ("studio code" → "visual studio code").
  if (qTokens.every((t) => nSet.has(t))) return 70
  // Every query word appears somewhere in the name (looser, substring level).
  if (qTokens.every((t) => nameNorm.includes(t))) return 62
  // The whole query is a substring of the name.
  if (nameNorm.includes(queryNorm)) return 58
  // Acronym: the name's initials spell the query ("vlc" → "VLC media player" → "vmp"? no;
  // "gc" → "google chrome"). Compared without spaces.
  if (nTokens.map((t) => t[0]).join('') === queryNorm.replace(/ /g, '')) return 52

  // Partial token overlap — capped below the match threshold so a single shared
  // word ("microsoft") can't by itself launch the wrong Microsoft app.
  const common = qTokens.filter((t) => nSet.has(t)).length
  if (common > 0) return Math.round((common / qTokens.length) * 45)
  return 0
}

/**
 * Pick the best installed app for a user's phrasing, or null if nothing clears
 * the confidence threshold. Tries both the raw query and its alias expansion and
 * takes the higher score; ties prefer the `startapps` source (AppID launches are
 * the most reliable).
 */
export function resolveApp(
  query: string,
  apps: InstalledApp[],
  threshold = 50
): InstalledApp | null {
  const qn = normalizeAppName(query)
  if (!qn) return null
  const queries = [qn]
  const alias = ALIASES[qn]
  if (alias) queries.push(normalizeAppName(alias))

  let bestScore = 0
  const scored: { app: InstalledApp; score: number }[] = []
  for (const app of apps) {
    const nn = normalizeAppName(app.name)
    let score = 0
    for (const q of queries) score = Math.max(score, scoreAppName(q, nn))
    if (score <= 0) continue
    scored.push({ app, score })
    if (score > bestScore) bestScore = score
  }
  if (bestScore < threshold) return null

  const top = scored.filter((s) => s.score === bestScore)
  const distinctNames = new Set(top.map((s) => normalizeAppName(s.app.name)))
  // Ambiguous: several *different* apps tie for the best non-exact score (e.g.
  // "microsoft" → Edge / Word / PowerPoint). Refuse to guess — the caller then
  // asks the user to be specific instead of opening a random one. An exact match
  // (score 100) is never treated as ambiguous.
  if (bestScore < 100 && distinctNames.size > 1) return null

  // Unique winner, or the same app indexed from multiple sources: prefer the
  // startapps entry (AppID launches are the most reliable).
  top.sort((a, b) => (a.app.source === 'startapps' ? 0 : 1) - (b.app.source === 'startapps' ? 0 : 1))
  return top[0].app
}
