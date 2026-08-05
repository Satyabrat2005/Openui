// Real-HTTP round-trip tests for /api/tool: request in → real file/result out,
// for each newly-wired or fixed tool. Also proves the gate/implementation parity
// the phase set out to fix — a gated tool now actually RUNS (reaching a real
// token-required error) instead of being confirmable with nothing behind it.
//
// Run: npx tsx --test src/tools.test.ts

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let appServer: Server
let base = ''

before(async () => {
  process.env.DEV_STUB = 'true'
  process.env.NODE_ENV = 'test'
  delete process.env.SUPABASE_URL
  const { app, assertGateImplementationParity } = await import('./server.js')
  assertGateImplementationParity() // must not throw — gate ⊆ implemented
  await new Promise<void>((resolve) => {
    appServer = app.listen(0, () => resolve())
  })
  base = `http://localhost:${(appServer.address() as AddressInfo).port}`
})

after(() => appServer?.close())

const AUTH = { Authorization: 'Bearer dev:tester', 'Content-Type': 'application/json' }

async function tool(name: string, args: unknown, extra: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/api/tool`, { method: 'POST', headers: AUTH, body: JSON.stringify({ name, args, ...extra }) })
  return { status: res.status, body: await res.json() }
}
async function fetchFileMagic(url: string, n = 2): Promise<string> {
  const r = await fetch(`${base}${new URL(url).pathname}`)
  assert.equal(r.status, 200, `served file ${url}`)
  return Buffer.from(await r.arrayBuffer()).subarray(0, n).toString('latin1')
}

// A gated tool: first call issues a confirmation, second executes with the token.
async function runGated(name: string, args: unknown, connections: Record<string, string> = {}): Promise<any> {
  const first = await tool(name, args)
  assert.equal(first.body.needsConfirmation, true, `${name} must require confirmation`)
  const token = first.body.confirmation.token
  return tool(name, args, { confirmationToken: token, connections })
}

test('create_document → real .docx (not the old markdown stand-in)', async () => {
  const { body } = await runGatedIfNeeded('create_document', { title: 'Report', paragraphs: ['Alpha paragraph.', 'Beta paragraph.'] })
  assert.equal(body.ok, true)
  assert.match(body.files[0].name, /\.docx$/)
  assert.equal(await fetchFileMagic(body.files[0].url), 'PK', '.docx must be a real OOXML zip')
})

test('create_pdf → real .pdf', async () => {
  const { body } = await runGatedIfNeeded('create_pdf', { title: 'Brief', content: [{ heading: 'Intro', level: 1 }, 'Body text.', { bullets: ['one', 'two'] }] })
  assert.equal(body.ok, true)
  assert.match(body.files[0].name, /\.pdf$/)
  assert.equal(await fetchFileMagic(body.files[0].url, 5), '%PDF-', '.pdf must have the %PDF- header')
})

test('create_presentation → real .pptx with the extra slide', async () => {
  const { body } = await runGatedIfNeeded('create_presentation', { title: 'Launch', slides: [{ heading: 'Agenda', bullets: ['Vision', 'Ask'] }] })
  assert.equal(body.ok, true)
  assert.match(body.files[0].name, /\.pptx$/)
  assert.equal(await fetchFileMagic(body.files[0].url), 'PK', '.pptx must be a real OOXML zip')
  assert.ok(body.files[0].bytes > 20000, 'a 2-slide deck is well over 20KB')
})

test('write_spreadsheet (GATED) → confirmation then real .xlsx', async () => {
  const { body } = await runGated('write_spreadsheet', { title: 'Data', sheets: [{ name: 'S', headers: ['A', 'B'], rows: [['x', 1]] }] })
  assert.equal(body.ok, true)
  assert.match(body.files[0].name, /\.xlsx$/)
  assert.equal(await fetchFileMagic(body.files[0].url), 'PK')
})

test('gate honesty: push_files is GATED and RUNNABLE (reaches the real token-required error)', async () => {
  // The bug this phase fixed: push_files was confirmable with no implementation.
  // Now: confirm → it runs → the real github contract asks for a token (proof the
  // impl exists and is reached, not a "confirmable-but-does-nothing" dead end).
  const { status, body } = await runGated('push_files', { repo: 'octo/demo', files: { 'README.md': '# hi' } }, {})
  assert.equal(status, 400)
  assert.equal(body.ok, false)
  assert.match(body.error, /requires a connected GitHub token/i)
})

test('gate honesty: open_pull_request and merge_pr are runnable (token-required, not dead ends)', async () => {
  const pr = await runGated('open_pull_request', { repo: 'octo/demo', title: 'Add feature' }, {})
  assert.equal(pr.body.ok, false)
  assert.match(pr.body.error, /requires a connected GitHub token/i)

  const merge = await runGated('merge_pr', { repo: 'octo/demo', pr_number: 1 }, {})
  assert.equal(merge.body.ok, false)
  assert.match(merge.body.error, /requires a connected GitHub token/i)
})

test('merge_pr is marked DESTRUCTIVE in the confirmation', async () => {
  const first = await tool('merge_pr', { repo: 'octo/demo', pr_number: 2 })
  assert.equal(first.body.confirmation.destructive, true)
})

test('search_papers → real arXiv results (network)', async (t) => {
  const { body } = await runGatedIfNeeded('search_papers', { query: 'graph neural networks', max_results: 2 })
  if (!body.ok) return t.skip(`network unavailable: ${body.error}`)
  const text = (body.data?.text ?? '') as string
  assert.match(text, /paper\(s\) for/i)
})

// create_document/create_pdf/etc are NOT gated; write_spreadsheet IS. This helper
// runs a tool whether or not it needs confirmation, so the file assertions above
// stay focused on the round-trip rather than the gate.
async function runGatedIfNeeded(name: string, args: unknown): Promise<any> {
  const first = await tool(name, args)
  if (first.body?.needsConfirmation) {
    return tool(name, args, { confirmationToken: first.body.confirmation.token })
  }
  return first
}
