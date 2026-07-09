/**
 * tempDb — a tiny test-only database harness for the repository layer.
 *
 * The repositories talk to better-sqlite3 (a native module compiled for
 * Electron's ABI), which cannot be `require()`d under a plain-Node Vitest
 * runner. Rather than rebuild the native binding for the test environment, we
 * back the tests with Node's built-in `node:sqlite` and expose the *subset* of
 * the better-sqlite3 surface the repositories actually use:
 *
 *   prepare(sql).run(...) / .get(...) / .all(...) · exec(sql) · pragma(str) ·
 *   transaction(fn) → callable
 *
 * Every test gets its own temp database FILE (created + torn down per test) so
 * the suites stay fully isolated, and the real `schema.ts` + `migrations.ts` are
 * applied through the same mocked `getDb`, so the production schema — including
 * its CHECK / PRIMARY KEY / FOREIGN KEY constraints — is what's under test.
 *
 * NOTE: `PRAGMA foreign_keys = ON` is enabled here so the schema's declared
 * foreign keys are actually enforced, letting the tests assert on missing-FK
 * violations. (SQLite leaves FK enforcement off by default.)
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `node:sqlite` is a recent Node built-in that Vite's dependency resolver does
// not yet recognise, so a static `import` fails at transform time. Loading it
// through createRequire sidesteps Vite entirely and resolves it at runtime.
interface RawStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface RawDatabase {
  prepare(sql: string): RawStatement
  exec(sql: string): void
  close(): void
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => RawDatabase
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule

/** The minimal prepared-statement surface the repositories rely on. */
interface FakeStatement {
  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}

/** The minimal better-sqlite3 Database surface the repositories rely on. */
export interface FakeDb {
  prepare(sql: string): FakeStatement
  exec(sql: string): void
  pragma(source: string): void
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R
}

export interface TempDb {
  /** The better-sqlite3-compatible handle repositories receive from getDb(). */
  db: FakeDb
  /** Close the connection and delete the temp directory. */
  cleanup(): void
}

function wrap(raw: RawDatabase): FakeDb {
  const db: FakeDb = {
    prepare(sql: string): FakeStatement {
      const stmt = raw.prepare(sql)
      return {
        run: (...args: unknown[]) =>
          stmt.run(...(args as never[])) as { changes: number | bigint; lastInsertRowid: number | bigint },
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[]))
      }
    },
    exec: (sql: string) => raw.exec(sql),
    pragma: (source: string) => raw.exec(`PRAGMA ${source}`),
    // better-sqlite3's transaction() returns a function that runs fn inside a
    // BEGIN/COMMIT, rolling back (and re-throwing) on any error.
    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      return (...args: Args): R => {
        raw.exec('BEGIN')
        try {
          const result = fn(...args)
          raw.exec('COMMIT')
          return result
        } catch (err) {
          try {
            raw.exec('ROLLBACK')
          } catch {
            /* connection may already be rolled back */
          }
          throw err
        }
      }
    }
  }
  return db
}

/**
 * Create a fresh temp-file database with foreign-key enforcement on. The caller
 * is responsible for calling cleanup() (typically in afterEach). The schema is
 * NOT applied here — the caller wires getDb() to `db` first (so schema.ts /
 * migrations.ts resolve to this handle) and then applies it.
 */
export function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'openui-repo-test-'))
  const raw = new DatabaseSync(join(dir, 'openui-test.db'))
  raw.exec('PRAGMA foreign_keys = ON')
  return {
    db: wrap(raw),
    cleanup(): void {
      try {
        raw.close()
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
