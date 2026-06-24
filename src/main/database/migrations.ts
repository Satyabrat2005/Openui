import { getDb } from './init'

interface Migration {
  name: string
  up: () => void
}

// Register future schema changes here — never modify existing entries.
const migrations: Migration[] = []

export function runMigrations(): void {
  const db = getDb()

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

  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      db.transaction(() => {
        migration.up()
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name)
      })()
      console.log('[db] applied migration:', migration.name)
    }
  }
}
