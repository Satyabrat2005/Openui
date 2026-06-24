import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import BetterSqlite3 from 'better-sqlite3'

let db: BetterSqlite3.Database | null = null

export function initDb(): BetterSqlite3.Database {
  if (db) return db
  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })
  const dbPath = join(userDataPath, 'openui.db')
  console.log('[db] database path:', dbPath)
  db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  return db
}

export function getDb(): BetterSqlite3.Database {
  if (!db) throw new Error('[db] Database not initialized — call initDatabase() first.')
  return db
}
