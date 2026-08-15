import { getDb } from './init'

// Minimal structural view of the better-sqlite3 Database — just the surface the
// migration runner uses. Declaring it structurally (rather than importing the
// concrete type) keeps this module unit-testable: the native better-sqlite3
// binding is compiled for Electron's ABI and cannot load under plain Node, so
// tests inject a lightweight fake that satisfies this shape. The real
// getDb() return value satisfies it too.
export interface MigrationDb {
  exec(sql: string): unknown
  prepare(sql: string): {
    all: (...args: unknown[]) => unknown[]
    run: (...args: unknown[]) => unknown
    get?: (...args: unknown[]) => unknown
  }
  transaction: <F extends (...args: never[]) => unknown>(fn: F) => F
}

export interface Migration {
  name: string
  up: (db: MigrationDb) => void
}

/**
 * Ordered list of schema deltas applied on top of the v0 baseline in
 * schema.ts. schema.ts is a frozen snapshot of the initial schema; every
 * change made after the migration mechanism landed goes here, never back into
 * schema.ts. Rules:
 *   - Never edit or reorder an existing entry — old databases have already
 *     recorded it by name and will not re-run it.
 *   - Append new migrations to the end with a fresh, unique name.
 *   - Make each `up` idempotent (guard ALTERs with columnExists, use
 *     IF NOT EXISTS for tables/indexes) so a fresh install — where schema.ts
 *     may already have created the object — runs the migration harmlessly.
 */
export const migrations: Migration[] = [
  {
    // Nullable archive flag for conversations. Owned by this migration rather
    // than schema.ts to exercise the runner end-to-end and establish the
    // "new columns ship as migrations" convention.
    name: '001_conversations_add_archived',
    up: (db) => {
      if (!columnExists(db, 'conversations', 'archived')) {
        db.exec('ALTER TABLE conversations ADD COLUMN archived INTEGER DEFAULT 0')
      }
    }
  },
  {
    // Cross-channel memory: one row per completed messaging action, keyed by
    // the contact or topic it concerns rather than by conversation, so recall
    // before a Slack reply can surface what happened on WhatsApp. Ships as a
    // migration (not schema.ts) so existing installs get the table too.
    // See database/repositories/memoryRepo.ts and channelMemory.ts.
    name: '002_channel_memory',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_memory (
          id TEXT PRIMARY KEY,
          subject_key TEXT NOT NULL,
          subject_label TEXT NOT NULL,
          channel TEXT NOT NULL,
          action TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'sent',
          summary TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_channel_memory_subject ON channel_memory(subject_key);
        CREATE INDEX IF NOT EXISTS idx_channel_memory_created ON channel_memory(created_at);
      `)
    }
  }
]

/**
 * True if `table` already has a column named `column`. Reads via a prepared
 * PRAGMA (not db.pragma()) so it returns rows uniformly across better-sqlite3
 * and the node:sqlite-backed test harness. `table` must be a trusted literal
 * from a migration definition — never interpolate user input here.
 */
export function columnExists(db: MigrationDb, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

/**
 * Bring `db` up to date by running every not-yet-applied migration in order,
 * each in its own transaction, recording its name in the _migrations table so
 * it never runs twice (including across app restarts). Injectable for tests;
 * app code calls runMigrations() which targets the live database.
 */
export function applyMigrations(db: MigrationDb, list: Migration[] = migrations): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((r) => r.name)
  )

  for (const migration of list) {
    if (applied.has(migration.name)) continue
    db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name)
    })()
    console.log('[db] applied migration:', migration.name)
  }
}

export function runMigrations(): void {
  applyMigrations(getDb() as unknown as MigrationDb)
}
