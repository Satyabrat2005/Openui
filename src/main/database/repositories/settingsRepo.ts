import { getDb } from '../init'
import { isSecretKey } from './secretKeys'
import { decryptValue, encryptValue, isEncrypted } from './secretStore'

/**
 * Settings persistence.
 *
 * Values for the keys named in SECRET_SETTING_KEYS are encrypted at rest with
 * the OS keystore (see secretStore.ts). The encryption is transparent: callers
 * pass and receive ordinary values and never see an envelope, so nothing that
 * reads a token needed to change.
 */

export function getSetting(key: string): unknown {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return null

  let raw = row.value
  if (isEncrypted(raw)) {
    const plain = decryptValue(raw)
    // An envelope we cannot open (different OS user, restored backup, no
    // keyring) reads as absent so the caller re-prompts, rather than as a
    // corrupt string that would be sent to a live API as a credential.
    if (plain === null) return null
    raw = plain
  }

  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

export function setSetting(key: string, value: unknown): void {
  const serialised = JSON.stringify(value)
  // Encrypt on write, so a value that predates this change is upgraded the next
  // time it is saved — no migration step and nothing for the user to redo.
  const stored = isSecretKey(key) ? encryptValue(serialised) : serialised
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = strftime('%s','now')`
    )
    .run(key, stored)
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}
