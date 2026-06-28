/**
 * promptRefiner.ts — OpenUI's weekly, fully-local self-improvement job.
 *
 * Every Sunday at midnight (local time) this reads the past week's *failing*
 * turns from `conversation_feedback` (implicit_rating ≤ 2 or an explicit 👎),
 * clusters the failing user messages by keyword, and asks a model to rewrite the
 * assistant's system prompt to handle those cases better. The improved prompt is
 * saved under the `custom_system_prompt` setting and picked up by agent.ts on the
 * next turn — so responses genuinely get better over time without any fine-tuning
 * or external ML infrastructure.
 *
 * Privacy: the refinement runs against whichever model is reachable LOCALLY
 * first — a running Ollama keeps everything on-device. Only when no local model
 * is available does it fall back to a direct Anthropic call (dev/self-hosted with
 * an ANTHROPIC_API_KEY); with neither available the job skips quietly. Nothing is
 * ever uploaded to OpenUI's own servers.
 */
import type { BrowserWindow } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { Ollama } from 'ollama'
import { database } from './database'
import { buildDefaultSystemPrompt } from './agent'
import {
  SETTINGS,
  isImprovementEnabled,
  setCustomSystemPrompt
} from './improvement'
import { isOllamaRunning } from './cloudFreeTier'
import { trackEvent } from './telemetry/posthog'
import { Events } from './telemetry/events'

/** Model used for the cloud fallback path (matches the project's Sonnet usage). */
const REFINER_MODEL = 'claude-3-5-sonnet-latest'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const WEEK_SECONDS = 7 * 24 * 60 * 60

/** Cap how many failing examples we feed the model, to bound prompt size/cost. */
const MAX_EXAMPLES = 40
/** Cap examples shown per topic cluster. */
const MAX_EXAMPLES_PER_TOPIC = 8

export interface RefineResult {
  refined: boolean
  reason?: string
  failingCount?: number
  clusters?: number
}

// ── Keyword clustering (deliberately simple — no ML) ──────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'have', 'has',
  'can', 'could', 'would', 'should', 'please', 'what', 'when', 'where', 'which',
  'how', 'why', 'will', 'are', 'was', 'were', 'into', 'from', 'about', 'just',
  'want', 'need', 'make', 'made', 'does', 'did', 'not', 'but', 'all', 'any',
  'get', 'got', 'let', 'put', 'use', 'using', 'now', 'then', 'than', 'them',
  'they', 'there', 'here', 'out', 'off', 'too', 'some', 'more', 'most', 'app',
  'open', 'openui', 'help', 'thing', 'something', 'anything'
])

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) ?? []).filter(
    (w) => w.length >= 4 && !STOPWORDS.has(w)
  )
}

export interface TopicCluster {
  topic: string
  examples: string[]
}

/**
 * Group failing user messages by their single most salient shared keyword.
 * A keyword must appear in ≥2 messages to anchor a cluster; messages with no
 * shared keyword fall into a single "other" bucket. Returns clusters ordered
 * largest-first so the most common failure modes lead the prompt.
 */
export function clusterMessages(messages: string[]): TopicCluster[] {
  // Global document frequency for every candidate keyword.
  const docFreq = new Map<string, number>()
  const perMessageTokens = messages.map((m) => {
    const unique = new Set(tokenize(m))
    for (const tok of unique) docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1)
    return unique
  })

  const buckets = new Map<string, string[]>()
  messages.forEach((msg, i) => {
    let topic = 'other'
    let best = 1 // require docFreq ≥ 2 to anchor a cluster
    for (const tok of perMessageTokens[i]) {
      const freq = docFreq.get(tok) ?? 0
      if (freq > best) {
        best = freq
        topic = tok
      }
    }
    const list = buckets.get(topic) ?? []
    if (list.length < MAX_EXAMPLES_PER_TOPIC) list.push(msg.trim())
    buckets.set(topic, list)
  })

  return [...buckets.entries()]
    .map(([topic, examples]) => ({ topic, examples }))
    .sort((a, b) => b.examples.length - a.examples.length)
}

// ── Model call (local-first, non-streaming) ───────────────────────────────────

/**
 * Generate the improved prompt without streaming to any renderer. Prefers a
 * local Ollama model (keeps data on-device), then a direct Anthropic call when a
 * key is configured. Returns null when no model is reachable.
 */
async function generateRefinement(system: string, user: string): Promise<string | null> {
  // 1) Local Ollama — on-device, matches the "improvement happens locally" promise.
  if (await isOllamaRunning()) {
    try {
      const ollama = new Ollama({ host: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434' })
      const res = await ollama.chat({
        model: process.env.OLLAMA_MODEL ?? 'llama3:8b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: false
      })
      const text = res.message?.content?.trim()
      if (text) return text
    } catch (err) {
      console.error('[promptRefiner] Ollama refinement failed, trying cloud:', err)
    }
  }

  // 2) Direct Anthropic (dev / self-hosted with a key present).
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const res = await client.messages.create({
        model: REFINER_MODEL,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: user }]
      })
      const text = res.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim()
      if (text) return text
    } catch (err) {
      console.error('[promptRefiner] Anthropic refinement failed:', err)
    }
  }

  return null
}

const REFINER_SYSTEM_PROMPT =
  'You are an expert prompt engineer improving the system prompt of a desktop AI ' +
  'assistant based on real cases where it gave poor responses. You make targeted, ' +
  'conservative edits that fix the failure modes without changing the assistant\'s ' +
  'core behaviour or removing capabilities. You always return ONLY the complete ' +
  'improved system prompt, with no preamble, commentary, or code fences.'

function buildRefinerUserPrompt(clusters: TopicCluster[], basePrompt: string): string {
  const grouped = clusters
    .map((c) => {
      const heading = c.topic === 'other' ? 'Miscellaneous' : `Topic: "${c.topic}"`
      const items = c.examples.map((e) => `  - ${e.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
      return `${heading} (${c.examples.length}):\n${items}`
    })
    .join('\n\n')

  return [
    'Here are recent user messages where the assistant gave a response the user',
    'was unhappy with, grouped by topic:',
    '',
    grouped,
    '',
    'Current system prompt:',
    '"""',
    basePrompt,
    '"""',
    '',
    'Suggest 3 specific improvements to the system prompt that would help the',
    'assistant handle these cases better, and apply them directly. Important rules:',
    '- Keep the "Available tools" section and every tool name EXACTLY as given —',
    '  only improve the guidance, workflows, and instructions around them.',
    '- Do not remove existing capabilities or workflows.',
    '- Keep the overall structure and length similar.',
    '',
    'Return ONLY the complete improved system prompt — no explanation, no preamble,',
    'no markdown code fences.'
  ].join('\n')
}

/**
 * Sanity-check a model-produced prompt before we trust it as the live system
 * prompt. Guards against truncated/garbage output replacing a working prompt.
 */
function isPlausiblePrompt(candidate: string, basePrompt: string): boolean {
  const text = candidate.trim()
  if (text.length < 200) return false
  if (text.length > basePrompt.length * 2.5) return false
  // Must still look like OpenUI's prompt and retain the tool listing.
  if (!/openui/i.test(text)) return false
  if (!/available tools/i.test(text)) return false
  return true
}

// ── The job ──────────────────────────────────────────────────────────────────

/**
 * Run one refinement pass now. Safe to call manually (e.g. from an IPC dev hook).
 * Returns a structured result describing what happened; never throws.
 */
export async function refineSystemPromptNow(): Promise<RefineResult> {
  if (!isImprovementEnabled()) {
    trackEvent(Events.PROMPT_REFINE_SKIPPED, { reason: 'disabled' })
    return { refined: false, reason: 'disabled' }
  }

  let failing: ReturnType<typeof database.feedback.getFailingTurnsSince>
  try {
    const sinceTs = Math.floor(Date.now() / 1000) - WEEK_SECONDS
    failing = database.feedback.getFailingTurnsSince(sinceTs)
  } catch (err) {
    console.error('[promptRefiner] failed to read feedback:', err)
    return { refined: false, reason: 'db_error' }
  }

  // Need a meaningful number of failures before rewriting the prompt — otherwise
  // we'd churn the prompt on noise.
  const MIN_FAILURES = 3
  if (failing.length < MIN_FAILURES) {
    trackEvent(Events.PROMPT_REFINE_SKIPPED, { reason: 'insufficient_data' })
    markRan()
    return { refined: false, reason: 'insufficient_data', failingCount: failing.length }
  }

  const messages = failing
    .map((f) => (f.user_message ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_EXAMPLES)
  const clusters = clusterMessages(messages)

  const basePrompt = buildDefaultSystemPrompt()
  const userPrompt = buildRefinerUserPrompt(clusters, basePrompt)

  let candidate: string | null
  try {
    candidate = await generateRefinement(REFINER_SYSTEM_PROMPT, userPrompt)
  } catch (err) {
    console.error('[promptRefiner] refinement model call failed:', err)
    candidate = null
  }

  if (!candidate) {
    trackEvent(Events.PROMPT_REFINE_SKIPPED, { reason: 'no_model' })
    return { refined: false, reason: 'no_model', failingCount: failing.length }
  }

  // Strip accidental code fences the model may add despite instructions.
  const cleaned = candidate.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()

  if (!isPlausiblePrompt(cleaned, basePrompt)) {
    console.warn('[promptRefiner] refined prompt failed sanity check; keeping current prompt.')
    trackEvent(Events.PROMPT_REFINE_SKIPPED, { reason: 'failed_validation' })
    markRan()
    return { refined: false, reason: 'failed_validation', failingCount: failing.length }
  }

  try {
    setCustomSystemPrompt(cleaned)
    markRan()
  } catch (err) {
    console.error('[promptRefiner] failed to save refined prompt:', err)
    return { refined: false, reason: 'save_error' }
  }

  console.log(
    `[promptRefiner] system prompt refined from ${failing.length} failing turn(s) across ${clusters.length} topic(s).`
  )
  trackEvent(Events.PROMPT_REFINED, {
    failing_count: failing.length,
    clusters: clusters.length,
    model: REFINER_MODEL
  })
  return { refined: true, failingCount: failing.length, clusters: clusters.length }
}

function markRan(): void {
  try {
    database.settings.setSetting(SETTINGS.LAST_REFINE_AT, Math.floor(Date.now() / 1000))
  } catch {
    /* non-fatal */
  }
}

function lastRanMs(): number {
  try {
    const v = database.settings.getSetting(SETTINGS.LAST_REFINE_AT)
    return typeof v === 'number' ? v * 1000 : 0
  } catch {
    return 0
  }
}

/** Milliseconds from `now` until the next Sunday 00:00 local time. */
function msUntilNextSundayMidnight(now = new Date()): number {
  const next = new Date(now)
  next.setHours(0, 0, 0, 0)
  // Days until Sunday (getDay(): 0 = Sunday). If today is Sunday, jump a week.
  const daysUntilSunday = (7 - now.getDay()) % 7 || 7
  next.setDate(next.getDate() + daysUntilSunday)
  return next.getTime() - now.getTime()
}

let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Start the weekly refinement scheduler. Fires every Sunday at midnight. Also
 * performs a one-time catch-up shortly after launch if more than a week has
 * elapsed since the last run (so a machine that's asleep every Sunday still
 * improves). `win` is currently unused but accepted for future "OpenUI improved
 * itself" toasts. Idempotent — a second call replaces the existing schedule.
 */
export function startPromptRefiner(_win?: BrowserWindow): void {
  if (timer) clearTimeout(timer)

  // Catch-up: if we've never run, or it's been over a week, run a minute after
  // startup so we don't block launch.
  const since = lastRanMs()
  if (since === 0 || Date.now() - since > WEEK_MS) {
    setTimeout(() => {
      void refineSystemPromptNow()
    }, 60_000)
  }

  const schedule = (): void => {
    const delay = msUntilNextSundayMidnight()
    timer = setTimeout(() => {
      void refineSystemPromptNow().finally(schedule)
    }, delay)
    // Don't keep the event loop (or app quit) waiting on this timer.
    if (typeof timer.unref === 'function') timer.unref()
    console.log(`[promptRefiner] next refinement scheduled in ${Math.round(delay / 3_600_000)}h.`)
  }
  schedule()
}

/** Stop the scheduler (used on shutdown / tests). */
export function stopPromptRefiner(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
