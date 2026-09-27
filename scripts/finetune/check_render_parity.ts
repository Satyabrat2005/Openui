/**
 * check_render_parity.ts — prove the in-app prompt IS the prompt Ollama sends.
 *
 * Every Splen number was measured through Ollama. The in-app runtime renders
 * the prompt itself (src/main/splen/prompt.ts); if that differs by one byte from
 * Ollama's Go renderer, the numbers stop describing the model users get. This
 * asks Ollama the same conversation two ways, greedily:
 *
 *   A. /api/chat with the messages and think:false   → Ollama renders it
 *   B. /api/generate raw:true with renderSplenPrompt → we render it
 *
 * and requires identical replies on every case. A CONTROL rendering (ours minus
 * the empty think block) must diverge on some cases — if it never does, the
 * check has no power and its PASS means nothing.
 *
 * Run with the GPU otherwise idle (it loads the model into Ollama):
 *   node --experimental-strip-types scripts/finetune/check_render_parity.ts \
 *     --model splen:4b-run4 --data scripts/finetune/data/splen-v3.3 --n 30 --out <json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderSplenPrompt, type SplenTurn } from '../../src/main/splen/prompt.ts'

interface Row {
  id: string
  family: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const model = arg('model')
const dataDir = arg('data')
const n = Number(arg('n', '30'))
const out = arg('out', '')

// Greedy and short: identical prompts must give identical text; 64 tokens is
// enough for a one-token prompt difference to show.
const options = { temperature: 0, top_k: 1, seed: 1, num_predict: 64, num_ctx: 16384 }

function load(file: string): Row[] {
  return readFileSync(join(dataDir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
}

/** Spread the sample across files, families and conversation lengths. */
function sample(rows: Row[], count: number): Row[] {
  const step = Math.max(1, Math.floor(rows.length / count))
  return rows.filter((_, i) => i % step === 0).slice(0, count)
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

async function main(): Promise<void> {
  const rows = sample([...load('holdout-core.jsonl'), ...load('holdout-xmem.jsonl')], n)
  const results: Record<string, unknown>[] = []
  let same = 0
  let controlDiverged = 0

  for (const row of rows) {
    // Drop the target reply: ask the model for it.
    const convo = row.messages.slice(0, -1)
    const system = convo[0].content
    const turns = convo.slice(1) as SplenTurn[]

    const chat = await post('/api/chat', { model, messages: convo, think: false, stream: false, options })
    const a = String((chat.message as { content?: string })?.content ?? '')

    const ours = renderSplenPrompt(system, turns)
    const gen = await post('/api/generate', { model, prompt: ours, raw: true, stream: false, options })
    const b = String(gen.response ?? '')

    const control = ours.replace(/<think>\n\n<\/think>\n\n$/, '')
    const ctl = await post('/api/generate', { model, prompt: control, raw: true, stream: false, options })
    const c = String(ctl.response ?? '')

    const match = a === b
    if (match) same++
    if (c !== a) controlDiverged++
    results.push({
      id: row.id,
      family: row.family,
      turns: turns.length,
      match,
      controlDiverged: c !== a,
      chatPromptTokens: chat.prompt_eval_count,
      rawPromptTokens: gen.prompt_eval_count,
      ...(match ? {} : { chat: a, raw: b })
    })
    console.log(`${match ? 'SAME' : 'DIFF'}  control:${c !== a ? 'diverged' : 'same'}  ${row.id}`)
  }

  const summary = {
    model,
    cases: rows.length,
    identical: same,
    controlDiverged,
    verdict:
      same === rows.length && controlDiverged > 0
        ? 'PASS'
        : controlDiverged === 0
          ? 'NO POWER (control never diverged)'
          : 'FAIL'
  }
  console.log(JSON.stringify(summary))
  if (out) writeFileSync(out, JSON.stringify({ summary, options, results }, null, 2))
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1
}

void main()
