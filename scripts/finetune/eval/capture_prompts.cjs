/**
 * __capture_prompts.cjs — drive the REAL Electron app over the 44-case eval set
 * and capture the system prompt it actually builds for each one.
 *
 * Why the real app and not a reconstruction: the whole point of the eval harness
 * is fidelity. The prompt depends on runtime state the tests cannot see (GitHub /
 * Figma token presence, the refiner's stored prompt, MCP servers, the few-shot
 * block). Rebuilding it here would drift from what ships — the exact class of bug
 * this phase is chasing.
 *
 * SAFETY: run the capture proxy in --stub mode. The eval set contains "send an
 * email to my manager" and "message Ashu on WhatsApp"; with a stub the model
 * never returns a tool call, so the agent loop ends each turn without acting and
 * nothing is sent to anyone. Do NOT run this against a real model.
 *
 *   1. node ollama-capture-proxy.cjs 11435 http://127.0.0.1:11434 --stub
 *   2. node capture_prompts.cjs <outDir>
 *   3. python run_eval.py --model <m> --label <l> --prompt-dir <outDir>
 *
 * NOT a throwaway: run_eval.py's --prompt-dir has no other source of per-case
 * prompts, so this is now part of the eval pipeline. The app builds a different
 * tool surface per request (see src/main/toolGroups.ts), which is why a single
 * replayed prompt is no longer a faithful measurement.
 */
const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const OUT_DIR = process.argv[2] || path.join(__dirname, 'captured-prompts')
const EVAL = require('./evalset.json')
const CAPTURES = path.join(__dirname, 'captures.jsonl')

function readCaptures() {
  if (!fs.existsSync(CAPTURES)) return []
  return fs
    .readFileSync(CAPTURES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

;(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const startLines = readCaptures().length
  console.log(`[drive] captures.jsonl already has ${startLines} line(s); ignoring those.`)

  const app = await _electron.launch({
    args: ['.'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Everything the app generates goes through the stub proxy.
      OLLAMA_HOST: 'http://127.0.0.1:11435',
      // Keep the run hermetic: no telemetry, no cloud.
      OPENUI_ENABLE_CLOUD: '0',
      // MATCH THE BASELINE'S TOOL SURFACE. The prompt injects GitHub schemas on
      // token PRESENCE, not validity, and the #160 baseline prompt was captured
      // on a session that had a GitHub token but no Figma one (124 tools = 133
      // minus the 9 figma). Without this the 5 gh-* cases have no GitHub tool in
      // the prompt at all and score as regressions that have nothing to do with
      // the shrink. Never used for a request: the eval only parses replies.
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || 'eval-surface-parity-not-a-real-token'
    }
  })

  // The app is a tray app, so its window starts hidden.
  const win = await app.firstWindow()
  await app.evaluate(async ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show()
  })
  await win.waitForLoadState('domcontentloaded')
  // Give the renderer time to expose window.api and finish first paint.
  await win.waitForTimeout(3000)

  const probe = await win.evaluate(() => ({
    keys: Object.keys(window).filter((k) => /openui|api/i.test(k)),
    hasChat: typeof window.openui?.chat === 'function'
  }))
  console.log(`[drive] bridge keys: ${probe.keys.join(', ')} | openui.chat: ${probe.hasChat}`)
  if (!probe.hasChat) {
    console.error('[drive] preload API missing — cannot drive chat.')
    await app.close()
    process.exit(1)
  }

  const cases = EVAL.cases
  const results = []

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    // EVERY case must start from a clean conversation. Without this the 44 turns
    // pile into one thread: the tool-group classifier sees the previous cases'
    // user turns, `history` keeps growing, and an active build session makes
    // later cases match isBuildFollowUp. All three make the captured prompt a
    // function of case ORDER — not comparable with the baseline, where every
    // case was scored against the same standalone prompt.
    await win.evaluate(() => window.openui.clearHistory())
    await win.waitForTimeout(150)

    const before = readCaptures().length
    // Fire the same IPC the composer uses. 'free' is the default local tier.
    await win.evaluate((msg) => window.openui.chat(msg, 'free'), c.prompt)

    // Wait until the proxy has logged at least one new /api/chat for this turn.
    let waited = 0
    let lines = readCaptures()
    while (lines.length === before && waited < 25000) {
      await win.waitForTimeout(250)
      waited += 250
      lines = readCaptures()
    }
    // Let any follow-on calls for the same turn land too.
    await win.waitForTimeout(600)
    lines = readCaptures()

    const fresh = lines.slice(before)
    // The chat turn is the capture whose last user message is this case's prompt.
    // Other captures in the window (planner, scoring) are for the same text but
    // carry a different, much smaller system prompt — pick the biggest match,
    // which is always the agent's own.
    const mine = fresh
      .filter((r) => (r.messages || []).some((m) => m.role === 'user' && m.content.includes(c.prompt.slice(0, 40))))
      .sort((a, b) => b.systemChars - a.systemChars)
    const chosen = mine[0] || fresh.sort((a, b) => b.systemChars - a.systemChars)[0]

    if (!chosen || !chosen.systemPrompt) {
      console.log(`[${String(i + 1).padStart(2)}/${cases.length}] ${c.id.padEnd(9)} NO CAPTURE (${fresh.length} fresh)`)
      results.push({ id: c.id, ok: false, freshCount: fresh.length })
      continue
    }

    fs.writeFileSync(path.join(OUT_DIR, `${c.id}.txt`), chosen.systemPrompt, 'utf8')
    const tools = (chosen.systemPrompt.match(/^- [a-z0-9_]+\(/gm) || []).length
    console.log(
      `[${String(i + 1).padStart(2)}/${cases.length}] ${c.id.padEnd(9)} ` +
        `chars=${String(chosen.systemChars).padStart(6)} tools=${String(tools).padStart(3)} ` +
        `num_ctx=${chosen.options && chosen.options.num_ctx} model=${chosen.model}`
    )
    results.push({
      id: c.id,
      ok: true,
      chars: chosen.systemChars,
      tools,
      numCtx: chosen.options && chosen.options.num_ctx,
      model: chosen.model
    })
  }

  fs.writeFileSync(path.join(OUT_DIR, '_capture-report.json'), JSON.stringify(results, null, 2), 'utf8')

  const ok = results.filter((r) => r.ok)
  const chars = ok.map((r) => r.chars).sort((a, b) => a - b)
  const ctxs = [...new Set(ok.map((r) => r.numCtx))].sort((a, b) => a - b)
  console.log('\n=== capture summary ===')
  console.log(`captured   : ${ok.length}/${cases.length}`)
  if (chars.length) {
    console.log(`system size: ${chars[0]}–${chars[chars.length - 1]} chars ` +
      `(~${Math.ceil(chars[0] / 4)}–${Math.ceil(chars[chars.length - 1] / 4)} tokens)`)
    console.log(`tools/prompt: ${Math.min(...ok.map((r) => r.tools))}–${Math.max(...ok.map((r) => r.tools))}`)
  }
  console.log(`num_ctx seen: ${ctxs.join(', ')}`)
  console.log(`wrote        ${OUT_DIR}`)

  await app.close()
  process.exit(0)
})().catch(async (err) => {
  console.error('[drive] fatal:', err)
  process.exit(1)
})
