/**
 * osConsent.ts — per-session, per-app consent for OS-level input control.
 *
 * The existing gates are necessary but not sufficient for desktop automation.
 * STATE_CHANGING_TOOLS takes ONE approval before `computer_use` starts, which
 * authorises "control my computer" in the abstract — it never names the app,
 * and once given it cannot be taken back until the loop ends on its own.
 * browser/consent.ts solves exactly this shape of problem for web origins; this
 * module is its desktop counterpart.
 *
 * Three properties, each deliberate:
 *
 * 1. PER-APP. A grant names the app it covers. Approving "control Word" does
 *    not authorise typing into Slack.
 *
 * 2. PER-SESSION, NOT PERSISTED. Unlike site grants, app grants live in memory
 *    and die with the process. A persisted desktop-control grant would mean a
 *    user who once approved "control Chrome" silently re-authorises it weeks
 *    later; the blast radius (arbitrary input synthesis) is too large for that
 *    trade. Only the AUDIT LOG persists.
 *
 * 3. REVOCABLE MID-TASK. Each grant owns an AbortController wired into the
 *    agent loop's cooperative cancellation. Revoking aborts the running loop at
 *    its next step boundary rather than merely refusing future grants — a stop
 *    button that does not stop the thing in progress is not a stop button.
 *
 * Every action is appended to a plain-text audit log under userData, including
 * a hash of the screenshot the decision was made from, so a user can answer
 * "what did it do, to which app, and what was on screen at the time?".
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

/** Cap on live grants so a runaway loop cannot allocate unboundedly. */
const MAX_ACTIVE_GRANTS = 50

/** Audit lines returned by readAuditLog() — bounded so the UI cannot be flooded. */
const MAX_AUDIT_LINES_RETURNED = 1_000

let consentDirOverride: string | null = null

/** Test seam: point the audit log at a temp dir (pass null to restore default). */
export function setOsConsentDirForTests(dir: string | null): void {
  consentDirOverride = dir
}

function getConsentDir(): string {
  if (consentDirOverride) return consentDirOverride
  // Lazy-required so this module stays importable outside Electron (vitest).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('userData')
}

function auditFile(): string {
  return join(getConsentDir(), 'logs', 'os-automation.log')
}

/** A live authorisation to control one app for the rest of this session. */
export interface AppGrant {
  /** Normalised app key the grant covers. */
  app: string
  /** Human-readable name as shown in the approval UI. */
  displayName: string
  grantedAt: number
  /** Which UI path produced the human click (e.g. 'hitl', 'settings'). */
  source: string
  /** Aborted when the grant is revoked; wired into the loop's isAborted(). */
  controller: AbortController
}

const grants = new Map<string, AppGrant>()

/**
 * Normalise an app name to a comparison key.
 *
 * Case- and punctuation-insensitive so "Microsoft Word", "microsoft word" and
 * "Microsoft-Word" are one grant rather than three. Deliberately NOT fuzzy:
 * consent must be exact, or "word" could be stretched to cover "WordPad".
 */
export function appKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** True when the user has authorised control of this app in THIS session. */
export function isAppGranted(name: string): boolean {
  const grant = grants.get(appKey(name))
  return grant !== undefined && !grant.controller.signal.aborted
}

/**
 * Record a user-approved grant for one app and return it.
 *
 * Idempotent: re-granting an app that is already live returns the existing
 * grant, so its AbortSignal (which a running loop may already hold) stays valid
 * rather than being swapped for a fresh one that nothing is listening to.
 */
export function grantApp(name: string, source: string, displayName?: string): AppGrant {
  const key = appKey(name)
  const existing = grants.get(key)
  if (existing && !existing.controller.signal.aborted) return existing

  if (grants.size >= MAX_ACTIVE_GRANTS) {
    // Fail closed: refuse the new grant rather than evicting an existing one,
    // since eviction would silently cancel an unrelated running task.
    throw new Error(`Too many active app grants (${MAX_ACTIVE_GRANTS}); revoke some first.`)
  }

  const grant: AppGrant = {
    app: key,
    displayName: displayName ?? name,
    grantedAt: Date.now(),
    source,
    controller: new AbortController()
  }
  grants.set(key, grant)
  audit('GRANT', { app: key, detail: `via ${source}` })
  return grant
}

/**
 * Revoke a grant and abort anything running under it.
 *
 * Returns true when a live grant was actually revoked, so callers can tell the
 * user "stopped" rather than "nothing was running".
 */
export function revokeApp(name: string): boolean {
  const key = appKey(name)
  const grant = grants.get(key)
  if (!grant) return false
  grants.delete(key)
  const wasLive = !grant.controller.signal.aborted
  // Abort AFTER removing from the map so a loop waking on the signal cannot
  // observe a revoked grant still listed as active.
  grant.controller.abort()
  audit('REVOKE', { app: key })
  return wasLive
}

/** Revoke every grant — the "stop controlling my computer" panic path. */
export function revokeAllApps(): number {
  const keys = [...grants.keys()]
  for (const key of keys) revokeApp(key)
  return keys.length
}

/** Live grants, for the settings / status UI. */
export function listActiveGrants(): Array<Omit<AppGrant, 'controller'>> {
  return [...grants.values()]
    .filter((g) => !g.controller.signal.aborted)
    .map(({ app, displayName, grantedAt, source }) => ({ app, displayName, grantedAt, source }))
}

/** The AbortSignal for an app's grant, or null when it is not granted. */
export function signalFor(name: string): AbortSignal | null {
  const grant = grants.get(appKey(name))
  return grant && !grant.controller.signal.aborted ? grant.controller.signal : null
}

/** Test seam: drop all in-memory grants (does not touch the audit log). */
export function resetGrantsForTests(): void {
  for (const grant of grants.values()) grant.controller.abort()
  grants.clear()
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: string
  event: string
  app: string
  detail?: string
  /** Truncated SHA-256 of the screenshot the action was decided from. */
  screenshotHash?: string
}

/**
 * Short, stable fingerprint of a captured frame.
 *
 * Hashing rather than storing the image is the point: the log has to be
 * reviewable without becoming an archive of everything that was ever on the
 * user's screen. 16 hex chars is enough to correlate entries and detect a
 * repeated frame, and cannot reconstruct the image.
 */
export function screenshotHash(pngBuffer: Buffer): string {
  return createHash('sha256').update(pngBuffer).digest('hex').slice(0, 16)
}

/**
 * Append one line to the audit log.
 *
 * Never throws: an audit-sink failure must not break a running automation, and
 * must not be able to prevent a REVOKE from taking effect.
 */
export function audit(
  event: string,
  entry: { app: string; detail?: string; screenshotHash?: string }
): void {
  // TAB-delimited, not space-delimited: app keys legitimately contain spaces
  // ("microsoft word"), so a space-delimited record cannot be parsed back
  // unambiguously. Every field is stripped of tabs and newlines first, so a
  // model-supplied detail string cannot forge extra fields or extra entries.
  const line = [
    new Date().toISOString(),
    sanitizeField(event),
    sanitizeField(entry.app),
    entry.screenshotHash ? sanitizeField(entry.screenshotHash) : '',
    entry.detail ? sanitizeField(entry.detail).slice(0, 500) : ''
  ].join('\t')

  try {
    mkdirSync(dirname(auditFile()), { recursive: true })
    appendFileSync(auditFile(), line + '\n', 'utf8')
  } catch (err) {
    console.warn('[osConsent] could not append to the OS automation audit log:', err)
  }
}

/**
 * Record one executed action against a granted app.
 *
 * This is what makes the privacy claim checkable rather than promotional: every
 * synthesised input is logged with the app it targeted and a fingerprint of the
 * screen it was decided from.
 */
export function auditAction(
  app: string,
  actionType: string,
  opts: { detail?: string; pngBuffer?: Buffer } = {}
): void {
  audit('ACTION', {
    app: appKey(app),
    detail: opts.detail ? `${actionType}: ${opts.detail}` : actionType,
    screenshotHash: opts.pngBuffer ? screenshotHash(opts.pngBuffer) : undefined
  })
}

/** Collapse anything that could break the one-record-per-line tab format. */
function sanitizeField(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim()
}

/** Parse one tab-delimited audit line into a structured entry, or null. */
export function parseAuditLine(line: string): AuditEntry | null {
  const trimmed = line.replace(/[\r\n]+$/, '')
  if (!trimmed.trim()) return null
  const [ts, event, app, hash, detail] = trimmed.split('\t')
  if (!ts || !/^\d{4}-\d{2}-\d{2}T/.test(ts)) return null
  if (!event || !app) return null
  return {
    ts,
    event,
    app,
    detail: detail ? detail : undefined,
    screenshotHash: hash ? hash : undefined
  }
}

/**
 * Read the audit log back, newest last, for the review UI.
 * Returns [] when no log exists yet — that is the normal first-run state.
 */
export function readAuditLog(limit = MAX_AUDIT_LINES_RETURNED): AuditEntry[] {
  const file = auditFile()
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    const entries: AuditEntry[] = []
    for (const line of lines) {
      const parsed = parseAuditLine(line)
      if (parsed) entries.push(parsed)
    }
    return entries.slice(-Math.min(limit, MAX_AUDIT_LINES_RETURNED))
  } catch (err) {
    console.warn('[osConsent] could not read the OS automation audit log:', err)
    return []
  }
}

/** Absolute path of the audit log, so the UI can offer "reveal in folder". */
export function auditLogPath(): string {
  return auditFile()
}
