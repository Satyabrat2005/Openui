import { getDb } from '../init'
import { randomUUID } from 'crypto'

export interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  tool_calls: string | null
  tool_results: string | null
  model: string | null
  token_count: number | null
  created_at: number
}

export function addMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
  model?: string,
  toolCalls?: unknown,
  toolResults?: unknown
): string {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO messages (id, conversation_id, role, content, model, tool_calls, tool_results)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      conversationId,
      role,
      content,
      model ?? null,
      toolCalls != null ? JSON.stringify(toolCalls) : null,
      toolResults != null ? JSON.stringify(toolResults) : null
    )
  return id
}

export function getMessagesByConversation(conversationId: string): MessageRow[] {
  return getDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as MessageRow[]
}

export function deleteMessage(id: string): void {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(id)
}
