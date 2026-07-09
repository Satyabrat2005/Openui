/**
 * evaluator.ts — held-out evaluation for local LoRA candidates.
 *
 * Before a fine-tuned checkpoint is promoted, it must NOT regress against the
 * currently active model on a held-out slice of the user's own trajectories.
 * The split is deterministic (every Nth record) so train and holdout never
 * overlap; scoring is whitespace-token F1 between the model's reply and the
 * recorded (user-approved) reply. Token F1 is a blunt instrument, but it is
 * honest, local, dependency-free, and symmetric across both models — good
 * enough to catch the failure mode that matters here (a candidate that got
 * WORSE at reproducing the user's known-good interactions).
 */
import type { ChatFinetuneRecord } from '../trainingStore'

// Cap eval cost: local generation is slow, and a mean over ~a dozen diverse
// prompts is plenty to detect a real regression.
const MAX_EVAL_EXAMPLES = 12
const EVAL_TIMEOUT_MS = 120_000
const MAX_PROMPT_MSGS = 12

export interface DatasetSplit {
  train: ChatFinetuneRecord[]
  holdout: ChatFinetuneRecord[]
}

/**
 * Deterministically split records into train/holdout: every `every`-th record
 * (by position) is held out, capped at MAX_EVAL_EXAMPLES. Records whose final
 * message is not an assistant turn can't be scored and always go to train.
 */
export function splitDataset(records: ChatFinetuneRecord[], every = 10): DatasetSplit {
  const train: ChatFinetuneRecord[] = []
  const holdout: ChatFinetuneRecord[] = []
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    const last = r.messages[r.messages.length - 1]
    const scorable = last?.role === 'assistant' && last.content.trim().length > 0
    if (scorable && i % every === every - 1 && holdout.length < MAX_EVAL_EXAMPLES) {
      holdout.push(r)
    } else {
      train.push(r)
    }
  }
  return { train, holdout }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Whitespace-token F1 between an expected and an actual reply, in [0, 1]. */
export function tokenF1(expected: string, actual: string): number {
  const exp = tokenize(expected)
  const act = tokenize(actual)
  if (exp.length === 0 || act.length === 0) return exp.length === act.length ? 1 : 0
  const counts = new Map<string, number>()
  for (const t of exp) counts.set(t, (counts.get(t) ?? 0) + 1)
  let overlap = 0
  for (const t of act) {
    const n = counts.get(t) ?? 0
    if (n > 0) {
      overlap++
      counts.set(t, n - 1)
    }
  }
  if (overlap === 0) return 0
  const precision = overlap / act.length
  const recall = overlap / exp.length
  return (2 * precision * recall) / (precision + recall)
}

/**
 * A candidate is promotable only when it does not regress against the baseline
 * on the held-out set. The small epsilon absorbs sampling noise; anything
 * below baseline−epsilon is a real regression and gets auto-rejected.
 */
export function isPromotable(candidateScore: number, baselineScore: number, epsilon = 0.02): boolean {
  return candidateScore >= baselineScore - epsilon
}

/** Ask one Ollama model to answer one held-out prompt (final turn removed). */
async function generateReply(
  ollamaUrl: string,
  model: string,
  record: ChatFinetuneRecord
): Promise<string> {
  // Everything before the final assistant turn is the prompt. Tool turns are
  // folded into user turns since /api/chat only accepts system/user/assistant.
  const prompt = record.messages
    .slice(0, -1)
    .slice(-MAX_PROMPT_MSGS)
    .map((m) => (m.role === 'assistant' ? m : { role: 'user', content: m.content }))
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: prompt, stream: false, options: { num_predict: 512 } }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Ollama /api/chat ${res.status} for ${model}`)
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}

/**
 * Mean token-F1 of `model` across the held-out records. Individual failures
 * score 0 (a model that errors on the user's real prompts IS worse) but a
 * fully failing run throws so the caller can distinguish "bad model" from
 * "Ollama is down".
 */
export async function evaluateModel(
  ollamaUrl: string,
  model: string,
  holdout: ChatFinetuneRecord[]
): Promise<number> {
  if (holdout.length === 0) throw new Error('evaluateModel: empty holdout set')
  let total = 0
  let failures = 0
  for (const record of holdout) {
    const expected = record.messages[record.messages.length - 1].content
    try {
      const actual = await generateReply(ollamaUrl, model, record)
      total += tokenF1(expected, actual)
    } catch {
      failures++
    }
  }
  if (failures === holdout.length) {
    throw new Error(`evaluateModel: all ${holdout.length} generations failed for ${model}`)
  }
  return total / holdout.length
}
