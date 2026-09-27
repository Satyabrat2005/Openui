/**
 * splen_inapp_server.ts — serve the in-app Splen engine on Ollama's /api/chat,
 * so safety-gate/v2/run_gate_v2.py can measure it without changing a line.
 *
 * Every Splen gate number before v7.4.0 was taken through Ollama. The app now
 * runs Splen itself (src/main/splen), so the gate has to be re-run on THAT
 * engine. This server loads the production backend (llamaCppBackend.ts) and the
 * production prompt renderer (prompt.ts) — not copies — and answers the gate's
 * requests with them:
 *
 *   node --experimental-strip-types scripts/finetune/splen_inapp_server.ts --model <gguf> [--port 11500]
 *   python scripts/finetune/safety-gate/v2/run_gate_v2.py --subject ollama:splen:4b-ckpt40 \
 *     --host http://127.0.0.1:11500 --seeds 1,2,3 --split all --out <json>
 *
 * The gate's num_ctx (sized like resolveNumCtx), seed and num_predict are
 * honoured; everything else — prompt format, sampling — is what the app uses.
 * Requests are answered one at a time, like the app's shared lock.
 */
import { register } from 'node:module'
import { createServer } from 'node:http'

register('../acceptance/ts-resolve-hook.mjs', import.meta.url)

const { createLlamaCppBackend } = await import('../../src/main/splen/llamaCppBackend.ts')
const { renderSplenPrompt } = await import('../../src/main/splen/prompt.ts')

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

const modelPath = arg('model')
const port = Number(arg('port', '11500'))
const backend = await createLlamaCppBackend(modelPath)
console.log(`[splen-inapp] loaded ${modelPath}`)

let queue: Promise<unknown> = Promise.resolve()
let served = 0

interface ChatBody {
  model?: string
  messages?: { role: string; content: string }[]
  options?: { seed?: number; num_ctx?: number; num_predict?: number }
}

async function answer(body: ChatBody): Promise<string> {
  const messages = body.messages ?? []
  const system = messages[0]?.role === 'system' ? messages[0].content : ''
  const turns = messages
    .slice(messages[0]?.role === 'system' ? 1 : 0)
    .map((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') throw new Error(`unsupported role ${m.role}`)
      return { role: m.role as 'user' | 'assistant', content: m.content }
    })
  return backend.generate({
    prompt: renderSplenPrompt(system, turns),
    contextSize: body.options?.num_ctx ?? 8192,
    seed: body.options?.seed,
    maxTokens: body.options?.num_predict && body.options.num_predict > 0 ? body.options.num_predict : undefined,
    onText: () => {}
  })
}

createServer((req, res) => {
  const send = (status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  if (req.method === 'GET' && req.url === '/api/version') return send(200, { version: 'splen-inapp' })
  if (req.method !== 'POST' || req.url !== '/api/chat') return send(404, { error: 'not found' })
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const run = queue.then(async () => {
      const body = JSON.parse(raw) as ChatBody
      const content = await answer(body)
      served++
      send(200, { model: body.model, message: { role: 'assistant', content }, done: true })
    })
    queue = run.catch((err) => {
      console.error('[splen-inapp] request failed:', err)
      send(500, { error: String(err instanceof Error ? err.message : err) })
    })
  })
}).listen(port, '127.0.0.1', () => console.log(`[splen-inapp] listening on 127.0.0.1:${port}`))

process.on('SIGINT', async () => {
  console.log(`[splen-inapp] served ${served}; unloading`)
  await backend.dispose()
  process.exit(0)
})
