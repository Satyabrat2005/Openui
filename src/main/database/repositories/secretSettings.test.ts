/**
 * secretSettings.test.ts — that credentials are encrypted at rest, and that a
 * NEW credential cannot be added without being protected.
 *
 * The second half is the one that keeps working after today. Encryption is easy
 * to add once and easy to forget on the next integration, so the coverage guard
 * scans the source for settings keys that look like credentials and fails if one
 * is neither declared secret nor explicitly excused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const encryptString = vi.fn((s: string) => Buffer.from('CIPHER(' + s + ')'))
const decryptString = vi.fn((b: Buffer) => {
  const t = b.toString()
  const m = /^CIPHER\((.*)\)$/s.exec(t)
  if (!m) throw new Error('not our ciphertext')
  return m[1]
})
let available = true

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => encryptString(s),
    decryptString: (b: Buffer) => decryptString(b)
  }
}))

const rows = new Map<string, string>()
vi.mock('../init', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (key: string) => (rows.has(key) ? { value: rows.get(key) } : undefined),
      run: (key: string, value: string) => {
        if (/DELETE/i.test(sql)) rows.delete(key)
        else rows.set(key, value)
      }
    })
  })
}))

const { getSetting, setSetting } = await import('./settingsRepo')
const { SECRET_SETTING_KEYS, NON_SECRET_TOKEN_LIKE_KEYS, SECRET_LOOKING } = await import('./secretKeys')

beforeEach(() => {
  rows.clear()
  available = true
})

describe('credentials at rest', () => {
  it('never writes a secret to the database in plaintext', () => {
    setSetting('slack_token', 'xoxb-super-secret-value')
    const onDisk = rows.get('slack_token') as string
    expect(onDisk).not.toContain('xoxb-super-secret-value')
    expect(onDisk.startsWith('enc:v1:')).toBe(true)
  })

  it('round-trips a secret transparently for callers', () => {
    setSetting('gmail_refresh_token', '1//refresh-abc')
    expect(getSetting('gmail_refresh_token')).toBe('1//refresh-abc')
  })

  it('leaves non-secret settings as readable JSON', () => {
    setSetting('theme', 'dark')
    expect(rows.get('theme')).toBe('"dark"')
    expect(getSetting('theme')).toBe('dark')
  })

  it('still reads a plaintext value written before encryption existed', () => {
    // Exactly what the old code wrote.
    rows.set('github_token', JSON.stringify('ghp_legacy_plaintext'))
    expect(getSetting('github_token')).toBe('ghp_legacy_plaintext')
  })

  it('re-encrypts a legacy plaintext value on the next write', () => {
    rows.set('github_token', JSON.stringify('ghp_legacy_plaintext'))
    setSetting('github_token', 'ghp_rotated')
    expect(rows.get('github_token')!.startsWith('enc:v1:')).toBe(true)
    expect(rows.get('github_token')).not.toContain('ghp_rotated')
  })

  it('reads an unopenable envelope as absent, not as a corrupt token', () => {
    // A profile copied from another machine/user: envelope present, key absent.
    setSetting('telegram_bot_token', '123:ABC')
    available = false
    expect(getSetting('telegram_bot_token')).toBeNull()
  })

  it('stores plaintext rather than losing the credential when the OS cannot encrypt', () => {
    available = false
    setSetting('slack_token', 'xoxb-no-keyring')
    // Degraded, but the feature still works and the header documents why.
    expect(getSetting('slack_token')).toBe('xoxb-no-keyring')
  })
})

describe('coverage guard', () => {
  it('every credential-looking settings key is declared secret or excused', () => {
    const dir = join(__dirname, '..', '..')
    const seen = new Set<string>()
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.includes('.test.')) continue
      const src = readFileSync(join(dir, f), 'utf-8')
      // Keys as they appear at the call sites: getSetting('x') / setSetting('x', …)
      for (const m of src.matchAll(/(?:get|set|delete)Setting\(\s*'([a-z0-9_]+)'/g)) {
        seen.add(m[1])
      }
    }
    expect(seen.size).toBeGreaterThan(0)

    const undeclared = [...seen].filter(
      (k) => SECRET_LOOKING.test(k) && !SECRET_SETTING_KEYS.has(k) && !NON_SECRET_TOKEN_LIKE_KEYS.has(k)
    )
    expect(
      undeclared,
      `These settings keys look like credentials but are stored in plaintext. Add each to ` +
        `SECRET_SETTING_KEYS in secretKeys.ts, or to NON_SECRET_TOKEN_LIKE_KEYS with a reason: ` +
        undeclared.join(', ')
    ).toEqual([])
  })
})
