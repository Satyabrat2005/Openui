import { getDb } from '../init'

export function getSetting(key: string): unknown {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as unknown
  } catch {
    return row.value
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = strftime('%s','now')`
    )
    .run(key, JSON.stringify(value))
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}
