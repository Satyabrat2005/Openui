import { describe, it, expect } from 'vitest'
import { applyMigrations, columnExists, migrations, type Migration, type MigrationDb } from './migrations'

// The real better-sqlite3 binding is compiled for Electron's ABI and cannot
// load under plain Node, so these tests drive the runner with a tiny fake DB
// that models exactly the two things the mechanism depends on: the set of
// applied migration names and per-table column lists (for columnExists /
// ALTER ... ADD COLUMN). This proves the orchestration — ordered, exactly-once,
// idempotent across restarts, guarded ALTERs — without native SQLite.
function makeFakeDb(initialColumns: Record<string, string[]> = {}): MigrationDb & {
  appliedNames: string[]
  columns: Record<string, string[]>
} {
  const columns: Record<string, string[]> = {}
  for (const [t, cols] of Object.entries(initialColumns)) columns[t] = [...cols]
  const appliedNames: string[] = []

  const db: MigrationDb & { appliedNames: string[]; columns: Record<string, string[]> } = {
    appliedNames,
    columns,
    exec(sql: string) {
      // Only ALTER TABLE <t> ADD COLUMN <c> needs to mutate state here.
      const m = /ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(sql)
      if (m) {
        const [, table, col] = m
        const list = columns[table] ?? (columns[table] = [])
        if (list.includes(col)) throw new Error(`duplicate column: ${table}.${col}`)
        list.push(col)
      }
      return undefined
    },
    prepare(sql: string) {
      const pragma = /PRAGMA table_info\((\w+)\)/i.exec(sql)
      if (pragma) {
        const table = pragma[1]
        return { all: () => (columns[table] ?? []).map((name) => ({ name })), run: () => undefined }
      }
      if (/SELECT name FROM _migrations/i.test(sql)) {
        return { all: () => appliedNames.map((name) => ({ name })), run: () => undefined }
      }
      if (/INSERT INTO _migrations/i.test(sql)) {
        return {
          all: () => [],
          run: (name: unknown) => {
            appliedNames.push(name as string)
            return undefined
          }
        }
      }
      return { all: () => [], run: () => undefined }
    },
    transaction<F extends (...args: never[]) => unknown>(fn: F): F {
      // better-sqlite3 returns a wrapper that runs fn atomically; a direct call
      // is a faithful stand-in for these single-threaded tests.
      return fn
    }
  }
  return db
}

describe('applyMigrations', () => {
  it('applies a pending migration and records it', () => {
    const db = makeFakeDb({ conversations: ['id', 'title'] })
    const ran: string[] = []
    const list: Migration[] = [{ name: 'm1', up: () => ran.push('m1') }]

    applyMigrations(db, list)

    expect(ran).toEqual(['m1'])
    expect(db.appliedNames).toEqual(['m1'])
  })

  it('does not re-run a migration on a second pass (restart)', () => {
    const db = makeFakeDb({ conversations: ['id'] })
    const ran: string[] = []
    const list: Migration[] = [{ name: 'm1', up: () => ran.push('m1') }]

    applyMigrations(db, list)
    applyMigrations(db, list) // simulate next app start

    expect(ran).toEqual(['m1'])
    expect(db.appliedNames).toEqual(['m1'])
  })

  it('runs multiple migrations in registration order', () => {
    const db = makeFakeDb()
    const ran: string[] = []
    const list: Migration[] = [
      { name: 'a', up: () => ran.push('a') },
      { name: 'b', up: () => ran.push('b') },
      { name: 'c', up: () => ran.push('c') }
    ]

    applyMigrations(db, list)

    expect(ran).toEqual(['a', 'b', 'c'])
  })

  it('only runs the newly-appended migration when earlier ones are already applied', () => {
    const db = makeFakeDb()
    const ran: string[] = []
    const first: Migration[] = [{ name: 'a', up: () => ran.push('a') }]
    applyMigrations(db, first)

    const second: Migration[] = [...first, { name: 'b', up: () => ran.push('b') }]
    applyMigrations(db, second)

    expect(ran).toEqual(['a', 'b'])
    expect(db.appliedNames).toEqual(['a', 'b'])
  })
})

describe('columnExists', () => {
  it('reflects table_info', () => {
    const db = makeFakeDb({ conversations: ['id', 'title'] })
    expect(columnExists(db, 'conversations', 'title')).toBe(true)
    expect(columnExists(db, 'conversations', 'archived')).toBe(false)
  })
})

describe('001_conversations_add_archived (real migration)', () => {
  it('adds archived on an old DB that lacks it, and records the migration', () => {
    const db = makeFakeDb({ conversations: ['id', 'title'] }) // pre-migration shape

    applyMigrations(db)

    expect(db.columns.conversations).toContain('archived')
    expect(db.appliedNames).toContain('001_conversations_add_archived')
  })

  it('is a no-op ALTER on a fresh DB that already has archived, but still records', () => {
    // Fresh-install path: schema.ts (hypothetically) already created the column.
    const db = makeFakeDb({ conversations: ['id', 'title', 'archived'] })

    expect(() => applyMigrations(db)).not.toThrow()
    expect(db.columns.conversations.filter((c) => c === 'archived')).toHaveLength(1)
    expect(db.appliedNames).toContain('001_conversations_add_archived')
  })

  it('does not re-add archived across a restart', () => {
    const db = makeFakeDb({ conversations: ['id'] })
    applyMigrations(db)
    applyMigrations(db)
    expect(db.columns.conversations.filter((c) => c === 'archived')).toHaveLength(1)
  })
})

describe('registered migrations', () => {
  it('have unique names', () => {
    const names = migrations.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
