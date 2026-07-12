import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, renameSync, existsSync } from 'fs'
import BetterSqlite3 from 'better-sqlite3'

let db: BetterSqlite3.Database | null = null

export function initDb(): BetterSqlite3.Database {
  if (db) return db
  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })
  const dbPath = join(userDataPath, 'openui.db')
  console.log('[db] database path:', dbPath)
  db = openHealthyDb(dbPath)
  db.pragma('journal_mode = WAL')
  return db
}

/**
 * Open the SQLite database, self-healing a corrupt file instead of letting every
 * query throw. A hard crash or a force-kill mid-write (or a bad disk) can leave
 * the file "malformed" (SQLITE_CORRUPT) — after which the app boots but chat and
 * history throw on every message, which looks like the app is broken. When we
 * detect that, we move the bad files ASIDE (never delete — they may be partly
 * recoverable) and open a fresh database at the same path so the app keeps
 * working. The caller runs migrations afterwards, which rebuild the schema.
 *
 * Exported for direct testing; production code goes through initDb().
 */
export function openHealthyDb(dbPath: string): BetterSqlite3.Database {
  let candidate: BetterSqlite3.Database | null = null
  try {
    candidate = new BetterSqlite3(dbPath)
    // quick_check is fast and returns 'ok' on a clean image; a malformed file
    // reports the corruption here — or THROWS (e.g. SQLITE_NOTADB) — rather than
    // on open, since SQLite opens lazily.
    const verdict = candidate.pragma('quick_check', { simple: true })
    if (verdict === 'ok') return candidate
    throw new Error(`quick_check: ${String(verdict)}`)
  } catch (err) {
    // Close the handle first: on Windows an open file is locked, and the rename
    // below fails with EBUSY unless we release it. Safe if it never opened.
    try {
      candidate?.close()
    } catch {
      /* already closed / never opened */
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[db] database is unusable (${msg}); backing it up and starting fresh.`)
    quarantineCorruptDb(dbPath)
    return new BetterSqlite3(dbPath) // a brand-new file at the same path
  }
}

/** Move a corrupt DB and its -wal/-shm sidecars aside so a fresh one can open. */
function quarantineCorruptDb(dbPath: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`
    try {
      if (existsSync(p)) renameSync(p, `${p}.corrupt-${stamp}`)
    } catch (e) {
      console.error(`[db] could not move ${p} aside:`, e)
    }
  }
}

export function getDb(): BetterSqlite3.Database {
  if (!db) throw new Error('[db] Database not initialized — call initDatabase() first.')
  return db
}
