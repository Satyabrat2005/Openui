import { getDb } from '../init'
import { randomUUID } from 'crypto'

/**
 * channel_memory — the persistence tier for OpenUI's cross-channel memory.
 *
 * One row per completed messaging action (a WhatsApp message sent, a Slack
 * channel read, an email drafted…), keyed by the CONTACT or TOPIC it concerns
 * rather than by the conversation it happened in. That key is what makes the
 * memory cross-channel: an action performed on WhatsApp and an action performed
 * on Slack about the same person land under the same `subject_key`, so recall
 * before a Slack reply can surface what happened on WhatsApp.
 *
 * Deliberately plain — a single table, no embeddings, no vector index. Recall
 * is lexical (see channelMemory.ts). This is enough for launch; anything
 * cleverer can replace scoreMemories() without touching this schema.
 *
 * Everything stays in the local SQLite DB. No row is ever uploaded, and the
 * user can see and delete all of it (Settings → Memory).
 */
export interface MemoryRow {
  id: string
  /** Normalised lookup key — lowercased, punctuation-stripped contact/topic. */
  subject_key: string
  /** Display form of the subject, as the user would recognise it ("Ashu"). */
  subject_label: string
  /** Which surface this happened on: whatsapp | telegram | slack | gmail. */
  channel: string
  /** The tool that produced the row, e.g. "send_whatsapp_message". */
  action: string
  /** 'sent' for outbound actions, 'read' for read-only ones. */
  direction: string
  /** One-line human-readable account of what happened. */
  summary: string
  created_at: number
}

/** Most recent rows kept per subject; older ones are pruned on write. */
export const MAX_ROWS_PER_SUBJECT = 20

/** Hard ceiling across all subjects, so the table can't grow without bound. */
export const MAX_ROWS_TOTAL = 500

/** Window in which an identical action is treated as the same memory. */
export const DEDUP_WINDOW_SECONDS = 300

export interface MemoryInput {
  subjectKey: string
  subjectLabel: string
  channel: string
  action: string
  direction: string
  summary: string
}

/**
 * Persist one channel action. Returns the new row id, or the id of the existing
 * row when this is an exact repeat.
 *
 * Repeats are collapsed rather than appended: the agent loop can legitimately
 * re-run the same tool inside one turn (a retry after a HITL denial, a
 * re-read while polling), and three identical "sent X to Ashu" lines would
 * crowd genuinely different memories out of both the recall block and the UI
 * list. Identity here is (subject, channel, action, summary) within
 * DEDUP_WINDOW_SECONDS — a genuinely repeated message an hour later is a new
 * fact and is stored.
 */
export function recordMemory(input: MemoryInput): string {
  const db = getDb()
  const existing = db
    .prepare(
      `SELECT id FROM channel_memory
       WHERE subject_key = ? AND channel = ? AND action = ? AND summary = ?
         AND created_at >= strftime('%s','now') - ?
       LIMIT 1`
    )
    .get(input.subjectKey, input.channel, input.action, input.summary, DEDUP_WINDOW_SECONDS) as
    | { id: string }
    | undefined
  if (existing) return existing.id

  const id = randomUUID()
  db.prepare(
    `INSERT INTO channel_memory
       (id, subject_key, subject_label, channel, action, direction, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.subjectKey,
    input.subjectLabel,
    input.channel,
    input.action,
    input.direction,
    input.summary
  )
  pruneSubject(input.subjectKey)
  pruneGlobal()
  return id
}

/** Drop everything past MAX_ROWS_PER_SUBJECT for one subject, oldest first. */
function pruneSubject(subjectKey: string): void {
  getDb()
    .prepare(
      `DELETE FROM channel_memory
       WHERE subject_key = ?
         AND id NOT IN (
           SELECT id FROM channel_memory WHERE subject_key = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`
    )
    .run(subjectKey, subjectKey, MAX_ROWS_PER_SUBJECT)
}

/** Drop the oldest rows once the table exceeds MAX_ROWS_TOTAL. */
function pruneGlobal(): void {
  getDb()
    .prepare(
      `DELETE FROM channel_memory
       WHERE id NOT IN (
         SELECT id FROM channel_memory ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`
    )
    .run(MAX_ROWS_TOTAL)
}

/** Every stored memory, newest first. Backs the Settings → Memory list. */
export function listMemories(limit = MAX_ROWS_TOTAL): MemoryRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM channel_memory ORDER BY created_at DESC, rowid DESC LIMIT ?'
    )
    .all(limit) as MemoryRow[]
}

/**
 * Candidate rows for recall: everything filed under any of `subjectKeys`, plus
 * the most recent `recentLimit` rows regardless of subject.
 *
 * The recent tail matters because the caller cannot always name the subject up
 * front — "what did they say about the deadline?" has a topic but no contact.
 * Ranking those candidates is scoreMemories()' job, not this one's.
 */
export function findMemories(subjectKeys: string[], recentLimit = 40): MemoryRow[] {
  const db = getDb()
  const byKey =
    subjectKeys.length > 0
      ? (db
          .prepare(
            `SELECT * FROM channel_memory
             WHERE subject_key IN (${subjectKeys.map(() => '?').join(',')})
             ORDER BY created_at DESC, rowid DESC LIMIT ?`
          )
          .all(...subjectKeys, MAX_ROWS_PER_SUBJECT * 2) as MemoryRow[])
      : []
  const recent = db
    .prepare('SELECT * FROM channel_memory ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(recentLimit) as MemoryRow[]

  const seen = new Set<string>()
  const merged: MemoryRow[] = []
  for (const row of [...byKey, ...recent]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }
  return merged
}

/** Delete one memory by id. Returns true when a row was actually removed. */
export function deleteMemory(id: string): boolean {
  const info = getDb().prepare('DELETE FROM channel_memory WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

/** Delete every memory filed under one subject. Returns the number removed. */
export function clearSubject(subjectKey: string): number {
  const info = getDb()
    .prepare('DELETE FROM channel_memory WHERE subject_key = ?')
    .run(subjectKey)
  return Number(info.changes)
}

/** Delete everything. Returns the number of rows removed. */
export function clearAllMemories(): number {
  const info = getDb().prepare('DELETE FROM channel_memory').run()
  return Number(info.changes)
}

/** Diagnostics / tests: total stored memories. */
export function countMemories(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM channel_memory').get() as { n: number }
  return row.n
}
