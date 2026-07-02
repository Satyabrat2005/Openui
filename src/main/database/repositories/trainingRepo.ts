import { getDb } from '../init'
import { randomUUID } from 'crypto'

/**
 * trainingRepo — the data layer for OpenUI's central training store.
 *
 * Unlike conversation_feedback (which keeps only the final user message and
 * final answer), this captures the FULL trajectory of a completed turn: the
 * instruction, every reasoning + tool-execution step in order, the outcome, and
 * a 1–5 quality score derived from the user's reaction. The higher-level
 * orchestration (scoring rules, JSONL export, few-shot exemplar selection) lives
 * in trainingStore.ts; this file is pure SQLite CRUD so it can be used without an
 * import cycle. Everything stays in the local DB — nothing is uploaded.
 */

export type TrainingOutcome = 'success' | 'partial' | 'error' | 'unknown'

export interface TrainingExampleRow {
  id: string
  conversation_id: string | null
  user_id: string | null
  instruction: string
  final_response: string | null
  step_count: number
  tool_sequence: string | null
  outcome: TrainingOutcome
  quality_score: number
  model: string | null
  tier: string | null
  duration_ms: number | null
  created_at: number
}

export interface TrainingStepRow {
  id: string
  example_id: string
  step_index: number
  reasoning: string | null
  tool_name: string | null
  tool_args: string | null
  tool_result: string | null
  status: 'success' | 'error' | null
  duration_ms: number | null
  created_at: number
}

/** Shape passed in by trainingStore when committing a finished trajectory. */
export interface TrainingStepInput {
  reasoning?: string
  toolName?: string
  toolArgs?: unknown
  toolResult?: string
  status?: 'success' | 'error'
  durationMs?: number
}

export interface TrainingExampleInput {
  conversationId: string | null
  userId: string | null
  instruction: string
  finalResponse: string
  outcome: TrainingOutcome
  qualityScore?: number
  model?: string | null
  tier?: string | null
  durationMs?: number
  steps: TrainingStepInput[]
}

/** Default (neutral) quality until the next user message re-scores it. */
const NEUTRAL_QUALITY = 3

/**
 * Persist a full trajectory (example header + ordered steps) in one transaction.
 * Returns the new example id.
 */
export function saveExample(input: TrainingExampleInput): string {
  const db = getDb()
  const exampleId = randomUUID()
  const toolSequence = input.steps
    .map((s) => s.toolName)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)

  const insertExample = db.prepare(
    `INSERT INTO training_examples
       (id, conversation_id, user_id, instruction, final_response, step_count,
        tool_sequence, outcome, quality_score, model, tier, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertStep = db.prepare(
    `INSERT INTO training_steps
       (id, example_id, step_index, reasoning, tool_name, tool_args, tool_result, status, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  db.transaction(() => {
    insertExample.run(
      exampleId,
      input.conversationId,
      input.userId,
      input.instruction,
      input.finalResponse,
      input.steps.length,
      toolSequence.length ? JSON.stringify(toolSequence) : null,
      input.outcome,
      input.qualityScore ?? NEUTRAL_QUALITY,
      input.model ?? null,
      input.tier ?? null,
      input.durationMs ?? null
    )
    input.steps.forEach((step, index) => {
      insertStep.run(
        randomUUID(),
        exampleId,
        index,
        step.reasoning ?? null,
        step.toolName ?? null,
        step.toolArgs != null ? JSON.stringify(step.toolArgs) : null,
        step.toolResult ?? null,
        step.status ?? null,
        step.durationMs ?? null
      )
    })
  })()

  return exampleId
}

/**
 * Re-score the most recent example in a conversation (mirrors
 * feedbackRepo.applySignalToLast). Called when the user's next message signals
 * satisfaction/dissatisfaction with the previous turn. No-op when none exists.
 */
export function updateQualityForLastInConversation(
  conversationId: string | null,
  qualityScore: number
): void {
  const db = getDb()
  const last = (
    conversationId
      ? db
          .prepare(
            `SELECT id FROM training_examples
             WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
          )
          .get(conversationId)
      : db
          .prepare(
            `SELECT id FROM training_examples ORDER BY created_at DESC, rowid DESC LIMIT 1`
          )
          .get()
  ) as { id: string } | undefined
  if (!last) return
  db.prepare('UPDATE training_examples SET quality_score = ? WHERE id = ?').run(qualityScore, last.id)
}

/** Apply an explicit 👍/👎 (5/1) to the most recent example across all threads. */
export function setQualityOnLast(qualityScore: number): void {
  const db = getDb()
  const last = db
    .prepare('SELECT id FROM training_examples ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { id: string } | undefined
  if (!last) return
  db.prepare('UPDATE training_examples SET quality_score = ? WHERE id = ?').run(qualityScore, last.id)
}

/** Fetch a single example with its ordered steps, or null. */
export function getExampleWithSteps(
  exampleId: string
): { example: TrainingExampleRow; steps: TrainingStepRow[] } | null {
  const db = getDb()
  const example = db
    .prepare('SELECT * FROM training_examples WHERE id = ?')
    .get(exampleId) as TrainingExampleRow | undefined
  if (!example) return null
  const steps = db
    .prepare('SELECT * FROM training_steps WHERE example_id = ? ORDER BY step_index ASC')
    .all(exampleId) as TrainingStepRow[]
  return { example, steps }
}

/**
 * All examples matching a minimum quality/outcome, newest first, each with its
 * ordered steps. Used by the JSONL exporter. `minQuality` defaults to 1 (all).
 */
export function getExamplesForExport(
  minQuality = 1,
  limit = 10_000
): Array<{ example: TrainingExampleRow; steps: TrainingStepRow[] }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM training_examples
       WHERE quality_score >= ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(minQuality, limit) as TrainingExampleRow[]
  return rows.map((example) => ({
    example,
    steps: db
      .prepare('SELECT * FROM training_steps WHERE example_id = ? ORDER BY step_index ASC')
      .all(example.id) as TrainingStepRow[]
  }))
}

/**
 * Best exemplars for few-shot prompting: highest quality + successful outcomes,
 * de-duplicated by instruction so we don't feed the model five variants of the
 * same task. Returns at most `limit` examples with their steps.
 */
export function getTopExemplars(
  limit = 3,
  minQuality = 4
): Array<{ example: TrainingExampleRow; steps: TrainingStepRow[] }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM training_examples
       WHERE quality_score >= ? AND outcome = 'success' AND step_count > 0
       GROUP BY instruction
       ORDER BY quality_score DESC, created_at DESC
       LIMIT ?`
    )
    .all(minQuality, limit) as TrainingExampleRow[]
  return rows.map((example) => ({
    example,
    steps: db
      .prepare('SELECT * FROM training_steps WHERE example_id = ? ORDER BY step_index ASC')
      .all(example.id) as TrainingStepRow[]
  }))
}

export interface TrainingStats {
  total: number
  byOutcome: Record<TrainingOutcome, number>
  highQuality: number
  avgSteps: number
}

/** Aggregate counts for the dataset (diagnostics / a future dashboard). */
export function getStats(): TrainingStats {
  const db = getDb()
  const total = (db.prepare('SELECT COUNT(*) AS n FROM training_examples').get() as { n: number }).n
  const highQuality = (
    db.prepare('SELECT COUNT(*) AS n FROM training_examples WHERE quality_score >= 4').get() as {
      n: number
    }
  ).n
  const avgSteps =
    (db.prepare('SELECT AVG(step_count) AS a FROM training_examples').get() as { a: number | null })
      .a ?? 0
  const outcomeRows = db
    .prepare('SELECT outcome, COUNT(*) AS n FROM training_examples GROUP BY outcome')
    .all() as Array<{ outcome: TrainingOutcome; n: number }>
  const byOutcome: Record<TrainingOutcome, number> = {
    success: 0,
    partial: 0,
    error: 0,
    unknown: 0
  }
  for (const row of outcomeRows) byOutcome[row.outcome] = row.n
  return { total, byOutcome, highQuality, avgSteps: Math.round(avgSteps * 10) / 10 }
}
