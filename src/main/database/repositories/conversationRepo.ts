import { getDb } from '../init'
import { randomUUID } from 'crypto'

export interface ConversationRow {
  id: string
  user_id: string | null
  title: string
  model_used: string | null
  tier_at_time: string | null
  created_at: number
  updated_at: number
}

export function createConversation(userId: string | null, title = 'New Chat'): string {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)')
    .run(id, userId, title)
  return id
}

export function getConversationsByUser(userId: string): ConversationRow[] {
  return getDb()
    .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as ConversationRow[]
}

export function getConversationById(id: string): ConversationRow | null {
  return (
    (getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined) ?? null
  )
}

export function updateConversationTitle(id: string, title: string): void {
  getDb()
    .prepare(`UPDATE conversations SET title = ?, updated_at = strftime('%s','now') WHERE id = ?`)
    .run(title, id)
}

export function deleteConversation(id: string): void {
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}
