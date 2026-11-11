/**
 * edgeFunctions.ts — shared client for calling authenticated Supabase Edge
 * Functions from the Electron MAIN process.
 *
 * WHY THIS EXISTS: OUR server-side secrets (the LLM keys, the OpenAI Whisper/TTS
 * key, the ElevenLabs key) live ONLY in the Edge Functions, never in the shipped
 * client — exactly like `chat-proxy` already does for chat. Every feature that
 * needs one of those secrets (voice, cloud vision / read_screen, the AI
 * interviewer, Figma design review) must therefore reach the key by sending the
 * signed-in user's Supabase access token to a function that holds it and returns
 * the result. This module centralises resolving that token + building the
 * function URL so each feature doesn't re-implement (and drift from) the pattern.
 *
 * It deliberately mirrors the fetch/auth shape used by `cloudFreeTier.ts` (the
 * chat path); chat keeps its own streaming client because it needs SSE, but the
 * request contract — `apikey` + `Authorization: Bearer <token>` — is identical.
 */
import { refreshSession } from './auth/sessionManager'
import { getCurrentUserId } from './stripe/subscriptionSync'
import { database } from './database'

/**
 * Thrown when we cannot even reach an Edge Function with a valid identity —
 * Supabase isn't configured, nobody is signed in, the session can't be
 * refreshed, or the network is down. Carries an HTTP-ish `status` (0 = local /
 * pre-request failure) and, when the function itself answered, its error `code`.
 */
export class EdgeFunctionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'EdgeFunctionError'
  }
}

/** Resolve a usable access token, refreshing once if the cached one expired. */
async function getAccessToken(userId: string): Promise<string | null> {
  const cached = database.users.getValidToken(userId)
  if (cached) return cached
  // Token at/just past expiry — try a single refresh before giving up.
  const refreshed = await refreshSession()
  return refreshed ? database.users.getValidToken(userId) : null
}

/** True when the cloud path is reachable (Supabase configured + signed in). */
export function isEdgeFunctionConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && getCurrentUserId())
}

/**
 * POST `body` as JSON to the named Edge Function with the signed-in user's
 * Supabase token. Returns the raw `Response` so callers can parse JSON, read
 * binary, or stream as they need. Throws `EdgeFunctionError` only for problems
 * that happen BEFORE we get an HTTP answer (no auth / no network); a non-OK HTTP
 * status is returned to the caller to interpret.
 */
/** Every edge call returns one JSON body (none streams); a minute covers a long cloud reply or transcription. */
export const EDGE_TIMEOUT_MS = 60_000

export async function callEdgeFunction(name: string, body: unknown): Promise<Response> {
  const userId = getCurrentUserId()
  const baseUrl = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!userId || !baseUrl || !anonKey) {
    throw new EdgeFunctionError(
      'Cloud services are not configured. Please sign in to continue.',
      0,
      'not_configured'
    )
  }

  const token = await getAccessToken(userId)
  if (!token) {
    throw new EdgeFunctionError(
      'Your session has expired. Please sign in again to continue.',
      401,
      'session_expired'
    )
  }

  try {
    return await fetch(`${baseUrl.replace(/\/$/, '')}/functions/v1/${name}`, {
      // Without a limit, a network that hangs instead of failing left the
      // Splen download on "starting download" for minutes.
      signal: AbortSignal.timeout(EDGE_TIMEOUT_MS),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    })
  } catch {
    throw new EdgeFunctionError(
      'Could not reach the cloud service. Check your connection and try again.',
      0,
      'network_error'
    )
  }
}

/** Parse a JSON body, tolerating an empty or non-JSON response. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** A single message for the chat-proxy. `content` is a string OR, for vision, an
 *  Anthropic-style content-block array (e.g. `[{type:'image',…},{type:'text',…}]`). */
export interface ProxyMessage {
  role: 'user' | 'assistant'
  content: unknown
}

/**
 * Run ONE non-streaming model turn through the `chat-proxy` Edge Function and
 * return the assistant's text.
 *
 * This is the reuse the audit calls for: `chat-proxy` already verifies the JWT,
 * resolves the authoritative tier, gates the model, and — crucially — holds OUR
 * Anthropic key server-side. The vision (`read_screen`), Figma design-review,
 * and AI-interviewer features all route their Claude calls through here instead
 * of `new Anthropic({ apiKey: process.env.… })`, so no LLM key ever needs to
 * reach a shipped client. `chat-proxy` accepts Anthropic-style image blocks, so
 * the vision callers pass an image + text content array unchanged.
 *
 * Throws `EdgeFunctionError` on auth/limit/upstream failure so callers can
 * surface a single friendly message.
 */
export async function callChatProxyText(opts: {
  messages: ProxyMessage[]
  system?: string
  /** Tier-scoped model hint; chat-proxy clamps it to the user's entitlement. */
  modelKey?: string
}): Promise<string> {
  const response = await callEdgeFunction('chat-proxy', {
    messages: opts.messages,
    ...(opts.system ? { system: opts.system } : {}),
    ...(opts.modelKey ? { modelKey: opts.modelKey } : {}),
    stream: false
  })

  if (response.status === 429) {
    throw new EdgeFunctionError(
      "You've reached your daily usage limit. Upgrade your plan or try again tomorrow.",
      429,
      'rate_limited'
    )
  }
  if (!response.ok) {
    const body = await readJson(response)
    const code = typeof body.error === 'string' ? body.error : undefined
    throw new EdgeFunctionError(
      'The AI service is temporarily unavailable. Please try again in a moment.',
      response.status,
      code
    )
  }

  return extractAssistantText(await readJson(response))
}

/**
 * Pull the assistant's text out of a completion body. `chat-proxy` returns the
 * provider JSON unchanged for non-streaming requests, so handle both the
 * Anthropic (`content: [{type:'text',text}]`) and OpenAI
 * (`choices:[{message:{content}}]`) shapes.
 */
function extractAssistantText(data: Record<string, unknown>): string {
  const content = data.content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string'
      )
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  const choices = data.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as { message?: { content?: unknown } }).message
    if (msg && typeof msg.content === 'string') return msg.content.trim()
  }

  return ''
}
