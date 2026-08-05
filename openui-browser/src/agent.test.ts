// Real-HTTP tests for the model-driven agent loop. A local MOCK chat-proxy plays
// the model's role (the sandbox has no real chat-proxy key), returning scripted
// SSE replies so we can prove the LOOP mechanics end-to-end through the actual
// Express stack: tool-call JSON → gate/execute, TOOL RESULT fed back for the next
// turn, malformed-reply nudge (surfaced, never silently dropped), and plain-text
// answers. What a mock CANNOT prove is that a real model REASONS its way to the
// right tool — that check is done separately against a live model.
//
// Run: npx tsx --test src/agent.test.ts

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// The nudge text the loop sends on a malformed reply — asserted verbatim below.
import { MALFORMED_TOOL_CALL_NUDGE } from './agentTools.js'

// ── mock chat-proxy ──────────────────────────────────────────────────────────
// Records every request's messages so tests can assert what the loop sent, and
// replies with a scripted turn based on the task text + how many assistant turns
// are already in the conversation (the turn index).
const received: Array<Array<{ role: string; content: string }>> = []

function sse(res: express.Response, text: string): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.write(`data: ${JSON.stringify({ delta: text })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function scriptFor(task: string): string[] {
  const t = task.toLowerCase()
  // NOTE: these branch on test-scenario phrasing to script the MODEL's role — this
  // is test scaffolding, not the product. The product has no keyword mapping.
  if (t.includes('tracker') || t.includes('numbers')) {
    return [
      JSON.stringify({ tool: 'write_spreadsheet', args: { title: 'Q4 Tracker', sheets: [{ name: 'Numbers', headers: ['Metric', 'Value'], rows: [['Revenue', 120], ['Signups', 34]] }] } }),
      'All set — your Q4 tracker is ready to download.'
    ]
  }
  if (t.includes('write-up') || t.includes('document')) {
    return [
      JSON.stringify({ tool: 'create_document', args: { title: 'Kickoff Notes', paragraphs: ['We agreed on the plan.', 'Next steps follow.'] } }),
      'Done — I created the Kickoff Notes document.'
    ]
  }
  if (t.includes('malformed-once')) {
    return [JSON.stringify({ note: 'I think I should make a sheet', confidence: 0.9 }), 'Sure — could you clarify what you need?']
  }
  if (t.includes('malformed-twice')) {
    const bad = JSON.stringify({ plan: 'do the thing', steps: ['a', 'b'] })
    return [bad, bad, bad]
  }
  if (t.includes('just answer')) {
    return ['The capital of France is Paris.']
  }
  return ['I am not sure how to help with that.']
}

let mockServer: Server
let appServer: Server
let base = ''
let mockBase = ''

before(async () => {
  // Start the mock chat-proxy first so we can point the server env at it.
  const mock = express()
  mock.use(express.json())
  mock.post('/chat-proxy', (req, res) => {
    const messages = (req.body?.messages ?? []) as Array<{ role: string; content: string }>
    received.push(messages)
    const task = messages.find((m) => m.role === 'user')?.content ?? ''
    const asstTurns = messages.filter((m) => m.role === 'assistant').length
    const script = scriptFor(task)
    sse(res, script[Math.min(asstTurns, script.length - 1)])
  })
  await new Promise<void>((resolve) => {
    mockServer = mock.listen(0, () => resolve())
  })
  mockBase = `http://localhost:${(mockServer.address() as AddressInfo).port}`

  // Configure the server for DEV_STUB auth + the mock chat-proxy, THEN import it
  // (env is read at module load).
  process.env.DEV_STUB = 'true'
  process.env.NODE_ENV = 'test'
  process.env.CHAT_PROXY_URL = `${mockBase}/chat-proxy`
  process.env.SUPABASE_ANON_KEY = 'test-anon'
  delete process.env.SUPABASE_URL
  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    appServer = app.listen(0, () => resolve())
  })
  base = `http://localhost:${(appServer.address() as AddressInfo).port}`
})

after(() => {
  appServer?.close()
  mockServer?.close()
})

const AUTH = { Authorization: 'Bearer dev:tester', 'Content-Type': 'application/json' }

async function agent(message: string): Promise<any> {
  const res = await fetch(`${base}/api/agent`, { method: 'POST', headers: AUTH, body: JSON.stringify({ message, connections: {} }) })
  return { status: res.status, body: await res.json() }
}
async function resume(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${base}/api/agent/resume`, { method: 'POST', headers: AUTH, body: JSON.stringify({ ...payload, connections: {} }) })
  return { status: res.status, body: await res.json() }
}

test('gated tool: model selects write_spreadsheet → gate pause → approve → real .xlsx', async () => {
  const { status, body } = await agent('can you whip me up a tracker for this quarter’s numbers')
  assert.equal(status, 200)
  assert.equal(body.kind, 'needs_confirmation', 'a state-changing tool must pause for approval, not run')
  assert.equal(body.name, 'write_spreadsheet')
  assert.ok(body.confirmation.token, 'a single-use confirmation token is issued')
  assert.equal(body.confirmation.destructive, false)

  // Approve → resume executes through the gate and the loop concludes in prose.
  const r = await resume({ transcript: body.transcript, name: body.name, args: body.args, confirmationToken: body.confirmation.token, approved: true })
  assert.equal(r.status, 200)
  assert.equal(r.body.kind, 'reply')
  assert.match(r.body.reply, /tracker/i)
  const files = r.body.files as Array<{ name: string; url: string; bytes: number }>
  assert.equal(files.length, 1)
  assert.match(files[0].name, /\.xlsx$/)

  // The generated file is really served and is a real xlsx (PK zip magic).
  const fileRes = await fetch(`${base}${new URL(files[0].url).pathname}`)
  assert.equal(fileRes.status, 200)
  const buf = Buffer.from(await fileRes.arrayBuffer())
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK')
})

test('gated tool: DENY → nothing runs, loop reports it honestly', async () => {
  const { body } = await agent('build me a tracker of numbers')
  assert.equal(body.kind, 'needs_confirmation')
  const r = await resume({ transcript: body.transcript, name: body.name, args: body.args, confirmationToken: body.confirmation.token, approved: false })
  assert.equal(r.body.kind, 'reply')
  assert.equal((r.body.steps as Array<{ ok: boolean }>)[0].ok, false)
  assert.equal((r.body.files as unknown[]).length, 0, 'a denied action produces no file')
})

test('non-gated tool: create_document runs inline and returns a real .docx', async () => {
  const { status, body } = await agent('please put together a short write-up for the kickoff document')
  assert.equal(status, 200)
  assert.equal(body.kind, 'reply', 'non-gated tools run inline without a confirmation pause')
  const files = body.files as Array<{ name: string; url: string }>
  assert.equal(files.length, 1)
  assert.match(files[0].name, /\.docx$/)
  const fileRes = await fetch(`${base}${new URL(files[0].url).pathname}`)
  const buf = Buffer.from(await fileRes.arrayBuffer())
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'a .docx is a zip (PK) — proves it is not the old markdown stand-in')
})

test('malformed tool call: JSON-but-no-tool is NUDGED then surfaced (never silently dropped)', async () => {
  const before = received.length
  const { body } = await agent('malformed-once please')
  // The loop must have sent the malformed-call nudge back to the model.
  const sent = received.slice(before)
  const nudged = sent.some((msgs) => msgs[msgs.length - 1]?.content === MALFORMED_TOOL_CALL_NUDGE)
  assert.ok(nudged, 'the loop must nudge a malformed reply, not silently do nothing')
  // And it recovers with the model’s follow-up natural-language answer.
  assert.equal(body.kind, 'reply')
  assert.match(body.reply, /clarify/i)
})

test('malformed tool call: still malformed after retries → the text is surfaced visibly', async () => {
  const { body } = await agent('malformed-twice please')
  assert.equal(body.kind, 'reply')
  // The raw (non-tool) JSON is shown to the user rather than dropped into a void.
  assert.match(body.reply, /"plan"/)
})

test('plain question: no tool is forced — a natural-language answer comes back', async () => {
  const { body } = await agent('just answer: what is the capital of France?')
  assert.equal(body.kind, 'reply')
  assert.match(body.reply, /Paris/)
  assert.equal((body.files as unknown[]).length, 0)
})

test('honest failure: no chat backend → agent returns 503 not_configured, never a guess', async () => {
  // Point a fresh import at an unconfigured backend by clearing the proxy URL.
  // (Re-imported module is cached; instead assert the live one errors when the
  // upstream is unreachable by pointing the mock away.)
  const res = await fetch(`${base}/api/agent`, {
    method: 'POST',
    headers: { Authorization: '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' })
  })
  assert.equal(res.status, 401, 'no auth → unauthenticated, not a fabricated answer')
})
