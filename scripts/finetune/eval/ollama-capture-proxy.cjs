/**
 * ollama-capture-proxy.cjs — transparent Ollama proxy that records exactly what
 * the real OpenUI app sends.
 *
 * Why this exists: the eval needs the REAL system prompt (all tool schemas, the
 * real trimming rules, the real num_ctx the app resolved) — not a
 * reconstruction. Reconstructions drift silently the moment a tool is added,
 * which is the exact class of bug this whole phase is chasing.
 *
 * Run it, point the app at it (OLLAMA_HOST=http://127.0.0.1:11435), and every
 * /api/chat body is appended to captures.jsonl before being forwarded upstream
 * untouched. The app behaves normally; we just get a faithful copy.
 *
 * STUB MODE (--stub): capture the request and answer it here with a canned,
 * harmless plain-text reply instead of forwarding it upstream.
 *
 * This is what makes capturing the eval prompts SAFE. The eval set deliberately
 * contains "send an email to my manager" and "message Ashu on WhatsApp"; if the
 * real model answered those while driving the real app, the app would do exactly
 * as asked and send real messages to real people. A stub reply is plain prose, so
 * the tool-call parser finds nothing, the agent loop ends the turn, and no tool
 * ever runs — while the system prompt we came for is captured verbatim.
 *
 * Usage: node ollama-capture-proxy.cjs [listenPort] [upstream] [--stub]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const STUB = argv.includes('--stub')
const positional = argv.filter((a) => !a.startsWith('--'))
const PORT = Number(positional[0] || 11435)
const UPSTREAM = positional[1] || 'http://127.0.0.1:11434'
const OUT = path.join(__dirname, 'captures.jsonl')

/** Deliberately tool-free so the agent loop finishes the turn without acting. */
const STUB_REPLY = 'Noted — nothing to do for this one.'

/**
 * Answer /api/chat locally in the Ollama wire format. Streaming or not is chosen
 * by the caller's own `stream` flag, because the app streams and the plain
 * callers (subagents, planner) do not.
 */
function respondStub(res, model, streaming) {
  const now = new Date().toISOString()
  if (!streaming) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        model,
        created_at: now,
        message: { role: 'assistant', content: STUB_REPLY },
        done: true,
        done_reason: 'stop'
      })
    )
    return
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.write(
    JSON.stringify({
      model,
      created_at: now,
      message: { role: 'assistant', content: STUB_REPLY },
      done: false
    }) + '\n'
  )
  res.end(
    JSON.stringify({
      model,
      created_at: now,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop'
    }) + '\n'
  )
}

const up = new URL(UPSTREAM)

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)

    if (req.url && req.url.includes('/api/chat')) {
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        const sys = (parsed.messages || []).find((m) => m.role === 'system')
        fs.appendFileSync(
          OUT,
          JSON.stringify({
            at: new Date().toISOString(),
            model: parsed.model,
            options: parsed.options,
            think: parsed.think,
            systemPrompt: sys ? sys.content : null,
            systemChars: sys ? sys.content.length : 0,
            messages: (parsed.messages || []).map((m) => ({
              role: m.role,
              content: m.content.slice(0, 2000)
            }))
          }) + '\n',
          'utf8'
        )
        console.log(
          `[capture] model=${parsed.model} num_ctx=${parsed.options && parsed.options.num_ctx} ` +
            `systemChars=${sys ? sys.content.length : 0}`
        )
      } catch (err) {
        console.error('[capture] could not parse body:', err.message)
      }
    }

    // Stub only the generation endpoint. Everything else (/api/tags, /api/ps,
    // /api/show) must stay real, or the app's model-resolution and
    // is-Ollama-running probes fail and it never gets as far as a chat turn.
    if (STUB && req.url && req.url.includes('/api/chat')) {
      let streaming = true
      let model = 'stub'
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        streaming = parsed.stream !== false
        model = parsed.model || model
      } catch {
        /* fall through with defaults */
      }
      console.log(`[stub] answered /api/chat (stream=${streaming}) without forwarding`)
      respondStub(res, model, streaming)
      return
    }

    const proxied = http.request(
      {
        hostname: up.hostname,
        port: up.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${up.hostname}:${up.port || 80}` }
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 200, upRes.headers)
        upRes.pipe(res)
      }
    )
    proxied.on('error', (err) => {
      console.error('[proxy] upstream error:', err.message)
      if (!res.headersSent) res.writeHead(502)
      res.end(JSON.stringify({ error: String(err) }))
    })
    if (body.length) proxied.write(body)
    proxied.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`)
  console.log(`[proxy] writing captures to ${OUT}`)
  if (STUB) {
    console.log('[proxy] STUB MODE: /api/chat is answered locally; no tool call can be produced,')
    console.log('[proxy]            so driving the app over the eval set sends nothing to anyone.')
  }
})
