/**
 * Migration tests against REAL SQLite.
 *
 * migrations.test.ts drives the runner with a fake DB, which proves the
 * orchestration (ordered, exactly-once, idempotent) but cannot prove that a
 * migration's SQL is actually valid — a fake accepts any string. These tests
 * run the real schema.ts baseline and the real `migrations` list through
 * Node's built-in `node:sqlite`, so a malformed ALTER, a bad PRAGMA read, or a
 * default that doesn't backfill existing rows fails here instead of on a
 * user's machine after ship.
 *
 * They also cover the upgrade path that CREATE TABLE IF NOT EXISTS cannot: a
 * database created before the column existed, carrying rows, being brought
 * forward.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDb, type FakeDb, type TempDb } from './repositories/__support__/tempDb'

// The mock factory is hoisted above the imports, so the live handle has to live
// in a hoisted cell rather than an ordinary module-level `let`.
const handle = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('./init', () => ({
  getDb: () => {
    if (!handle.db) throw new Error('[test] temp db not installed')
    return handle.db
  },
  initDb: () => handle.db
}))

import { applySchema } from './schema'
import { applyMigrations, columnExists, migrations, type MigrationDb } from './migrations'
import {
  createConversation,
  getConversationById,
  setConversationArchived
} from './repositories/conversationRepo'

let temp: TempDb
let db: FakeDb

beforeEach(() => {
  temp = createTempDb()
  db = temp.db
  handle.db = db
})

afterEach(() => {
  handle.db = null
  temp.cleanup()
})

/** The v0 baseline exactly as a pre-migration install would have it on disk. */
function applyBaseline(): void {
  applySchema()
}

describe('real SQLite — 001_conversations_add_archived', () => {
  it('baseline schema does not create `archived` (the migration owns it)', () => {
    applyBaseline()
    expect(columnExists(db as MigrationDb, 'conversations', 'archived')).toBe(false)
  })

  it('adds `archived` to a fresh install and records it in _migrations', () => {
    applyBaseline()
    applyMigrations(db as MigrationDb)

    expect(columnExists(db as MigrationDb, 'conversations', 'archived')).toBe(true)

    // Assert against the real list rather than a literal: the property under
    // test is "every migration ran, in order, exactly once", and hardcoding the
    // names here makes an unrelated red appear every time one is appended.
    const rows = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>
    expect(rows.map((r) => r.name)).toEqual(migrations.map((m) => m.name))
    expect(rows.filter((r) => r.name === '001_conversations_add_archived')).toHaveLength(1)
  })

  it('backfills existing rows with 0 when upgrading an old database', () => {
    // An install that predates the column, with data already in it.
    applyBaseline()
    const id = createConversation(null, 'pre-existing chat')

    applyMigrations(db as MigrationDb)

    const row = getConversationById(id)
    expect(row).not.toBeNull()
    expect(row?.title).toBe('pre-existing chat')
    expect(row?.archived).toBe(0)
  })

  it('is exactly-once and non-destructive across restarts', () => {
    applyBaseline()
    applyMigrations(db as MigrationDb)

    const id = createConversation(null, 'keep me')
    setConversationArchived(id, true)

    // Two more "app starts" against the same file.
    applyMigrations(db as MigrationDb)
    applyMigrations(db as MigrationDb)

    const applied = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>
    expect(applied).toHaveLength(migrations.length)

    // The second/third pass must not reset data or duplicate the column.
    expect(getConversationById(id)?.archived).toBe(1)
    const cols = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    expect(cols.filter((c) => c.name === 'archived')).toHaveLength(1)
  })

  it('round-trips archived through the repository layer', () => {
    applyBaseline()
    applyMigrations(db as MigrationDb)

    const id = createConversation(null, 'chat')
    expect(getConversationById(id)?.archived).toBe(0)

    setConversationArchived(id, true)
    expect(getConversationById(id)?.archived).toBe(1)

    setConversationArchived(id, false)
    expect(getConversationById(id)?.archived).toBe(0)
  })
})

describe('real SQLite — runner invariants', () => {
  it('creates the _migrations version-tracking table on first run', () => {
    applyBaseline()
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .all()
    expect(before).toHaveLength(0)

    applyMigrations(db as MigrationDb)

    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .all()
    expect(after).toHaveLength(1)
  })

  it('rolls back and rethrows when a migration fails, leaving it unrecorded', () => {
    applyBaseline()

    expect(() =>
      applyMigrations(db as MigrationDb, [
        {
          name: 'bad_migration',
          up: (d) => {
            d.exec('ALTER TABLE conversations ADD COLUMN ok INTEGER DEFAULT 0')
            d.exec('THIS IS NOT SQL')
          }
        }
      ])
    ).toThrow()

    // The whole migration is one transaction: neither the column nor the
    // bookkeeping row may survive, otherwise a retry on next start is skipped.
    expect(columnExists(db as MigrationDb, 'conversations', 'ok')).toBe(false)
    const applied = db.prepare('SELECT name FROM _migrations').all()
    expect(applied).toHaveLength(0)
  })

  it('every registered migration is idempotent when replayed on a migrated DB', () => {
    applyBaseline()
    applyMigrations(db as MigrationDb)

    // Force each `up` to run a second time against an already-migrated database.
    // Guarded ALTERs (columnExists / IF NOT EXISTS) must make this harmless.
    for (const m of migrations) {
      expect(() => m.up(db as MigrationDb), `${m.name} is not replay-safe`).not.toThrow()
    }
  })
})

describe('real SQLite — 002_channel_memory', () => {
  /** Rows of PRAGMA table_info for `table`, or [] when it does not exist. */
  function columnsOf(table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  }

  it('baseline schema does not create channel_memory (the migration owns it)', () => {
    applyBaseline()
    expect(columnsOf('channel_memory')).toEqual([])
  })

  it('creates the table with the columns the repository queries', () => {
    applyBaseline()
    applyMigrations(db as MigrationDb)

    // Named explicitly: memoryRepo's SQL selects and filters on each of these,
    // so a typo in the migration would only surface at runtime otherwise.
    expect(columnsOf('channel_memory').sort()).toEqual(
      [
        'action',
        'channel',
        'created_at',
        'direction',
        'id',
        'subject_key',
        'subject_label',
        'summary'
      ].sort()
    )
  })

  it('brings forward an OLD install that already carries conversations', () => {
    // The upgrade path CREATE TABLE IF NOT EXISTS in schema.ts cannot cover:
    // a database made before the feature existed, with real data in it.
    applyBaseline()
    const id = createConversation(null, 'chat from before memory shipped')

    applyMigrations(db as MigrationDb)

    expect(columnsOf('channel_memory')).toContain('subject_key')
    // The pre-existing data is untouched.
    expect(getConversationById(id)?.title).toBe('chat from before memory shipped')
  })

  it('defaults created_at so the repository never has to supply it', () => {
    applyBaseline()
    applyMigrations(db as MigrationDb)

    db.prepare(
      `INSERT INTO channel_memory (id, subject_key, subject_label, channel, action, direction, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m1', 'ashu', 'Ashu', 'whatsapp', 'send_whatsapp_message', 'sent', 'hello')

    const row = db.prepare('SELECT created_at FROM channel_memory WHERE id = ?').get('m1') as {
      created_at: number
    }
    expect(row.created_at).toBeGreaterThan(0)
  })
})
