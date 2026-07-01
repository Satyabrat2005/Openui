// chat-proxy — Supabase Edge Function (Deno runtime).
//
// The cloud-first heart of the onboarding flow: it lets EVERY tier (including
// Free) use AI the moment the user signs in, with zero local setup. OUR LLM API
// keys live here (server-side) and never ship in the Electron app.
//
// Flow:
//   1. Verify the caller's Supabase access token → resolve the user.
//   2. Resolve the user's tier from app_metadata.tier (authoritative; written by
//      the Stripe webhook). The client-sent modelKey is gated to this tier.
//   3. Enforce the per-tier daily message limit against `usage_tracking`.
//      Over the limit → 429 (the app turns this into a friendly upsell, not an error).
//   4. Proxy the request to Anthropic / OpenAI and, when streaming, normalize the
//      provider SSE into a uniform `data: {"delta":"…"}` … `data: [DONE]` stream
//      so the Electron client is provider-agnostic.
//   5. Increment today's usage count and return rate-limit headers the app reads
//      to show "15/20 messages today".
//
// Deploy:  supabase functions deploy chat-proxy
// Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY
//          (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

type Tier = 'free' | 'pro' | 'enterprise'
type Provider = 'anthropic' | 'openai'

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, enterprise: 2 }

// Daily cloud-message limits per tier (Infinity = unlimited). Mirrors
// src/main/stripe/pricing.ts — keep the two in sync.
const DAILY_LIMIT: Record<Tier, number> = { free: 5, pro: 500, enterprise: Infinity }

interface ModelConfig {
  provider: Provider
  model: string
  minTier: Tier
}

// modelKey → concrete provider model. `minTier` gates which tiers may use it; a
// request for a model above the user's tier silently falls back to the tier
// default (defence against a spoofed client requesting a premium model).
const MODEL_MAP: Record<string, ModelConfig> = {
  'free-default': { provider: 'anthropic', model: 'claude-3-5-haiku-latest', minTier: 'free' },
  'claude-3-5-haiku': { provider: 'anthropic', model: 'claude-3-5-haiku-latest', minTier: 'free' },
  'pro-default': { provider: 'anthropic', model: 'claude-3-5-sonnet-latest', minTier: 'pro' },
  'claude-3-5-sonnet': { provider: 'anthropic', model: 'claude-3-5-sonnet-latest', minTier: 'pro' },
  'gpt-4o': { provider: 'openai', model: 'gpt-4o', minTier: 'pro' },
  'enterprise-default': { provider: 'anthropic', model: 'claude-3-5-sonnet-latest', minTier: 'enterprise' },
  // glm-5.2 has no public endpoint yet; map to the best available model until a
  // dedicated GLM endpoint is configured server-side.
  'glm-5.2': { provider: 'anthropic', model: 'claude-3-5-sonnet-latest', minTier: 'enterprise' }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders }
  })
}

function coerceTier(value: unknown): Tier {
  return value === 'pro' || value === 'enterprise' ? value : 'free'
}

function resolveModel(modelKey: string | undefined, tier: Tier): ModelConfig {
  const requested = modelKey ? MODEL_MAP[modelKey] : undefined
  if (requested && TIER_RANK[requested.minTier] <= TIER_RANK[tier]) return requested
  return MODEL_MAP[`${tier}-default`] ?? MODEL_MAP['free-default']
}

/** Today's date as YYYY-MM-DD (UTC), matching the `usage_tracking.date` column. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Normalize a provider SSE stream into a uniform `data: {"delta":"…"}` stream
 * terminated by `data: [DONE]`, so the Electron client parses one format
 * regardless of which provider served the request.
 */
function normalizeSSE(providerBody: ReadableStream<Uint8Array>, provider: Provider): ReadableStream<Uint8Array> {
  const reader = providerBody.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          // deno-lint-ignore no-explicit-any
          const evt: any = JSON.parse(data)
          let delta = ''
          if (provider === 'anthropic') {
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              delta = evt.delta.text ?? ''
            }
          } else {
            delta = evt.choices?.[0]?.delta?.content ?? ''
          }
          if (delta) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`))
        } catch {
          // keepalive / non-JSON frame — ignore
        }
      }
    },
    cancel() {
      reader.cancel()
    }
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // 1) Authenticate the caller from their Supabase access token.
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: 'missing_token' }, 401)

    const { data: userData, error: userErr } = await supabase.auth.getUser(token)
    const user = userData?.user
    if (userErr || !user) return json({ error: 'invalid_token' }, 401)

    // 2) Parse the request and resolve the authoritative tier + model.
    const { messages, system, modelKey, stream } = await req.json()
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: 'messages_required' }, 400)
    }
    const tier = coerceTier((user.app_metadata as Record<string, unknown> | undefined)?.tier)
    const limit = DAILY_LIMIT[tier]
    const today = todayUtc()

    // 3) Enforce the daily message limit.
    const { data: usageRow } = await supabase
      .from('usage_tracking')
      .select('message_count')
      .eq('user_id', user.id)
      .eq('date', today)
      .maybeSingle()
    const currentCount = usageRow?.message_count ?? 0

    if (Number.isFinite(limit) && currentCount >= limit) {
      return json({ error: 'rate_limited', remaining: 0, limit }, 429)
    }

    // 4) Proxy to the resolved provider.
    const modelConfig = resolveModel(modelKey, tier)
    let response: Response | undefined

    if (modelConfig.provider === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': Deno.env.get('ANTHROPIC_API_KEY') ?? '',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: modelConfig.model,
          max_tokens: 4096,
          ...(system ? { system } : {}),
          messages,
          stream: stream || false
        })
      })
    } else {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY') ?? ''}`
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
          stream: stream || false
        })
      })
    }

    if (!response.ok || !response.body) {
      const errorData = await response.text().catch(() => '')
      console.error('LLM API error:', response.status, errorData)
      return json({ error: 'llm_error' }, 502)
    }

    // 5) Count this message and compute the post-increment remaining balance.
    await supabase
      .from('usage_tracking')
      .upsert({ user_id: user.id, date: today, message_count: currentCount + 1 }, { onConflict: 'user_id,date' })

    const unlimited = !Number.isFinite(limit)
    const rateHeaders: Record<string, string> = {
      'x-ratelimit-tier': tier,
      'x-ratelimit-limit': unlimited ? 'unlimited' : String(limit),
      'x-ratelimit-remaining': unlimited ? 'unlimited' : String(Math.max(0, limit - (currentCount + 1)))
    }

    // Stream → normalized SSE; otherwise return the provider JSON unchanged.
    if (stream) {
      return new Response(normalizeSSE(response.body, modelConfig.provider), {
        headers: {
          ...corsHeaders,
          ...rateHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        }
      })
    }
    const data = await response.json()
    return json(data, 200, rateHeaders)
  } catch (error) {
    console.error('Chat proxy error:', error)
    return json({ error: 'internal_error' }, 500)
  }
})
