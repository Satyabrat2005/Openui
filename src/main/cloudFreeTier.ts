/**
 * cloudFreeTier.ts — cloud-only model access for EVERY tier.
 *
 * The product promise: sign in and it works. No prerequisites, no local setup —
 * and, just as importantly, no way to escape the metered limits. This module
 * proxies every chat turn through the `chat-proxy` Supabase Edge Function, which
 * holds OUR API keys server-side and enforces a per-tier daily message limit
 * against the `usage_tracking` table. There is no local-model fallback anywhere
 * in this file: a user cannot install anything to bypass the cap.
 *
 * The Electron app NEVER ships LLM API keys for the cloud path; it sends the
 * signed-in user's Supabase access token and the Edge Function does the rest.
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

/**
 * Thrown when the cloud `chat-proxy` Edge Function answers with a non-OK status
 * that is NOT a rate-limit (429 is handled as a friendly upsell, not an error).
 *
 * Carries the HTTP `status` and the function's `code` (e.g. `llm_error`,
 * `invalid_token`, `internal_error`) so the caller can (a) log exactly WHY the
 * proxy failed and (b) decide whether to fall back to a local model. The most
 * common cause is `502 llm_error`: the server-side ANTHROPIC_API_KEY / OPENAI_API_KEY
 * secret is missing, invalid, or its account is out of credit.
 */
export class CloudProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'CloudProxyError'
  }
}

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
 * Emit a usage update for a non-metered turn. Used only by the local-dev direct
 * API-key escape hatch in `agent.ts` (no Supabase configured — never reachable
 * by a real, shipped, signed-in user). Keeps the renderer counter consistent —
 * it hides the "N/M today" number when `unlimited` is true.
 */
export function emitLocalUsage(win: BrowserWindow, tier: Tier): void {
  emitUsage(win, { tier, limit: null, remaining: null, unlimited: true })
}

/** True when we can route through the cloud proxy (configured + signed in). */
export function isCloudProxyConfigured(): boolean {
  return isSupabaseConfigured() && getCurrentUserId() !== null
}

/** Friendly daily-limit message — upsell, never an error. */
function limitReachedMessage(tier: Tier): string {
  const upsell =
    tier === 'pro'
      ? 'Upgrade to Enterprise for unlimited messages'
      : 'Upgrade to Pro for more messages'
  return `You've reached your daily message limit. ${upsell}.`
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
    // Read the Edge Function's error code so the failure is DIAGNOSABLE in logs
    // instead of a vague "temporarily unavailable" — 502 `llm_error` means the
    // server-side ANTHROPIC_API_KEY/OPENAI_API_KEY is missing/invalid/out of
    // credit; 401 means the user's token was rejected; 500 means the function
    // crashed. Thrown as a typed CloudProxyError so the agent router can fall
    // back to a local model (Ollama / direct key) and keep the user working.
    let code: string | undefined
    try {
      const body = (await response.clone().json()) as { error?: unknown }
      if (typeof body.error === 'string') code = body.error
    } catch {
      /* non-JSON error body — leave code undefined */
    }
    console.error(
      `[cloudFreeTier] chat-proxy failed: HTTP ${response.status}` +
        (code ? ` (${code})` : '') +
        (response.status === 502
          ? ' — the server-side LLM API key is likely missing/invalid or out of credit. ' +
            'Set it with: supabase secrets set ANTHROPIC_API_KEY=... && supabase functions deploy chat-proxy'
          : '')
    )
    throw new CloudProxyError(
      'The AI service is temporarily unavailable. Please try again in a moment.',
      response.status,
      code
    )
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
