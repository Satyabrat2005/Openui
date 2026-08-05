// OpenUI Web backend — serves the ported Run Console frontend and the data-layer
// endpoints it calls (the web replacements for the desktop window.openui.* IPC).
// Real token verification, the confirmation gate, real tool execution with
// served file links, a live chat stream that is a real Supabase `chat-proxy`
// passthrough, and — new in this phase — a REAL model-driven tool-calling agent
// loop that replaces the old keyword regex. There is deliberately NO fake-answer
// fallback anywhere: a missing/failed chat backend returns a specific, honest
// error rather than fabricating a response OR silently guessing a tool.

import express, { type Request, type Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import ExcelJS from 'exceljs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfirmationStore, requiresConfirmation, isDestructive, STATE_CHANGING_TOOLS, DESTRUCTIVE_TOOLS } from './gates.js'
import { buildAgentSystemPrompt, WEB_TOOL_NAMES, MALFORMED_TOOL_CALL_NUDGE } from './agentTools.js'
import { parseToolCall, looksLikeAttemptedToolCall } from './toolCallParser.js'
import { generateDocx, generatePdf, generatePptx, searchPapers, downloadPaper, desktopReuseAvailable } from './desktopReuse.js'
import { githubTools } from './githubTools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8787
const SUPABASE_URL = process.env.SUPABASE_URL?.trim() || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || ''
const CHAT_PROXY_URL =
  process.env.CHAT_PROXY_URL?.trim() || (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/chat-proxy` : '')
const DEV_STUB = process.env.NODE_ENV !== 'production' && (!SUPABASE_URL || process.env.DEV_STUB === 'true')
const STORAGE_ROOT = join(process.cwd(), '.local-storage')
const BASE_URL = `http://localhost:${PORT}`

// Agent loop bounds — mirror the desktop's turn/retry ceilings.
const MAX_AGENT_TURNS = 8
const MAX_MALFORMED_RETRIES = 2

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
interface StoredFile { name: string; url: string; bytes: number }
async function putFile(userId: string, name: string, bytes: Buffer): Promise<StoredFile> {
  const leaf = name.replace(/[\\/]+/g, '_')
  const abs = join(STORAGE_ROOT, userId, leaf)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  return { name: leaf, url: `${BASE_URL}/local-files/${encodeURIComponent(userId)}/${encodeURIComponent(leaf)}`, bytes: bytes.length }
}

// ── tools ───────────────────────────────────────────────────────────────────
interface ToolResult { ok?: boolean; summary?: string; files?: StoredFile[]; data?: unknown; error?: string }
type ToolArgs = Record<string, unknown>

/**
 * The one place a tool actually runs. Every name here is a REAL implementation —
 * document/PDF/deck/paper generation reuses the desktop app's proven modules
 * (see desktopReuse.ts); GitHub writes reuse the desktop github.ts contract with
 * per-request tokens (githubTools.ts). The gate (gates.ts) decides which of these
 * need confirmation; a boot assertion guarantees nothing is gated-but-unrunnable.
 */
async function runTool(name: string, args: ToolArgs, ctx: { userId: string; connections: Record<string, string> }): Promise<ToolResult> {
  switch (name) {
    case 'write_spreadsheet': {
      const wb = new ExcelJS.Workbook()
      const sheets = Array.isArray(args.sheets) ? (args.sheets as Array<Record<string, unknown>>) : []
      for (const [i, s] of sheets.entries()) {
        const ws = wb.addWorksheet(typeof s.name === 'string' && s.name ? s.name : `Sheet${i + 1}`)
        const headers = Array.isArray(s.headers) ? (s.headers as string[]) : []
        if (headers.length) { ws.addRow(headers); ws.getRow(1).font = { bold: true } }
        const rows = Array.isArray(s.rows) ? (s.rows as unknown[][]) : []
        for (const r of rows) ws.addRow(r as (string | number)[])
      }
      const out = await wb.xlsx.writeBuffer()
      const file = await putFile(ctx.userId, `${(args.title as string) || 'Workbook'}.xlsx`, Buffer.from(out as ArrayBuffer))
      return { ok: true, summary: `Wrote ${file.name}`, files: [file] }
    }
    case 'create_document': {
      const gen = await generateDocx(args)
      const file = await putFile(ctx.userId, gen.filename, gen.bytes)
      return { ok: true, summary: `Created ${file.name}`, files: [file] }
    }
    case 'create_pdf': {
      const gen = await generatePdf(args)
      const file = await putFile(ctx.userId, gen.filename, gen.bytes)
      return { ok: true, summary: `Created ${file.name}`, files: [file] }
    }
    case 'create_presentation': {
      const gen = await generatePptx(args)
      const file = await putFile(ctx.userId, gen.filename, gen.bytes)
      return { ok: true, summary: `Created ${file.name}`, files: [file] }
    }
    case 'search_papers': {
      const res = await searchPapers(args)
      if (!res.ok) return { ok: false, error: res.error || 'search_papers failed' }
      const text = res.output || ''
      return { ok: true, summary: text.split('\n')[0] || 'Search complete', data: { text } }
    }
    case 'download_paper': {
      const gen = await downloadPaper(args)
      const file = await putFile(ctx.userId, gen.filename, gen.bytes)
      return { ok: true, summary: `Downloaded ${file.name}`, files: [file] }
    }
    case 'create_repo':
    case 'update_readme':
    case 'push_files':
    case 'open_pull_request':
    case 'merge_pr': {
      const token = (ctx.connections.github || '').trim()
      const res = await githubTools[name](args, token)
      return res.ok ? { ok: true, summary: res.output } : { ok: false, error: res.error }
    }
    default:
      return { ok: false, error: `unknown_tool: ${name}` }
  }
}

// Names runTool can actually execute — the source of truth for the boot check.
const RUN_TOOL_NAMES = new Set<string>([
  'write_spreadsheet', 'create_document', 'create_pdf', 'create_presentation',
  'search_papers', 'download_paper',
  'create_repo', 'update_readme', 'push_files', 'open_pull_request', 'merge_pr'
])

/**
 * Fail LOUD at boot if the gate and the implementation disagree. A tool that is
 * confirmable (state-changing/destructive) but not runnable is the exact bug this
 * phase fixed — never let it regress silently. Also warns if the agent is shown a
 * schema for a tool runTool can't execute (a dead-end the model could pick).
 */
function assertGateImplementationParity(): void {
  const gated = new Set<string>([...STATE_CHANGING_TOOLS, ...DESTRUCTIVE_TOOLS])
  const missing = [...gated].filter((t) => !RUN_TOOL_NAMES.has(t))
  if (missing.length) {
    throw new Error(
      `[gate] ${missing.join(', ')} are gated in gates.ts but have no implementation in runTool. ` +
        `A tool must never be confirmable without being runnable — implement it or remove it from the gate.`
    )
  }
  const advertisedButUnrunnable = [...WEB_TOOL_NAMES].filter((t) => !RUN_TOOL_NAMES.has(t))
  if (advertisedButUnrunnable.length) {
    throw new Error(`[agent] tool schema(s) advertised to the model but not runnable: ${advertisedButUnrunnable.join(', ')}`)
  }
}

// ── chat-proxy full-text call (for the agent loop) ───────────────────────────
class ChatProxyError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

/**
 * Call the SAME chat-proxy the streaming /api/chat uses, but accumulate the SSE
 * deltas into the full assistant text the loop needs to parse a tool call from.
 * Honest failures only — never returns a fabricated string.
 */
async function callChatProxyFull(messages: Array<{ role: string; content: string }>, auth: string): Promise<string> {
  if (!CHAT_PROXY_URL || !SUPABASE_ANON_KEY) {
    throw new ChatProxyError(503, 'not_configured', 'The chat backend is not configured (missing SUPABASE_URL / SUPABASE_ANON_KEY).')
  }
  let upstream: globalThis.Response
  try {
    upstream = await fetch(CHAT_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ messages, stream: true })
    })
  } catch (err) {
    console.error('[agent] cannot reach chat-proxy:', err)
    throw new ChatProxyError(502, 'upstream_unreachable', "Couldn't reach the chat service.")
  }
  if (!upstream.ok) {
    const body = (await upstream.json().catch(() => ({}))) as { error?: string }
    const code = typeof body.error === 'string' ? body.error : 'chat_proxy_error'
    throw new ChatProxyError(upstream.status, code, chatProxyErrorMessage(upstream.status, code))
  }
  if (!upstream.body) return ''
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const j = JSON.parse(data) as { delta?: string }
        if (typeof j.delta === 'string') full += j.delta
      } catch {
        /* keepalive / non-json line */
      }
    }
  }
  return full
}

function formatToolResult(tool: string, result: ToolResult): string {
  if (result.ok) {
    const detail = result.summary ?? (result.files?.length ? result.files.map((f) => f.name).join(', ') : undefined)
    const data = result.data && typeof (result.data as { text?: string }).text === 'string' ? `\n${(result.data as { text: string }).text}` : ''
    return `TOOL RESULT [${tool}] success: ${detail ?? '(no output)'}${data}`
  }
  return `TOOL RESULT [${tool}] error: ${result.error ?? 'unknown error'}`
}

// ── the agent loop ───────────────────────────────────────────────────────────
interface AgentStep { name: string; ok: boolean; summary: string; files?: StoredFile[] }
type AgentOutcome =
  | { kind: 'reply'; text: string; steps: AgentStep[] }
  | {
      kind: 'needs_confirmation'
      confirmation: { token: string; name: string; destructive: boolean; summary: string; args: ToolArgs }
      transcript: Array<{ role: string; content: string }>
      steps: AgentStep[]
    }

function stepFrom(name: string, result: ToolResult): AgentStep {
  return { name, ok: result.ok !== false, summary: result.ok !== false ? result.summary ?? `Ran ${name}` : result.error ?? `Failed ${name}`, files: result.files }
}

/**
 * Drive the model → tool-call → result loop. Non-gated tools run inline and their
 * result is fed back for the next turn; a gated tool STOPS the loop and returns a
 * confirmation the client approves through the existing gate. A model reply that
 * is not a tool call ends the loop as a natural-language answer — and a reply that
 * is JSON-but-not-a-tool-call is nudged (visibly, not silently dropped) before we
 * give up and surface it as text.
 */
async function runAgentLoop(
  messages: Array<{ role: string; content: string }>,
  auth: string,
  ctx: { userId: string; connections: Record<string, string> },
  steps: AgentStep[] = []
): Promise<AgentOutcome> {
  let malformedRetries = 0
  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const modelText = await callChatProxyFull(messages, auth)
    messages.push({ role: 'assistant', content: modelText })

    const toolCall = parseToolCall(modelText, WEB_TOOL_NAMES)
    if (!toolCall) {
      if (looksLikeAttemptedToolCall(modelText) && malformedRetries < MAX_MALFORMED_RETRIES) {
        malformedRetries++
        messages.push({ role: 'user', content: MALFORMED_TOOL_CALL_NUDGE })
        continue
      }
      // Genuine natural-language answer, OR a malformed reply we could not coax
      // into a valid call — either way, surface the text to the user, never drop it.
      return { kind: 'reply', text: modelText.trim(), steps }
    }

    if (requiresConfirmation(toolCall.tool)) {
      const token = confirmations.issue(ctx.userId, toolCall.tool, toolCall.args)
      return {
        kind: 'needs_confirmation',
        confirmation: {
          token,
          name: toolCall.tool,
          destructive: isDestructive(toolCall.tool),
          summary: `Run "${toolCall.tool}"? This performs a ${isDestructive(toolCall.tool) ? 'destructive/irreversible' : 'state-changing'} action.`,
          args: toolCall.args
        },
        transcript: messages,
        steps
      }
    }

    // Non-gated tool: execute and feed the real result back for the next turn.
    let result: ToolResult
    try {
      result = await runTool(toolCall.tool, toolCall.args, ctx)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    steps.push(stepFrom(toolCall.tool, result))
    messages.push({ role: 'user', content: formatToolResult(toolCall.tool, result) })
  }
  return { kind: 'reply', text: 'I reached the step limit before finishing. Here is what I completed above.', steps }
}

function outcomeToResponse(outcome: AgentOutcome): Record<string, unknown> {
  const files = outcome.steps.flatMap((s) => s.files ?? [])
  if (outcome.kind === 'needs_confirmation') {
    return {
      kind: 'needs_confirmation',
      confirmation: outcome.confirmation,
      transcript: outcome.transcript,
      name: outcome.confirmation.name,
      args: outcome.confirmation.args,
      steps: outcome.steps,
      files
    }
  }
  return { kind: 'reply', reply: outcome.text, steps: outcome.steps, files }
}

// ── app ───────────────────────────────────────────────────────────────────
export const app = express()
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
  res.json({ connections: [{ id: 'github', name: 'GitHub', kind: 'github', state: 'disconnected' }] })
})

app.get('/api/workflows', async (req, res) => {
  const u = await verify(req.header('authorization'))
  if (!u) return res.status(401).json({ workflows: [] })
  res.json({ workflows: [] })
})

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

// Chat: a REAL Supabase chat-proxy passthrough (Ask mode). No echo, no fake success.
app.post('/api/chat', async (req: Request, res: Response) => {
  const u = await verify(req.header('authorization'))
  if (!u) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'You are not signed in, or your session has expired. Sign in again to chat.'
    })
  }
  const auth = req.header('authorization')!

  if (!CHAT_PROXY_URL || !SUPABASE_ANON_KEY || !supabase) {
    const missing =
      [!SUPABASE_URL && 'SUPABASE_URL', !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY'].filter(Boolean).join(', ') || 'chat backend'
    console.error(`[chat] MISCONFIGURED DEPLOY: chat-proxy unavailable — missing ${missing}. No real LLM response is possible.`)
    return res.status(503).json({
      error: 'not_configured',
      message: `This deployment is misconfigured: the chat backend is not set up (missing ${missing}). No AI response is possible until an operator configures it.`
    })
  }

  let upstream: globalThis.Response
  try {
    upstream = await fetch(CHAT_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(req.body)
    })
  } catch (err) {
    console.error('[chat] cannot reach chat-proxy:', err)
    return res.status(502).json({ error: 'upstream_unreachable', message: "Couldn't reach the chat service. Check your connection and try again." })
  }

  if (!upstream.ok) {
    const body = (await upstream.json().catch(() => ({}))) as { error?: string }
    const code = typeof body.error === 'string' ? body.error : undefined
    if (upstream.status >= 500) console.error(`[chat] chat-proxy ${upstream.status} (${code ?? 'no-code'}) — backend/provider failure`)
    return res.status(upstream.status).json({ error: code ?? 'chat_proxy_error', status: upstream.status, message: chatProxyErrorMessage(upstream.status, code) })
  }

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

// ── the model-driven agent loop (Act mode) — replaces the client-side regex ──
// The gate is UNCHANGED; this endpoint changes WHAT decides to call it. A gated
// tool comes back as needsConfirmation (+ the transcript to resume with); the
// client approves through the same inline callout the regex path used.
app.post('/api/agent', async (req, res) => {
  const u = await verify(req.header('authorization'))
  if (!u) return res.status(401).json({ error: 'unauthenticated', message: 'Sign in again to run a task.' })
  const auth = req.header('authorization')!

  const { message, messages, connections = {} } = req.body ?? {}
  const history: Array<{ role: string; content: string }> = Array.isArray(messages)
    ? messages.filter((m) => m && typeof m.content === 'string').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    : typeof message === 'string' && message.trim()
      ? [{ role: 'user', content: message.trim() }]
      : []
  if (history.length === 0) return res.status(400).json({ error: 'message_required', message: 'Provide a "message" or "messages".' })

  const convo = [{ role: 'system', content: buildAgentSystemPrompt() }, ...history]
  try {
    const outcome = await runAgentLoop(convo, auth, { userId: u.id, connections })
    res.json(outcomeToResponse(outcome))
  } catch (err) {
    if (err instanceof ChatProxyError) return res.status(err.status).json({ error: err.code, message: err.message })
    console.error('[agent] loop error:', err)
    res.status(500).json({ error: 'agent_error', message: err instanceof Error ? err.message : String(err) })
  }
})

// Resume after the user approves (or denies) a gated tool the loop selected.
app.post('/api/agent/resume', async (req, res) => {
  const u = await verify(req.header('authorization'))
  if (!u) return res.status(401).json({ error: 'unauthenticated', message: 'Sign in again to continue the task.' })
  const auth = req.header('authorization')!

  const { transcript, name, args = {}, confirmationToken, connections = {}, approved } = req.body ?? {}
  if (typeof name !== 'string') return res.status(400).json({ error: 'name required' })
  if (!Array.isArray(transcript)) return res.status(400).json({ error: 'transcript required' })
  const convo: Array<{ role: string; content: string }> = transcript
    .filter((m: unknown) => m && typeof (m as { content?: unknown }).content === 'string')
    .map((m: { role?: string; content: string }) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: m.content }))
  const ctx = { userId: u.id, connections }

  let firstStep: AgentStep
  if (approved) {
    if (!confirmations.consume(confirmationToken, u.id, name, args)) {
      return res.status(400).json({ error: 'invalid_or_expired_confirmation' })
    }
    let result: ToolResult
    try {
      result = await runTool(name, args, ctx)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    firstStep = stepFrom(name, result)
    convo.push({ role: 'user', content: formatToolResult(name, result) })
  } else {
    firstStep = { name, ok: false, summary: 'Denied — nothing ran.' }
    convo.push({
      role: 'user',
      content: `TOOL RESULT [${name}] error: User denied this action. Do not retry it; tell the user you could not proceed without their approval.`
    })
  }

  try {
    const outcome = await runAgentLoop(convo, auth, ctx, [firstStep])
    res.json(outcomeToResponse(outcome))
  } catch (err) {
    if (err instanceof ChatProxyError) return res.status(err.status).json({ error: err.code, message: err.message })
    console.error('[agent] resume error:', err)
    res.status(500).json({ error: 'agent_error', message: err instanceof Error ? err.message : String(err) })
  }
})

// The one endpoint that runs a SINGLE tool directly — still behind the gate.
// (Kept for direct tool invocation and as the primitive the agent loop mirrors.)
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

// Boot the server only when run directly (tests import `app` and listen on :0).
const norm = (p: string): string => normalize(p).toLowerCase()
const isMain = process.argv[1] ? norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]) : false
if (isMain) {
  assertGateImplementationParity()
  desktopReuseAvailable().then((ok) => {
    if (!ok) console.error(`[reuse] desktop modules not found — document/paper tools will error. Set OPENUI_DESKTOP_MAIN to the desktop src/main path.`)
  })
  app.listen(PORT, () => {
    const chatState = CHAT_PROXY_URL && SUPABASE_ANON_KEY ? 'chat-proxy' : 'NOT CONFIGURED (chat/agent will 503)'
    console.log(`OpenUI Web on ${BASE_URL}  ·  auth: ${DEV_STUB ? 'DEV STUB' : 'Supabase'}  ·  chat: ${chatState}`)
    if (chatState.startsWith('NOT')) {
      console.error('[chat] chat-proxy is not configured — set SUPABASE_URL and SUPABASE_ANON_KEY. /api/chat and /api/agent return 503 until then.')
    }
  })
}

// Exported for tests (real HTTP via app.listen(0)).
export { runTool, runAgentLoop, assertGateImplementationParity, RUN_TOOL_NAMES }
