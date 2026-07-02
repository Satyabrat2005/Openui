/**
 * trainingStore.ts — OpenUI's central conversation/training store.
 *
 * This is the layer that turns everyday use into a self-reinforcing dataset. For
 * every completed turn the agent records a full TRAJECTORY: the user's
 * instruction, each reasoning step + tool call + tool result in order, the
 * outcome, and (once the user reacts) a 1–5 quality score. That corpus is then
 * used two ways:
 *
 *   1. EXPORT — `exportDatasetToFile` writes a fine-tuning-ready JSONL file
 *      (standard {"messages":[…]} chat format), so the trajectories can train a
 *      future model offline.
 *   2. FEED-BACK (works today, no fine-tuning) — `buildFewShotBlock` selects the
 *      best past trajectories and formats them as few-shot exemplars appended to
 *      the system prompt, so the free-tier model imitates its own proven
 *      successes and gets stronger with use.
 *
 * Everything is local (SQLite + a file the user chooses on export). Capture is
 * gated by the same AI-Improvement toggle as the feedback loop, so turning it
 * off stops both recording and feed-back. See improvement.ts / promptRefiner.ts.
 */
import { app, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { database } from './database'
import type { TrainingOutcome, TrainingStepInput } from './database/repositories/trainingRepo'
import { isImprovementEnabled } from './improvement'

// ── Trajectory recorder ───────────────────────────────────────────────────────

/**
 * Accumulates the steps of a single in-flight turn, then commits the whole
 * trajectory to the store in one transaction. The agent creates one per turn,
 * calls `recordStep` for each tool execution, and `commit` when the turn ends.
 * Failures are swallowed (best-effort): training capture must never break chat.
 */
export class TrajectoryRecorder {
  private readonly steps: TrainingStepInput[] = []
  private readonly startedAt = Date.now()
  private sawError = false
  private sawSuccess = false

  constructor(
    private readonly ctx: {
      conversationId: string | null
      userId: string | null
      instruction: string
      model: string | null
      tier: string | null
    }
  ) {}

  /** Whether capture is enabled right now (respects the AI-Improvement toggle). */
  static enabled(): boolean {
    return isImprovementEnabled()
  }

  /**
   * Record one reasoning + tool-execution step. `reasoning` is the model's raw
   * message that produced the call (its "thought + action"); the rest describes
   * what the tool did.
   */
  recordStep(step: {
    reasoning: string
    toolName: string
    toolArgs: unknown
    toolResult: string
    status: 'success' | 'error'
    durationMs: number
  }): void {
    if (step.status === 'error') this.sawError = true
    else this.sawSuccess = true
    this.steps.push(step)
  }

  /** Whether any step has been recorded (a pure-chat turn records none). */
  get hasSteps(): boolean {
    return this.steps.length > 0
  }

  /**
   * Finalise and persist the trajectory. `reachedLimit` marks turns that hit the
   * tool-call cap (recorded as 'partial'). Returns the new example id, or null
   * when capture is disabled or nothing worth storing happened.
   */
  commit(finalResponse: string, reachedLimit = false): string | null {
    if (!TrajectoryRecorder.enabled()) return null
    // A pure natural-language reply with no tools and no answer isn't useful
    // training signal; skip it. (Tool trajectories are always worth keeping.)
    if (!this.hasSteps && !finalResponse.trim()) return null

    const outcome: TrainingOutcome = reachedLimit
      ? 'partial'
      : this.sawError && !this.sawSuccess
        ? 'error'
        : 'success'

    try {
      return database.training.saveExample({
        conversationId: this.ctx.conversationId,
        userId: this.ctx.userId,
        instruction: this.ctx.instruction,
        finalResponse,
        outcome,
        model: this.ctx.model,
        tier: this.ctx.tier,
        durationMs: Date.now() - this.startedAt,
        steps: this.steps
      })
    } catch (err) {
      console.error('[trainingStore] failed to commit trajectory:', err)
      return null
    }
  }
}

// ── Quality scoring (mirrors the feedback loop) ────────────────────────────────

/** Positive reaction → quality 5, negative → 1, on the last example in a thread. */
export function applyQualitySignal(
  conversationId: string | null,
  signal: 'positive' | 'negative'
): void {
  try {
    database.training.updateQualityForLastInConversation(
      conversationId,
      signal === 'negative' ? 1 : 5
    )
  } catch (err) {
    console.error('[trainingStore] failed to apply quality signal:', err)
  }
}

/** Explicit 👍/👎 (5/1) applied to the most recent example. */
export function applyExplicitQuality(rating: 1 | 5): void {
  try {
    database.training.setQualityOnLast(rating)
  } catch (err) {
    console.error('[trainingStore] failed to apply explicit quality:', err)
  }
}

// ── Few-shot feed-back (the "gets stronger with use" mechanism) ────────────────

/** Cap how much exemplar text we prepend, so the prompt stays bounded. */
const MAX_EXEMPLARS = 3
const MAX_STEP_CHARS = 240
const MAX_INSTRUCTION_CHARS = 200

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * Build a compact "learned examples" block from the best past trajectories, to
 * append to the system prompt. Returns '' when the loop is off or there aren't
 * enough high-quality examples yet — so early on it's a no-op and the prompt is
 * unchanged. This is what lets the free-tier model imitate its own successes
 * without any fine-tuning.
 */
export function buildFewShotBlock(): string {
  if (!isImprovementEnabled()) return ''
  let exemplars: ReturnType<typeof database.training.getTopExemplars>
  try {
    exemplars = database.training.getTopExemplars(MAX_EXEMPLARS, 4)
  } catch (err) {
    console.error('[trainingStore] failed to load exemplars:', err)
    return ''
  }
  if (exemplars.length === 0) return ''

  const blocks = exemplars.map(({ example, steps }, i) => {
    const stepLines = steps
      .filter((s) => s.tool_name)
      .map((s) => {
        const args = s.tool_args ? ` ${truncate(s.tool_args, MAX_STEP_CHARS)}` : ''
        const result = s.tool_result ? ` → ${truncate(s.tool_result, MAX_STEP_CHARS)}` : ''
        return `   ${s.step_index + 1}. ${s.tool_name}${args}${result}`
      })
      .join('\n')
    return [
      `Example ${i + 1} — user asked: "${truncate(example.instruction, MAX_INSTRUCTION_CHARS)}"`,
      stepLines || '   (answered directly, no tools)',
      `   Result: ${truncate(example.final_response ?? '', MAX_INSTRUCTION_CHARS)}`
    ].join('\n')
  })

  return [
    '',
    'Learned examples — these are past tasks you completed successfully and the',
    'user was happy with. Follow the same tool sequence and reasoning style when a',
    'new request is similar:',
    '',
    blocks.join('\n\n')
  ].join('\n')
}

// ── JSONL export (fine-tuning-ready) ───────────────────────────────────────────

/**
 * Convert one stored trajectory into a single JSONL record in the standard chat
 * fine-tuning shape: a `messages` array of system/user/assistant/tool turns,
 * plus `quality`/`outcome` metadata a training pipeline can filter on.
 */
function trajectoryToJsonl(
  entry: ReturnType<typeof database.training.getExamplesForExport>[number]
): string {
  const { example, steps } = entry
  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: example.instruction }
  ]
  for (const step of steps) {
    if (step.reasoning) messages.push({ role: 'assistant', content: step.reasoning })
    if (step.tool_name) {
      messages.push({
        role: 'tool',
        content: `[${step.tool_name}] ${step.status ?? ''}: ${step.tool_result ?? ''}`.trim()
      })
    }
  }
  if (example.final_response) {
    messages.push({ role: 'assistant', content: example.final_response })
  }
  return JSON.stringify({
    messages,
    quality: example.quality_score,
    outcome: example.outcome,
    model: example.model,
    tier: example.tier
  })
}

export interface ExportResult {
  ok: boolean
  path?: string
  count?: number
  error?: string
}

/**
 * Write the dataset to a JSONL file. When `filePath` is omitted a save dialog is
 * shown. `minQuality` filters out low-rated turns (default 3 = neutral-or-better,
 * so failures the user complained about are excluded from training data).
 */
export async function exportDatasetToFile(
  filePath?: string,
  minQuality = 3
): Promise<ExportResult> {
  let rows: ReturnType<typeof database.training.getExamplesForExport>
  try {
    rows = database.training.getExamplesForExport(minQuality)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (rows.length === 0) {
    return { ok: false, error: 'No training examples recorded yet at this quality threshold.' }
  }

  let target = filePath
  if (!target) {
    const defaultName = `openui-training-${new Date().toISOString().slice(0, 10)}.jsonl`
    const result = await dialog.showSaveDialog({
      title: 'Export OpenUI training dataset',
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled.' }
    target = result.filePath
  }

  const jsonl = rows.map(trajectoryToJsonl).join('\n') + '\n'
  try {
    await writeFile(target, jsonl, 'utf8')
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: target, count: rows.length }
}
