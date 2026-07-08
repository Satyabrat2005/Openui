/**
 * consent.ts — per-site consent registry for the automation browser (Task 1).
 *
 * connect_browser attaches the agent to the persistent automation profile, but
 * that attachment is NEVER a blanket grant: every origin the agent wants to
 * visit needs its own one-time human approval. Grants are per-origin
 * (scheme + host + port), persisted as JSON under userData so they survive
 * restarts, and every grant is appended to an audit log so the user can always
 * answer "which sites has OpenUI been allowed to touch, and when?".
 *
 * The registry is deliberately independent of the settings database: it is a
 * trust boundary, so it must stay readable/auditable as a plain file and
 * importable (and unit-testable) without booting better-sqlite3.
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** Grants are capped so a runaway loop can never bloat the consent file. */
const MAX_GRANTED_ORIGINS = 500

let consentDirOverride: string | null = null

/** Test seam: point the registry at a temp dir (pass null to restore default). */
export function setConsentDirForTests(dir: string | null): void {
  consentDirOverride = dir
  cache = null
}

function getConsentDir(): string {
  if (consentDirOverride) return consentDirOverride
  // Lazy-required so this module stays importable outside Electron (vitest).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('userData')
}

function grantsFile(): string {
  return join(getConsentDir(), 'browser-consent.json')
}

function auditFile(): string {
  return join(getConsentDir(), 'logs', 'browser-domains.log')
}

// In-memory cache of granted origins; reloaded lazily after process restart.
let cache: Set<string> | null = null

function loadGrants(): Set<string> {
  if (cache) return cache
  try {
    const parsed: unknown = JSON.parse(readFileSync(grantsFile(), 'utf8'))
    cache = new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    )
  } catch {
    cache = new Set() // first run, or an unreadable/corrupt file → no grants
  }
  return cache
}

function persistGrants(grants: Set<string>): void {
  try {
    mkdirSync(dirname(grantsFile()), { recursive: true })
    writeFileSync(grantsFile(), JSON.stringify([...grants].sort(), null, 2), 'utf8')
  } catch (err) {
    console.warn('[consent] could not persist site grants:', err)
  }
}

/**
 * Normalise a URL to its origin ("https://example.com" — scheme+host+port).
 * Returns null for anything unparseable or non-http(s), so callers fail closed.
 */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/** True when the user has previously granted the agent access to this origin. */
export function isOriginGranted(origin: string): boolean {
  return loadGrants().has(origin)
}

/** Every origin the user has ever granted, sorted (for display / audit). */
export function listGrantedOrigins(): string[] {
  return [...loadGrants()].sort()
}

/**
 * Record a user-approved grant for one origin: persist it and append one line
 * to the audit log. `source` says which UI path produced the human click.
 * Idempotent — re-granting an origin does not duplicate the audit trail.
 */
export function grantOrigin(origin: string, source: string): void {
  const grants = loadGrants()
  if (grants.has(origin)) return
  if (grants.size >= MAX_GRANTED_ORIGINS) {
    console.warn(`[consent] grant limit (${MAX_GRANTED_ORIGINS}) reached; refusing ${origin}`)
    return
  }
  grants.add(origin)
  persistGrants(grants)
  try {
    mkdirSync(dirname(auditFile()), { recursive: true })
    appendFileSync(auditFile(), `${new Date().toISOString()} GRANT ${origin} via ${source}\n`, 'utf8')
  } catch (err) {
    console.warn('[consent] could not append to domain audit log:', err)
  }
}

/** Remove a grant (Settings UI); appends a REVOKE line to the same audit log. */
export function revokeOrigin(origin: string): void {
  const grants = loadGrants()
  if (!grants.delete(origin)) return
  persistGrants(grants)
  try {
    mkdirSync(dirname(auditFile()), { recursive: true })
    appendFileSync(auditFile(), `${new Date().toISOString()} REVOKE ${origin}\n`, 'utf8')
  } catch {
    /* audit failure must not block the revoke itself */
  }
}
