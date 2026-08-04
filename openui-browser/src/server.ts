// OpenUI Web backend — serves the ported Run Console frontend and the data-layer
// endpoints it calls (the web replacements for the desktop window.openui.* IPC).
// Lean but real: token verification, the confirmation gate, real tool execution
// with signed/served file links, and a live chat stream that is a real Supabase
// `chat-proxy` passthrough (streamed SSE, same request contract as the desktop
// app). There is deliberately NO fake-answer fallback: if chat-proxy is not
// configured or a call fails, /api/chat returns a specific, honest error rather
// than fabricating a "successful" response.

import express, { type Request, type Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfirmationStore, requiresConfirmation, isDestructive } from './gates.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8787
const SUPABASE_URL = process.env.SUPABASE_URL?.trim() || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || ''
const CHAT_PROXY_URL =
  process.env.CHAT_PROXY_URL?.trim() || (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/chat-proxy` : '')
const DEV_STUB = process.env.NODE_ENV !== 'production' && (!SUPABASE_URL || process.env.DEV_STUB === 'true')
const STORAGE_ROOT = join(process.cwd(), '.local-storage')
const BASE_URL = `http://localhost:${PORT}`

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null
const confirmations = new ConfirmationStore()
setInterval(() => confirmations.sweep(), 60_000).unref()

interface VUser { id: string; email?: string; tier: 'free' | 'pro' | 'enterprise' }
async function verify(authHeader?: string): Promise<VUser | null> {
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  if (DEV_STUB) {
    const id = token.startsWith('dev:') ? token.slice(4) : 'dev-user'
    return { id, email: `${id}@dev.local`, tier: 'free' }
  }
  if (!supabase) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) return null
  const tier = (data.user.app_metadata as Record<string, unknown> | undefined)?.tier
  return { id: data.user.id, email: data.user.email, tier: tier === 'pro' || tier === 'enterprise' ? tier : 'free' }
}

// ── storage sink (local disk; served below) ─────────────────────────────────
async function putFile(userId: string, name: string, bytes: Buffer): Promise<{ name: string; url: string; bytes: number }> {
  const leaf = name.replace(/[\\/]+/g, '_')
  const abs = join(STORAGE_ROOT, userId, leaf)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  return { name: leaf, url: `${BASE_URL}/local-files/${encodeURIComponent(userId)}/${encodeURIComponent(leaf)}`, bytes: bytes.length }
}

// ── tools ───────────────────────────────────────────────────────────────────
interface ToolResult { ok?: boolean; summary?: string; files?: unknown[]; data?: unknown; error?: string }
interface SheetSpec { name?: string; headers?: string[]; rows?: (string | number)[][] }
interface ToolArgs {
  title?: string
  sheets?: SheetSpec[]
  paragraphs?: string[]
  body?: string
  query?: string
  max_results?: number
  name?: string
  description?: string
  private?: boolean
}
async function runTool(name: string, args: ToolArgs, ctx: { userId: string; connections: Record<string, string> }): Promise<ToolResult> {
  if (name === 'write_spreadsheet') {
    const wb = new ExcelJS.Workbook()
    for (const [i, s] of (args.sheets ?? []).entries()) {
      const ws = wb.addWorksheet(s.name || `Sheet${i + 1}`)
      if (s.headers?.length) { ws.addRow(s.headers); ws.getRow(1).font = { bold: true } }
      for (const r of s.rows ?? []) ws.addRow(r)
    }
    const out = await wb.xlsx.writeBuffer()
    const file = await putFile(ctx.userId, `${args.title || 'Workbook'}.xlsx`, Buffer.from(out as ArrayBuffer))
    return { ok: true, summary: `Wrote ${file.name}`, files: [file] }
  }
  if (name === 'create_document') {
    const md = `# ${args.title || 'Document'}\n\n${(args.paragraphs ?? [args.body ?? '']).join('\n\n')}\n`
    const file = await putFile(ctx.userId, `${args.title || 'Document'}.md`, Buffer.from(md, 'utf8'))
    return { ok: true, summary: `Created ${file.name}`, files: [file] }
  }
  if (name === 'search_papers') {
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(args.query || '')}&max_results=${Math.min(args.max_results || 4, 10)}`
    const xml = await (await fetch(url)).text()
    const titles = [...xml.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => m[1].trim().replace(/\s+/g, ' '))
    return { ok: true, summary: `Found ${titles.length} paper(s)`, data: { papers: titles } }
  }
  if (name === 'create_repo') {
    const token = ctx.connections.github?.trim()
    if (!token) return { ok: false, error: 'github_not_connected' }
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'openui-web', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: args.name, description: args.description ?? '', private: args.private !== false })
    })
    const body = (await res.json().catch(() => ({}))) as { message?: string; full_name?: string; html_url?: string }
    if (!res.ok) return { ok: false, error: `github_${res.status}: ${body.message ?? 'error'}` }
    return { ok: true, summary: `Created repo ${body.full_name}`, data: { html_url: body.html_url } }
  }
  return { ok: false, error: `unknown_tool: ${name}` }
}

// ── app ───────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_req, res) => res.json({ ok: true, devStub: DEV_STUB }))

app.get('/api/me', async (req, res) => {
  const u = await verify(req.header('authorization'))
  if (!u) return res.status(401).json({ user: null, tier: 'free' })
  res.json({ user: { id: u.id, email: u.email, name: u.email?.split('@')[0], tier: u.tier }, tier: u.tier })
})

app.get('/api/connections', async (req, res) => {
  const u = await verify(req.header('authorization'))
  if (!u) return res.status(401).json({ connections: [] })
  // Server-known connections; the client optimistically adds a GitHub PAT locally.
  res.json({ connections: [{ id: 'github', name: 'GitHub', kind: 'github', state: 'disconnected' }] })
})

app.get('/api/workflows', async (req, res) => {
  const u = await verify(req.header('authorization'))
  if (!u) return res.status(401).json({ workflows: [] })
  res.json({ workflows: [] })
})

// Map chat-proxy's structured error codes → a specific, user-facing message.
// chat-proxy answers every non-2xx as JSON `{ error: <code> }` (only its success
// path is SSE), so we can read the real code even for a streaming request and
// surface an accurate message instead of a generic bucket.
function chatProxyErrorMessage(status: number, code: string | undefined): string {
  switch (code) {
    case 'rate_limited':
      return "You've reached your daily usage limit. Upgrade your plan or try again tomorrow."
    case 'missing_token':
    case 'invalid_token':
      return 'Your session has expired. Please sign in again to continue.'
    case 'messages_required':
      return 'The chat request was empty — type a message and try again.'
    case 'llm_error':
      return 'The AI provider rejected the request (usually a server-side API key or account-credit problem). Please try again shortly.'
    case 'internal_error':
      return 'The chat service hit an internal error. Please try again shortly.'
    default:
      return `The chat service returned an error (HTTP ${status}${code ? `: ${code}` : ''}).`
  }
}

// Chat: a REAL Supabase chat-proxy passthrough. No echo, no fake success —
// every failure mode below returns its own specific, honest error.
app.post('/api/chat', async (req: Request, res: Response) => {
  const u = await verify(req.header('authorization'))
  if (!u) {
    // No/expired session — don't pretend to answer, ask them to sign in.
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'You are not signed in, or your session has expired. Sign in again to chat.'
    })
  }
  const auth = req.header('authorization')!

  // Deploy-config guard. A missing chat backend is a DEPLOYMENT bug, not a user
  // error: make it LOUD in the logs/monitoring, and tell the user plainly that
  // the deployment is misconfigured rather than fabricating an answer.
  if (!CHAT_PROXY_URL || !SUPABASE_ANON_KEY || !supabase) {
    const missing =
      [!SUPABASE_URL && 'SUPABASE_URL', !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY'].filter(Boolean).join(', ') ||
      'chat backend'
    console.error(
      `[chat] MISCONFIGURED DEPLOY: chat-proxy unavailable — missing ${missing}. No real LLM response is possible.`
    )
    return res.status(503).json({
      error: 'not_configured',
      message: `This deployment is misconfigured: the chat backend is not set up (missing ${missing}). No AI response is possible until an operator configures it.`
    })
  }

  // Real chat-proxy call — same contract as desktop edgeFunctions.ts
  // (`apikey` + `Authorization: Bearer <token>`), streamed SSE preserved.
  let upstream: globalThis.Response
  try {
    upstream = await fetch(CHAT_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(req.body)
    })
  } catch (err) {
    // Never got an HTTP answer: DNS/TLS/network/timeout reaching Supabase. This
    // is a DISTINCT failure from an auth error — keep it in its own bucket.
    console.error('[chat] cannot reach chat-proxy:', err)
    return res.status(502).json({
      error: 'upstream_unreachable',
      message: "Couldn't reach the chat service. Check your connection and try again."
    })
  }

  // Non-2xx from chat-proxy → surface the ACTUAL status + its structured error
  // code and a specific message. Server-side failures are logged loudly.
  if (!upstream.ok) {
    const body = (await upstream.json().catch(() => ({}))) as { error?: string }
    const code = typeof body.error === 'string' ? body.error : undefined
    if (upstream.status >= 500) {
      console.error(`[chat] chat-proxy ${upstream.status} (${code ?? 'no-code'}) — backend/provider failure`)
    }
    return res.status(upstream.status).json({
      error: code ?? 'chat_proxy_error',
      status: upstream.status,
      message: chatProxyErrorMessage(upstream.status, code)
    })
  }

  // Success: stream the normalized SSE straight through to the browser.
  res.status(upstream.status)
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  if (!upstream.body) return res.end()
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  } catch (err) {
    console.error('[chat] stream interrupted:', err)
  }
  return res.end()
})

// The one endpoint that runs tools — behind the confirmation gate.
app.post('/api/tool', async (req, res) => {
  const u = await verify(req.header('authorization'))
  if (!u) return res.status(401).json({ error: 'missing_token' })
  const { name, args = {}, confirmationToken, connections = {} } = req.body ?? {}
  if (typeof name !== 'string') return res.status(400).json({ error: 'name required' })

  if (requiresConfirmation(name)) {
    if (!confirmationToken) {
      const token = confirmations.issue(u.id, name, args)
      return res.json({
        needsConfirmation: true,
        confirmation: {
          token, name, destructive: isDestructive(name),
          summary: `Run "${name}"? This performs a ${isDestructive(name) ? 'destructive/irreversible' : 'state-changing'} action.`,
          args
        }
      })
    }
    if (!confirmations.consume(confirmationToken, u.id, name, args)) {
      return res.status(400).json({ error: 'invalid_or_expired_confirmation' })
    }
  }
  try {
    const result = await runTool(name, args, { userId: u.id, connections })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

// Serve generated files (dev storage).
app.get('/local-files/:userId/:name', (req, res) => {
  const abs = normalize(join(STORAGE_ROOT, req.params.userId, req.params.name))
  if (!abs.startsWith(normalize(STORAGE_ROOT))) return res.status(400).json({ error: 'bad_path' })
  createReadStream(abs).on('error', () => res.status(404).json({ error: 'not_found' })).pipe(res)
})

// Serve the built frontend (production). In dev, use the Vite dev server (:5173).
app.use(express.static(join(__dirname, '..', 'public-web')))

app.listen(PORT, () => {
  const chatState = CHAT_PROXY_URL && SUPABASE_ANON_KEY && supabase ? 'chat-proxy' : 'NOT CONFIGURED (chat will 503)'
  console.log(`OpenUI Web on ${BASE_URL}  ·  auth: ${DEV_STUB ? 'DEV STUB' : 'Supabase'}  ·  chat: ${chatState}`)
  if (chatState.startsWith('NOT')) {
    console.error('[chat] chat-proxy is not configured — set SUPABASE_URL and SUPABASE_ANON_KEY. /api/chat returns 503 until then.')
  }
})
