/**
 * cloudFreeTier.ts — cloud-first model access for EVERY tier (Phase A onboarding).
 *
 * The product promise: sign in and it works. No prerequisites, no local setup.
 * This module is how that promise is kept — it proxies chat through the
 * `chat-proxy` Supabase Edge Function, which holds OUR API keys server-side and
 * enforces a per-tier daily message limit against the `usage_tracking` table.
 *
 * The Electron app NEVER ships LLM API keys for the cloud path; it sends the
 * signed-in user's Supabase access token and the Edge Function does the rest.
 *
 * Ollama is an OPTIONAL enhancement, surfaced here only as `isOllamaRunning()`
 * (a 2-second probe) and `classifyTaskComplexity()` (so Pro can keep cheap work
 * local). If Ollama is absent, callers fall through to `callCloudProxy()` and the
 * user sees a working assistant — never an "install Ollama" error.
 *
 * No import from `agent.ts` at runtime (only the `Message` *type*, which is
 * erased) so there is no import cycle: `agent.ts` → `cloudFreeTier.ts` only.
 */
import type { BrowserWindow } from 'electron'
import type { Message } from './agent'
import type { Tier } from './tools'
import { getSupabaseClient, isSupabaseConfigured } from './auth/supabaseClient'
import { refreshSession } from './auth/sessionManager'
import { getCurrentUserId } from './stripe/subscriptionSync'
import { dailyMessageLimit } from './stripe/pricing'
import { database } from './database'
import { sendMessage as serverSendMessage } from './serverClient'

/** Payload pushed to the renderer so it can show "15/20 messages today". */
export interface UsageUpdate {
  tier: Tier
  /** Daily cloud-message cap, or null when unlimited (Enterprise / local AI). */
  limit: number | null
  /** Messages remaining today, or null when unlimited. */
  remaining: number | null
  /** True when this turn is not metered (Enterprise, or local Ollama). */
  unlimited: boolean
}

/** Send to the renderer, guarding a destroyed window (no dep on agent.ts). */
function send(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** Push a usage update so the renderer counter stays live. */
function emitUsage(win: BrowserWindow, usage: UsageUpdate): void {
  send(win, 'openui:usage-update', usage)
}

/**
 * Emit a usage update for a non-metered turn (local Ollama or the local-dev
 * direct-API fallback). Keeps the renderer counter consistent — it hides the
 * "N/M today" number when `unlimited` is true.
 */
export function emitLocalUsage(win: BrowserWindow, tier: Tier): void {
  emitUsage(win, { tier, limit: null, remaining: null, unlimited: true })
}

/**
 * Is a local Ollama server reachable right now? Called on every routed message;
 * a fast 2-second probe of the tags endpoint. Any failure (not installed, not
 * running, slow) resolves to `false` so the caller silently uses the cloud
 * proxy instead — the user never sees an Ollama error.
 */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
    const response = await fetch(`${host.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    })
    return response.ok
  } catch {
    return false
  }
}

/** True when we can route through the cloud proxy (configured + signed in). */
export function isCloudProxyConfigured(): boolean {
  return isSupabaseConfigured() && getCurrentUserId() !== null
}

/** Heuristic words that mark a request as "worth a premium cloud model". */
const COMPLEX_RE =
  /\b(refactor|architect|debug|analy[sz]e|investigat\w*|multi[- ]?step|plan|design|review|optimi[sz]e|migrat\w*|implement|complex|step[- ]by[- ]step|write|code|function|class|script|build|fix|test|file|read|list|run|terminal|bash|python|javascript|typescript|react|html|css|sql|api|endpoint|website|app|program)\b/i

/**
 * Cheap, synchronous classification of whether the latest user request looks
 * "complex" enough to deserve a cloud model on Pro (otherwise Pro keeps it local
 * on Ollama to save cost). Also used to detect coding/heavy tasks for free-tier
 * Ollama routing. Deliberately a heuristic — we never spend a model call just to
 * decide which model to call.
 */
export function classifyTaskComplexity(messages: Message[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (!lastUser) return false
  if (lastUser.content.length > 280) return true
  if (COMPLEX_RE.test(lastUser.content)) return true
  // Tool calls in history signal a complex, multi-step agentic workflow.
  if (messages.some((m) => m.content.trim().startsWith('{"tool":') || m.content.startsWith('TOOL RESULT'))) return true
  // Long, tool-heavy conversations are the ones that benefit from a stronger model.
  return messages.length > 6
}

/** Friendly daily-limit message — frames local AI as an option, never an error. */
function limitReachedMessage(tier: Tier): string {
  const upsell =
    tier === 'pro'
      ? 'Upgrade to Enterprise for unlimited messages'
      : 'Upgrade to Pro for more messages'
  return `You've reached your daily message limit. ${upsell}, or set up local AI for unlimited offline use.`
}

/** Resolve a usable access token, refreshing once if the cached one expired. */
async function getProxyAccessToken(userId: string): Promise<string | null> {
  const cached = database.users.getValidToken(userId)
  if (cached) return cached
  // Token at/just past expiry — try a single refresh before giving up.
  const refreshed = await refreshSession()
  return refreshed ? database.users.getValidToken(userId) : null
}

/** Push a usage update derived from the Edge Function's rate-limit headers. */
function emitUsageFromHeaders(win: BrowserWindow, tier: Tier, headers: Headers): void {
  const limitHeader = headers.get('x-ratelimit-limit')
  const remainingHeader = headers.get('x-ratelimit-remaining')
  const unlimited = !limitHeader || limitHeader === 'unlimited'
  emitUsage(win, {
    tier,
    limit: unlimited ? null : Number(limitHeader),
    remaining: !remainingHeader || remainingHeader === 'unlimited' ? null : Number(remainingHeader),
    unlimited
  })
}

/**
 * Stream one model turn through the cloud proxy and return the full text.
 *
 * Streaming contract: the Edge Function normalizes whichever provider it proxies
 * (Anthropic / OpenAI) into a uniform SSE of `data: {"delta":"…"}` lines closed
 * by `data: [DONE]`. We forward each delta to the renderer over the existing
 * `openui:chat:chunk` channel, identical to the local Ollama/Anthropic paths, so
 * the agentic loop in `agent.ts` is provider-agnostic.
 *
 * Rate limiting is NOT an error: a 429 becomes a friendly streamed message plus
 * an upgrade prompt, and the turn ends normally.
 */
export async function callCloudProxy(
  win: BrowserWindow,
  tier: Tier,
  messages: Message[],
  systemPrompt: string,
  modelKey: string,
  // Sink for every streamed token (and any user-facing notice). The interactive
  // agent loop passes a StreamGate here so tool-call JSON never reaches the UI;
  // defaults to a direct renderer push for other callers.
  onDelta: (delta: string) => void = (delta) => send(win, 'openui:chat:chunk', delta)
): Promise<string> {
  // Route through the new backend when configured; Supabase proxy is the fallback.
  if (process.env.VITE_SERVER_URL) {
    return serverSendMessage(win, tier, messages, systemPrompt, modelKey, onDelta)
  }

  const userId = getCurrentUserId()
  const baseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!userId || !baseUrl || !anonKey) {
    // Callers gate on isCloudProxyConfigured(); this is a defensive guard.
    throw new Error('Cloud AI is not configured. Please sign in to continue.')
  }

  const token = await getProxyAccessToken(userId)
  if (!token) {
    const msg = 'Your session has expired. Please sign in again to keep chatting.'
    onDelta(msg)
    return msg
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/chat-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        system: systemPrompt,
        modelKey,
        stream: true
      })
    })
  } catch {
    throw new Error('I could not reach the AI service. Please check your connection and try again.')
  }

  // Daily limit reached → upsell, not an error. Surface remaining=0 + upgrade modal.
  if (response.status === 429) {
    let limit = dailyMessageLimit(tier)
    try {
      const body = (await response.json()) as { limit?: unknown }
      if (typeof body.limit === 'number') limit = body.limit
    } catch {
      /* ignore malformed body — fall back to the configured tier limit */
    }
    emitUsage(win, { tier, limit: Number.isFinite(limit) ? limit : null, remaining: 0, unlimited: false })
    if (tier !== 'enterprise') {
      send(win, 'openui:tier-upgrade-needed', {
        requestedTier: tier === 'free' ? 'pro' : 'enterprise',
        effectiveTier: tier,
        currentTier: tier
      })
    }
    const msg = limitReachedMessage(tier)
    onDelta(msg)
    return msg
  }

  if (!response.ok || !response.body) {
    throw new Error('The AI service is temporarily unavailable. Please try again in a moment.')
  }

  // Live counter from the Edge Function's headers.
  emitUsageFromHeaders(win, tier, response.headers)

  // Parse the normalized SSE stream, forwarding each delta to the renderer.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Process complete lines; keep any trailing partial line in the buffer.
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data) as { delta?: unknown }
        const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        /* keepalive / partial frame — ignore */
      }
    }
  }

  return full
}
