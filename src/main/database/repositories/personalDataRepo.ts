import { getDb } from '../init'

/**
 * Tables that hold one person's data but are stored once per install (not per
 * account). Child tables first, so foreign keys never block a delete.
 * See auth/personalData.ts for when they are cleared.
 */
export const PERSONAL_TABLES = [
  'channel_memory',
  'contact_identities',
  'contacts',
  'training_steps',
  'training_examples',
  'conversation_feedback'
] as const

/** Delete every row of every personal table, in one transaction. */
export function clearPersonalTables(): void {
  const db = getDb()
  db.transaction(() => {
    for (const table of PERSONAL_TABLES) {
      // A table an older install never created is simply not there.
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (exists) db.prepare(`DELETE FROM ${table}`).run()
    }
  })()
}
