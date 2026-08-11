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
 * Usage: node ollama-capture-proxy.cjs [listenPort] [upstream]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || 11435)
const UPSTREAM = process.argv[3] || 'http://127.0.0.1:11434'
const OUT = path.join(__dirname, 'captures.jsonl')

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
})
