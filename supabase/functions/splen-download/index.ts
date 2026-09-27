// splen-download — Supabase Edge Function (Deno runtime).
//
// Hands a signed-in OpenUI user a short-lived URL for Splen's weights in the
// private Cloudflare R2 bucket. Splen is never published to ollama.com or any
// public registry: this function is the only way to it, and the R2 keys that
// can sign a URL live only in this function's secrets.
//
// Deploy:  supabase functions deploy splen-download   (keep JWT verification on)
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
//          SPLEN_OBJECT_KEY  — the object's key in the bucket, e.g. "splen/4b-run4.gguf"
//          SPLEN_VERSION     — e.g. "4b-run4"
//          SPLEN_SHA256      — lower-case hex sha256 of that object
//          SPLEN_BYTES       — its exact size in bytes
//          SPLEN_ENABLED     — "1" to offer Splen at all. The rollout switch: until it
//                              is set, the app does not show Splen to anyone.
//          SPLEN_ALLOWED_EMAILS (optional) — comma-separated; when set, only these
//                              accounts are offered Splen (private testing first).
//          (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//          The R2 API token needs Object Read on this one bucket and nothing else.
//
// Request { action: 'status' } → 200 { available, version?, bytes? }. Signs
// nothing and counts nothing; the model screen asks this to decide whether to
// show Splen.
// Request { action: 'grant' } (the default) → 200 { url, version, sha256, bytes }.
// The app refuses to install a file whose sha256 differs, so the hash here is
// what makes a swapped object unusable — set it from the file that passed the
// safety gate, not from R2.
//
// Limits: a URL lives URL_TTL_SECONDS (a transfer already under way continues
// past it; a resume asks for a new one). Each user gets DAILY_GRANT_LIMIT
// grants per UTC day, counted in `splen_downloads` (migration 002), which covers
// several resumes without letting one account hand the file out at scale.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'
import { requireVerifiedUser } from '../_shared/auth.ts'

const URL_TTL_SECONDS = 15 * 60
const DAILY_GRANT_LIMIT = 20

const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

interface SplenConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  objectKey: string
  version: string
  sha256: string
  bytes: number
}

/** Every secret present and well-formed, or null — never a half-configured grant. */
function readConfig(): SplenConfig | null {
  const get = (k: string) => (Deno.env.get(k) ?? '').trim()
  const cfg = {
    accountId: get('R2_ACCOUNT_ID'),
    accessKeyId: get('R2_ACCESS_KEY_ID'),
    secretAccessKey: get('R2_SECRET_ACCESS_KEY'),
    bucket: get('R2_BUCKET'),
    objectKey: get('SPLEN_OBJECT_KEY'),
    version: get('SPLEN_VERSION'),
    sha256: get('SPLEN_SHA256').toLowerCase(),
    bytes: Number(get('SPLEN_BYTES'))
  }
  const complete =
    cfg.accountId && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket && cfg.objectKey && cfg.version
  if (!complete || !/^[0-9a-f]{64}$/.test(cfg.sha256) || !Number.isSafeInteger(cfg.bytes) || cfg.bytes <= 0) {
    return null
  }
  return cfg
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Is Splen offered to this account right now? */
function isOfferedTo(email: string | undefined): boolean {
  if ((Deno.env.get('SPLEN_ENABLED') ?? '').trim() !== '1') return false
  const allow = (Deno.env.get('SPLEN_ALLOWED_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  if (allow.length === 0) return true
  return Boolean(email) && allow.includes(email!.toLowerCase())
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const auth = await requireVerifiedUser(req, supabase)
  if (!auth.ok) return json({ error: auth.error }, auth.status)

  let action = 'grant'
  try {
    const body = await req.json()
    if (body && typeof body.action === 'string') action = body.action
  } catch {
    // An empty body is a grant request.
  }
  if (action !== 'grant' && action !== 'status') return json({ error: 'unknown_action' }, 400)

  const cfg = readConfig()
  const offered = cfg !== null && isOfferedTo(auth.user.email)
  if (action === 'status') {
    return json(offered ? { available: true, version: cfg!.version, bytes: cfg!.bytes } : { available: false })
  }
  if (!cfg) {
    console.error('[splen-download] secrets missing or malformed')
    return json({ error: 'not_configured' }, 503)
  }
  if (!offered) return json({ error: 'not_offered' }, 403)

  const today = todayUtc()
  const { data: row, error: readErr } = await supabase
    .from('splen_downloads')
    .select('grant_count')
    .eq('user_id', auth.user.id)
    .eq('date', today)
    .maybeSingle()
  if (readErr) {
    // Fail closed: without the counter there is no cap.
    console.error('[splen-download] counter read failed', readErr)
    return json({ error: 'unavailable' }, 503)
  }
  const used = row?.grant_count ?? 0
  if (used >= DAILY_GRANT_LIMIT) return json({ error: 'rate_limited', limit: DAILY_GRANT_LIMIT }, 429)

  const { error: writeErr } = await supabase
    .from('splen_downloads')
    .upsert({ user_id: auth.user.id, date: today, grant_count: used + 1 }, { onConflict: 'user_id,date' })
  if (writeErr) {
    console.error('[splen-download] counter write failed', writeErr)
    return json({ error: 'unavailable' }, 503)
  }

  const r2 = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto'
  })
  const objectUrl = new URL(
    `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${cfg.objectKey
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`
  )
  objectUrl.searchParams.set('X-Amz-Expires', String(URL_TTL_SECONDS))
  const signed = await r2.sign(new Request(objectUrl, { method: 'GET' }), { aws: { signQuery: true } })

  return json({ url: signed.url, version: cfg.version, sha256: cfg.sha256, bytes: cfg.bytes })
})
