import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appKey,
  grantApp,
  isAppGranted,
  revokeApp,
  revokeAllApps,
  listActiveGrants,
  signalFor,
  resetGrantsForTests,
  setOsConsentDirForTests,
  screenshotHash,
  auditAction,
  readAuditLog,
  parseAuditLine,
  auditLogPath
} from './osConsent'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osconsent-'))
  setOsConsentDirForTests(dir)
  resetGrantsForTests()
})

afterEach(async () => {
  setOsConsentDirForTests(null)
  resetGrantsForTests()
  await rm(dir, { recursive: true, force: true })
})

describe('appKey', () => {
  it('normalises case, punctuation and the .exe suffix to one key', () => {
    expect(appKey('Microsoft Word')).toBe('microsoft word')
    expect(appKey('microsoft-word')).toBe('microsoft word')
    expect(appKey('WORD.exe')).toBe('word')
    expect(appKey('  Visual   Studio  Code ')).toBe('visual studio code')
  })

  it('does NOT collapse distinct apps into one grant', () => {
    // Consent must be exact: "word" must not be stretched to cover "WordPad".
    expect(appKey('Word')).not.toBe(appKey('WordPad'))
  })
})

describe('grants', () => {
  it('starts with nothing granted', () => {
    expect(isAppGranted('Word')).toBe(false)
    expect(listActiveGrants()).toEqual([])
  })

  it('grants control of one app without granting others', () => {
    grantApp('Microsoft Word', 'hitl')
    expect(isAppGranted('Microsoft Word')).toBe(true)
    expect(isAppGranted('microsoft word')).toBe(true) // same key
    // The core per-app property: approving Word is not approval for Slack.
    expect(isAppGranted('Slack')).toBe(false)
  })

  it('is idempotent — re-granting keeps the SAME signal a running loop holds', () => {
    const first = grantApp('Word', 'hitl')
    const signal = signalFor('Word')
    const second = grantApp('Word', 'hitl')

    expect(second).toBe(first)
    // If re-granting swapped in a fresh controller, a revoke would abort a
    // signal nothing is listening to and the running loop would continue.
    expect(signalFor('Word')).toBe(signal)
  })

  it('exposes live grants for the settings UI', () => {
    grantApp('Word', 'hitl', 'Microsoft Word')
    const active = listActiveGrants()
    expect(active).toHaveLength(1)
    expect(active[0].app).toBe('word')
    expect(active[0].displayName).toBe('Microsoft Word')
    expect(active[0].source).toBe('hitl')
    expect(typeof active[0].grantedAt).toBe('number')
  })
})

describe('revocation', () => {
  it('aborts the in-flight signal, not just future grants', () => {
    grantApp('Word', 'hitl')
    const signal = signalFor('Word')
    expect(signal?.aborted).toBe(false)

    expect(revokeApp('Word')).toBe(true)

    // A stop button that does not stop the thing in progress is not a stop
    // button — this is the assertion that makes mid-task revoke real.
    expect(signal?.aborted).toBe(true)
    expect(isAppGranted('Word')).toBe(false)
    expect(listActiveGrants()).toEqual([])
  })

  it('reports false when there was nothing to revoke', () => {
    expect(revokeApp('Word')).toBe(false)
  })

  it('revokes by any spelling of the app name', () => {
    grantApp('Microsoft Word', 'hitl')
    expect(revokeApp('microsoft-word')).toBe(true)
  })

  it('revokeAllApps aborts every live grant', () => {
    grantApp('Word', 'hitl')
    grantApp('Chrome', 'hitl')
    const wordSignal = signalFor('Word')
    const chromeSignal = signalFor('Chrome')

    expect(revokeAllApps()).toBe(2)

    expect(wordSignal?.aborted).toBe(true)
    expect(chromeSignal?.aborted).toBe(true)
    expect(listActiveGrants()).toEqual([])
  })

  it('signalFor returns null once revoked', () => {
    grantApp('Word', 'hitl')
    revokeApp('Word')
    expect(signalFor('Word')).toBeNull()
  })

  it('a re-grant after revocation issues a fresh, unaborted signal', () => {
    grantApp('Word', 'hitl')
    const stale = signalFor('Word')
    revokeApp('Word')

    grantApp('Word', 'hitl')
    const fresh = signalFor('Word')

    expect(stale?.aborted).toBe(true)
    expect(fresh?.aborted).toBe(false)
    expect(fresh).not.toBe(stale)
  })
})

describe('screenshotHash', () => {
  it('is stable for identical frames and differs for different ones', () => {
    const a = Buffer.from('frame-a')
    expect(screenshotHash(a)).toBe(screenshotHash(Buffer.from('frame-a')))
    expect(screenshotHash(a)).not.toBe(screenshotHash(Buffer.from('frame-b')))
  })

  it('is short enough to be unreconstructable but long enough to correlate', () => {
    expect(screenshotHash(Buffer.from('x'))).toHaveLength(16)
  })
})

describe('audit log', () => {
  it('is empty before anything happens', () => {
    expect(readAuditLog()).toEqual([])
  })

  it('records grants and revocations', () => {
    grantApp('Word', 'hitl')
    revokeApp('Word')

    const log = readAuditLog()
    expect(log.map((e) => e.event)).toEqual(['GRANT', 'REVOKE'])
    expect(log[0].app).toBe('word')
    expect(log[0].detail).toMatch(/via hitl/)
  })

  it('records each action with its app and screenshot fingerprint', () => {
    const png = Buffer.from('a-captured-frame')
    auditAction('Microsoft Word', 'click', { detail: '(120,340)', pngBuffer: png })

    const [entry] = readAuditLog()
    expect(entry.event).toBe('ACTION')
    expect(entry.app).toBe('microsoft word')
    expect(entry.detail).toMatch(/click/)
    expect(entry.screenshotHash).toBe(screenshotHash(png))
  })

  it('records an action with no screenshot', () => {
    auditAction('Word', 'type')
    const [entry] = readAuditLog()
    expect(entry.screenshotHash).toBeUndefined()
    expect(entry.detail).toBe('type')
  })

  it('keeps one entry per line when detail contains newlines or tabs', () => {
    // A model-supplied string must not be able to forge extra audit entries
    // (newlines) or extra fields (tabs) — the log is a trust artefact.
    auditAction('Word', 'type', { detail: 'line one\nEVIL FORGED LINE\rmore\tfake-field' })
    const log = readAuditLog()
    expect(log).toHaveLength(1)
    expect(log[0].detail).not.toMatch(/[\n\t]/)
    expect(log[0].app).toBe('word')
  })

  it('round-trips an app name containing spaces', () => {
    // The space-delimited format this replaced parsed "microsoft word" back
    // as "microsoft", silently mis-attributing every multi-word app's actions.
    auditAction('Microsoft Word', 'click')
    expect(readAuditLog()[0].app).toBe('microsoft word')
  })

  it('persists across reads and appends in chronological order', () => {
    auditAction('Word', 'click')
    auditAction('Chrome', 'type')
    const log = readAuditLog()
    expect(log).toHaveLength(2)
    expect(log[0].app).toBe('word')
    expect(log[1].app).toBe('chrome')
  })

  it('honours the requested limit, returning the most recent entries', () => {
    for (let i = 0; i < 10; i++) auditAction('Word', `click-${i}`)
    const log = readAuditLog(3)
    expect(log).toHaveLength(3)
    expect(log[2].detail).toMatch(/click-9/)
  })

  it('exposes its path so the UI can reveal it', () => {
    expect(auditLogPath()).toMatch(/os-automation\.log$/)
  })
})

describe('parseAuditLine', () => {
  it('round-trips a written line', () => {
    const entry = parseAuditLine(
      '2026-07-18T10:00:00.000Z\tACTION\tmicrosoft word\tabc123\tclick: (1,2)'
    )
    expect(entry).toEqual({
      ts: '2026-07-18T10:00:00.000Z',
      event: 'ACTION',
      app: 'microsoft word',
      screenshotHash: 'abc123',
      detail: 'click: (1,2)'
    })
  })

  it('handles a line with no hash and no detail', () => {
    const entry = parseAuditLine('2026-07-18T10:00:00.000Z\tGRANT\tword\t\t')
    expect(entry?.screenshotHash).toBeUndefined()
    expect(entry?.detail).toBeUndefined()
  })

  it('rejects blank and malformed lines instead of inventing entries', () => {
    expect(parseAuditLine('')).toBeNull()
    expect(parseAuditLine('   ')).toBeNull()
    expect(parseAuditLine('not a log line')).toBeNull()
    expect(parseAuditLine('2026\tACTION\tword')).toBeNull()
  })
})
