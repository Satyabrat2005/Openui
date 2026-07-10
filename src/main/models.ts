/**
 * Real model-pool detection and per-model dispatch.
 *
 * The interactive chat loop (agent.ts) routes by *tier*. Parallel subagents,
 * however, each run on a SPECIFIC model so the UI can show a truthful per-agent
 * model tag. This module answers two questions the rest of the app can't:
 *
 *   1. Which models does this machine ACTUALLY have? (installed Ollama models,
 *      plus the tier cloud model when a key is configured)
 *   2. Given one of those models, run a turn on it and return the text.
 *
 * Honesty contract: the pool only ever contains models we can genuinely call.
 * We never invent a model name for the UI — if only one model is installed,
 * every subagent shows that same model (and still runs truly in parallel).
 */
import { Ollama } from 'ollama'
import Anthropic from '@anthropic-ai/sdk'

/** A minimal chat message — kept local so this module has no cycle with agent.ts. */
export interface ModelMessage {
  role: 'user' | 'assistant'
  content: string
}

export type ModelProvider = 'ollama' | 'anthropic'

export interface AvailableModel {
  /** The exact id passed to the provider (e.g. "llama3:8b", "claude-sonnet-4-6"). */
  id: string
  /** Human-friendly label for the UI tag (e.g. "Llama 3 8B"). */
  label: string
  provider: ModelProvider
}

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const POOL_CACHE_MS = 30_000

/**
 * Preferred tags. These are only ever a *starting point* — `resolveOllamaModel`
 * maps them onto a model this machine really has, so a preference that was never
 * pulled (or a tag that does not exist in the registry) can't take the app down.
 */
export const DEFAULT_GENERAL_MODEL = 'qwen3.5:latest'
export const DEFAULT_CODE_MODEL = 'qwen2.5-coder:7b'

let poolCache: { at: number; models: AvailableModel[] } | null = null

/** Turn "llama3:8b" → "Llama 3 8B", "qwen2.5:latest" → "Qwen 2.5". */
function prettifyOllama(name: string): string {
  const base = name.split(':')[0]
  const spaced = base.replace(/([a-z])(\d)/gi, '$1 $2').replace(/[-_]/g, ' ')
  const tag = name.includes(':') ? name.split(':')[1] : ''
  const size = tag && tag !== 'latest' ? ` ${tag.toUpperCase()}` : ''
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase()) + size
}

/**
 * Discover the real model pool available on this machine. Best-effort and
 * cached briefly: an unreachable Ollama server just yields fewer models rather
 * than throwing. Never returns fabricated entries.
 */
export async function getAvailableModels(): Promise<AvailableModel[]> {
  if (poolCache && Date.now() - poolCache.at < POOL_CACHE_MS) return poolCache.models

  const models: AvailableModel[] = []
  try {
    const ollama = new Ollama({ host: OLLAMA_HOST })
    const list = await ollama.list()
    for (const m of list.models ?? []) {
      if (m.name) models.push({ id: m.name, label: prettifyOllama(m.name), provider: 'ollama' })
    }
  } catch {
    // Ollama not running — fall through; the pool may still get a cloud entry.
  }

  // Only advertise a cloud model when a key is genuinely present, so the UI tag
  // reflects a model we can actually call.
  if (process.env.ANTHROPIC_API_KEY) {
    models.push({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' })
  }

  poolCache = { at: Date.now(), models }
  return models
}

/**
 * Map a *preferred* Ollama tag onto one this machine actually has.
 *
 * Hardcoding a tag is how the app used to die at the first token with
 * `model 'qwen3.5:9b' not found`: npm-installed defaults drift from whatever the
 * user really pulled. Resolution order:
 *
 *   1. the preference, if it is installed verbatim;
 *   2. any installed tag from the same family ("qwen3.5:9b" → "qwen3.5:latest");
 *   3. for a code preference, any installed model that looks code-tuned;
 *   4. the first installed model — one that works beats one that doesn't exist.
 *
 * When nothing is installed (or Ollama is unreachable) we hand the preference
 * back untouched, so callers keep their existing "is Ollama running?" error path
 * instead of getting a confusing message from here.
 */
export async function resolveOllamaModel(preferred: string): Promise<string> {
  const installed = (await getAvailableModels())
    .filter((m) => m.provider === 'ollama')
    .map((m) => m.id)
  if (installed.length === 0) return preferred
  if (installed.includes(preferred)) return preferred

  const base = preferred.split(':')[0]
  const sameFamily = installed.find((id) => id.split(':')[0] === base)
  const coder = base.includes('coder') ? installed.find((id) => id.includes('coder')) : undefined
  const chosen = sameFamily ?? coder ?? installed[0]

  // Substituting silently would make the UI's model tag a lie and leave the user
  // wondering why output changed, so say so once per resolution.
  console.warn(
    `[models] Ollama model "${preferred}" is not installed; using "${chosen}" instead. ` +
      `Run \`ollama pull ${preferred}\` to use the preferred model.`
  )
  return chosen
}

/**
 * The general-purpose local model. OLLAMA_MODEL states a *preference*, not a
 * guarantee — it is resolved against the installed set like any other, because a
 * configured-but-never-pulled tag is precisely what used to kill every turn.
 * Shared by the chat router (agent.ts) and the weekly prompt refiner so the two
 * can never disagree about which model ran.
 */
export async function resolveGeneralModel(): Promise<string> {
  return resolveOllamaModel(process.env.OLLAMA_MODEL ?? DEFAULT_GENERAL_MODEL)
}

/**
 * Assign `count` models to subagents from the real pool, round-robin. When the
 * pool has fewer models than subagents (the common single-model case), models
 * repeat — every agent still runs concurrently on a genuine model. Returns a
 * safe single-element fallback if the pool is somehow empty.
 */
export function assignModels(pool: AvailableModel[], count: number): AvailableModel[] {
  if (pool.length === 0) {
    const fallbackId = process.env.OLLAMA_MODEL ?? DEFAULT_GENERAL_MODEL
    const fallback: AvailableModel = { id: fallbackId, label: prettifyOllama(fallbackId), provider: 'ollama' }
    return Array.from({ length: count }, () => fallback)
  }
  return Array.from({ length: count }, (_, i) => pool[i % pool.length])
}

/**
 * Run a single non-interactive turn on one specific model and return the full
 * text. Unlike agent.ts's `callModel`, this targets an explicit model (not a
 * tier) and does NOT stream to the renderer — subagents run silently and report
 * via subagent:* events, so several can run at once without garbling the chat.
 */
export async function callModelById(
  model: AvailableModel,
  messages: ModelMessage[],
  systemPrompt: string
): Promise<string> {
  if (model.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const res = await client.messages.create({
      model: model.id,
      max_tokens: 1536,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    })
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
  }

  // Ollama (default).
  const ollama = new Ollama({ host: OLLAMA_HOST })
  const res = await ollama.chat({
    model: model.id,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    stream: false
  })
  return res.message?.content ?? ''
}
