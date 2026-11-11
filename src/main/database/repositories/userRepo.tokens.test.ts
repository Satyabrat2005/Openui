/**
 * The Supabase sign-in tokens are credentials — the refresh token alone is
 * enough to act as the user — so they are encrypted at rest like the channel
 * tokens in secretStore.ts. They used to sit in plaintext in openui.db.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDb, type TempDb } from './__support__/tempDb'

const holder = vi.hoisted(() => ({ current: null as unknown, available: true }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => holder.available,
    encryptString: (s: string) => Buffer.from('CIPHER(' + s + ')'),
    decryptString: (b: Buffer) => {
      const m = /^CIPHER\((.*)\)$/s.exec(b.toString())
      if (!m) throw new Error('not our ciphertext')
      return m[1]
    }
  }
}))
vi.mock('../init', () => ({ getDb: () => holder.current, initDb: () => holder.current }))

import { applySchema } from '../schema'
import { runMigrations } from '../migrations'
import * as users from './userRepo'

let temp: TempDb
const future = (): number => Math.floor(Date.now() / 1000) + 3600

/** What is actually written to the file. */
function onDisk(id: string): { auth_token: string | null; refresh_token: string | null } {
  return temp.db.prepare('SELECT auth_token, refresh_token FROM users WHERE id = ?').get(id) as {
    auth_token: string | null
    refresh_token: string | null
  }
}

beforeEach(() => {
  holder.available = true
  temp = createTempDb()
  holder.current = temp.db
  applySchema()
  runMigrations()
  users.upsertUser({ id: 'u1', email: 'a@b.com' })
})
afterEach(() => {
  temp.cleanup()
  holder.current = null
})

describe('sign-in tokens at rest', () => {
  it('are never written to the database in plaintext', () => {
    users.updateAuthTokens('u1', 'access-SECRET', 'refresh-SECRET', future())
    const row = onDisk('u1')
    expect(row.auth_token).not.toContain('access-SECRET')
    expect(row.refresh_token).not.toContain('refresh-SECRET')
    expect(row.refresh_token?.startsWith('enc:v1:')).toBe(true)
  })

  it('read back transparently for the session code', () => {
    users.updateAuthTokens('u1', 'access-SECRET', 'refresh-SECRET', future())
    expect(users.getUserById('u1')).toMatchObject({ auth_token: 'access-SECRET', refresh_token: 'refresh-SECRET' })
    expect(users.getValidToken('u1')).toBe('access-SECRET')
  })

  it('keep an empty "signed out" value empty', () => {
    users.updateAuthTokens('u1', '', '', 0)
    expect(onDisk('u1')).toEqual({ auth_token: '', refresh_token: '' })
    expect(users.getValidToken('u1')).toBeNull()
  })

  it('still read a plaintext row written before this change', () => {
    temp.db.prepare('UPDATE users SET auth_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?').run('old-access', 'old-refresh', future(), 'u1')
    expect(users.getUserById('u1')?.refresh_token).toBe('old-refresh')
    expect(users.getValidToken('u1')).toBe('old-access')
  })

  it('read as signed out when this computer cannot open them, never as a mangled token', () => {
    users.updateAuthTokens('u1', 'access-SECRET', 'refresh-SECRET', future())
    holder.available = false
    expect(users.getUserById('u1')?.refresh_token).toBeNull()
    expect(users.getValidToken('u1')).toBeNull()
  })
})
