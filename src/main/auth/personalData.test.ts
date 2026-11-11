/**
 * A different account signing in on the same computer must not inherit the
 * last person's channel connections, chat memory or contacts — those are stored
 * once per install, not per account. The same person signing back in keeps all
 * of it. Runs against a real temp SQLite database with the production schema.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDb, type TempDb } from '../database/repositories/__support__/tempDb'

const holder = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../database/init', () => ({ getDb: () => holder.current, initDb: () => holder.current }))
vi.mock('electron', () => ({ BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('./supabaseClient', () => ({ getSupabaseClient: () => ({}), isSupabaseConfigured: () => false }))
vi.mock('../telemetry/posthog', () => ({ resetTelemetryIdentity: () => {} }))

import { applySchema } from '../database/schema'
import { runMigrations } from '../database/migrations'
import { database } from '../database'
import { setActiveUser, onAccountSwitch, ACTIVE_USER_KEY } from './sessionManager'
import { AUTO_REPLY_KEY } from './personalData'
import { AUTO_REPLY_SETTING_KEY } from '../whatsappAutoReplyConfig'

let temp: TempDb
const switched = vi.fn()
onAccountSwitch(switched)

function count(table: string): number {
  return (temp.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

/** One person's footprint: a Gmail connection, memory, a contact, an auto-reply. */
function seedPersonalData(): void {
  database.settings.setSetting('gmail_refresh_token', 'refresh-of-first-person')
  database.settings.setSetting('telegram_bot_token', '123:abc')
  database.settings.setSetting(AUTO_REPLY_KEY, { enabled: true, allowlist: ['Ashu'] })
  temp.db
    .prepare("INSERT INTO channel_memory (id, subject_key, subject_label, channel, action, summary) VALUES ('m1','ashu','Ashu','whatsapp','sent','dinner at 8')")
    .run()
  temp.db.prepare("INSERT INTO contacts (id, display_name, name_key) VALUES ('c1','Ashu','ashu')").run()
  temp.db
    .prepare("INSERT INTO contact_identities (id, contact_id, channel, handle, handle_key) VALUES ('i1','c1','whatsapp','Ashu','ashu')")
    .run()
}

beforeEach(() => {
  temp = createTempDb()
  holder.current = temp.db
  applySchema()
  runMigrations()
  switched.mockClear()
})
afterEach(() => {
  temp.cleanup()
  holder.current = null
})

describe('a different account signing in', () => {
  it('removes the last person’s connections, memory and contacts', () => {
    setActiveUser('first')
    seedPersonalData()

    setActiveUser('second')
    expect(database.settings.getSetting('gmail_refresh_token')).toBeNull()
    expect(database.settings.getSetting('telegram_bot_token')).toBeNull()
    expect(database.settings.getSetting(AUTO_REPLY_KEY)).toBeNull()
    expect(count('channel_memory')).toBe(0)
    expect(count('contacts')).toBe(0)
    expect(count('contact_identities')).toBe(0)
    expect(switched).toHaveBeenCalledTimes(1)
    expect(database.settings.getSetting(ACTIVE_USER_KEY)).toBe('second')
  })

  it('keeps everything when the same person signs back in', () => {
    setActiveUser('first')
    seedPersonalData()
    database.settings.deleteSetting(ACTIVE_USER_KEY) // signed out

    setActiveUser('first')
    expect(database.settings.getSetting('gmail_refresh_token')).toBe('refresh-of-first-person')
    expect(count('channel_memory')).toBe(1)
    expect(switched).not.toHaveBeenCalled()
  })

  it('keeps an existing install’s data on the first sign-in after this update', () => {
    // No account recorded yet (installs from before this change): nothing to compare, nothing wiped.
    seedPersonalData()
    setActiveUser('first')
    expect(count('contacts')).toBe(1)
    expect(switched).not.toHaveBeenCalled()
  })

  it('clears the WhatsApp auto-reply under the key the app actually uses', () => {
    expect(AUTO_REPLY_KEY).toBe(AUTO_REPLY_SETTING_KEY)
  })
})
