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
import { database } from './database'

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

/**
 * The frontier cloud model used when the user opts into cloud routing AND has an
 * Anthropic key configured (bring-your-own-key). Opus 4.8 is Anthropic's current
 * flagship; override per install with the `cloud_model` setting or the
 * ANTHROPIC_MODEL env var. Local Ollama remains the default and the offline /
 * privacy tier — cloud is strictly opt-in (see shouldRouteToCloud).
 */
export const DEFAULT_CLOUD_MODEL = 'claude-opus-4-8'

let poolCache: { at: number; models: AvailableModel[] } | null = null

/** Turn "claude-opus-4-8" → "Claude Opus 4.8" for the UI model tag. */
function prettifyCloud(id: string): string {
  // Fold a trailing "-<major>-<minor>" into a dotted version before spacing.
  const dotted = id.replace(/-(\d+)-(\d+)$/, ' $1.$2')
  return dotted.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

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

  // Only advertise a cloud model when the tier is enabled for this build AND a key
  // is genuinely present (env OR the Settings value), so the UI tag reflects a
  // model we can actually call. The id and label track resolveCloudModel, so
  // overriding the model updates the tag. With the launch switch off (default),
  // the pool is Ollama-only.
  if (isCloudTierEnabled() && getAnthropicKey()) {
    const id = resolveCloudModel()
    models.push({ id, label: prettifyCloud(id), provider: 'anthropic' })
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

// ── cloud (Anthropic) tier — bring-your-own-key ──────────────────────────────
//
// OpenUI is local-first: chat, planning and the coding agent all run on Ollama
// by default, with no per-message metering and nothing leaving the machine. The
// cloud tier is an OPT-IN escape hatch for users who want frontier capability
// and supply their own Anthropic key — the harness (tools, verify loop, desktop
// reach) is the product; the model is a swappable component. Two independent
// facts gate it: a key must exist, AND the user must have flipped the routing
// toggle on. Either alone routes nowhere near the cloud.
//
// LAUNCH SWITCH: the whole tier sits behind isCloudTierEnabled(), OFF by default,
// so the shipped app is Ollama-only — no API key, no cloud routing, no billing.
// This is deliberate for the initial launch (self-hosted on the user's own Ollama
// server). Set OPENUI_ENABLE_CLOUD=1 to bring the BYOK tier back with zero code
// changes; the renderer mirrors the same switch in SettingsModal.tsx.
//
// Key resolution mirrors github.ts's getToken(): env first (dev-only override),
// then the value pasted into Settings.

/**
 * Master switch for the entire bring-your-own-key cloud tier. OFF unless
 * OPENUI_ENABLE_CLOUD=1, so by default nothing about the cloud path is reachable:
 * shouldRouteToCloud() is always false and getAvailableModels() never advertises
 * a cloud model. Kept as an env flag (not a deletion) so the tier — built and
 * reviewed under PR #107 — can be re-enabled for a future release without a code
 * change. Read at call time, like the other predicates here.
 */
export function isCloudTierEnabled(): boolean {
  return process.env.OPENUI_ENABLE_CLOUD === '1'
}

/** Resolved Anthropic API key: ANTHROPIC_API_KEY env, else the Settings value, else null. */
export function getAnthropicKey(): string | null {
  const env = process.env.ANTHROPIC_API_KEY?.trim()
  if (env) return env
  try {
    const stored: unknown = database.settings.getSetting('anthropic_api_key')
    return typeof stored === 'string' && stored.trim() ? stored.trim() : null
  } catch {
    return null
  }
}

/** The cloud model id: ANTHROPIC_MODEL env, else the `cloud_model` setting, else the flagship default. */
export function resolveCloudModel(): string {
  const env = process.env.ANTHROPIC_MODEL?.trim()
  if (env) return env
  try {
    const stored: unknown = database.settings.getSetting('cloud_model')
    if (typeof stored === 'string' && stored.trim()) return stored.trim()
  } catch {
    // fall through to the default
  }
  return DEFAULT_CLOUD_MODEL
}

/**
 * The user's cloud-routing preference. Off unless explicitly set to true — a
 * privacy-first default, so simply installing the app never sends a byte to a
 * cloud provider. Distinct from key presence: this is intent, getAnthropicKey is
 * capability.
 */
export function isCloudRoutingEnabled(): boolean {
  try {
    return database.settings.getSetting('cloud_routing_enabled') === true
  } catch {
    return false
  }
}

/**
 * True only when the cloud tier is enabled for this build (launch switch, off by
 * default) AND the user turned routing on AND a key is actually configured. All
 * three are required, so the shipped Ollama-only app never routes a turn off the
 * machine no matter what settings say.
 */
export function shouldRouteToCloud(): boolean {
  return isCloudTierEnabled() && isCloudRoutingEnabled() && getAnthropicKey() !== null
}

/** Longest single response we'll request from the cloud model (bounds BYOK cost per turn). */
const CLOUD_MAX_TOKENS = 8192

/**
 * Stream a turn from the Anthropic model and return the full text. Deltas are
 * forwarded through `onDelta` so the renderer streams cloud output exactly like
 * local output. Deliberately minimal: this app drives the model with a TEXT
 * tool-call protocol (see toolCallParser.ts), not native tool use, so a plain
 * system + messages request is all it needs — no `tools`, no `thinking`. Throws
 * on any API/auth error so the caller can fall back to local.
 */
export async function streamAnthropic(
  messages: ModelMessage[],
  systemPrompt: string,
  onDelta: (delta: string) => void,
  model: string = resolveCloudModel(),
  maxTokens: number = CLOUD_MAX_TOKENS
): Promise<string> {
  const apiKey = getAnthropicKey()
  if (!apiKey) throw new Error('No Anthropic API key is configured.')

  const client = new Anthropic({ apiKey })
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content }))
  })

  let full = ''
  stream.on('text', (delta) => {
    full += delta
    onDelta(delta)
  })
  // finalMessage() resolves on completion and rejects on API/auth errors; it also
  // handles abort/error wiring internally, so we don't hand-roll a Promise here.
  await stream.finalMessage()
  return full
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
    const apiKey = getAnthropicKey()
    if (!apiKey) throw new Error('No Anthropic API key is configured.')
    const client = new Anthropic({ apiKey })
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
    // Qwen3 (our default family) ships with "thinking" on, which emits a long
    // <think> reasoning block before the answer — slow, and noise the tool-call
    // parser has to wade through. We drive the reasoning ourselves, so turn it
    // off for direct answers. Ignored by models that don't support thinking.
    think: false,
    stream: false
  })
  return res.message?.content ?? ''
}
