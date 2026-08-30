/**
 * generate_safety_prompts.test.ts — emit the system prompts the safety gate runs.
 *
 * Not a test: a generator, run under Vitest for the same reason the benchmark's
 * and the failure-analysis one are — buildDefaultSystemPrompt and
 * selectToolGroups live behind electron and the native SQLite binding.
 *
 * The gate MUST use the app's real prompts. Its whole claim is "this model is
 * safe in the product", and a model graded against a hand-written prompt has
 * been graded in a situation the product never creates — including the
 * UNTRUSTED CONTENT rule and the sensitive-action hard rules, which are exactly
 * what the adversarial cases are trying to get past.
 *
 * Run:
 *   npx vitest run --config scripts/finetune/safety-gate/vitest.gen.config.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, 'prompts')

vi.mock('electron', () => ({
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0', getPath: () => HERE },
  shell: {},
  dialog: {},
  desktopCapturer: {},
  systemPreferences: {},
  Notification: class {},
  clipboard: {},
  nativeImage: { createFromPath: () => ({}) },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) }
}))
vi.mock('./src/main/database/init', () => ({ getDb: () => null, initDb: () => null }))

interface SafetyCase {
  id: string
  prompt: string
  turns?: Array<{ role: string; content: string }>
}

describe('safety-gate prompt generation', () => {
  it("writes one system prompt per safety case using the app's own builder", async () => {
    const spec = JSON.parse(
      readFileSync(join(HERE, 'safety-cases.json'), 'utf-8')
    ) as { cases: SafetyCase[] }

    const { buildDefaultSystemPrompt } = await import('../../../src/main/agent')
    const { selectToolGroups } = await import('../../../src/main/toolGroups')

    mkdirSync(OUT_DIR, { recursive: true })
    const manifest: Array<{ id: string; groups: string[]; chars: number; toolNames: string[] }> = []

    for (const c of spec.cases) {
      // Selection sees the whole conversation the app would have routed on, not
      // just the opening line: an injection that arrives in a later turn must be
      // graded on the surface that turn would really have had.
      const routingText = [c.prompt, ...(c.turns ?? []).map((t) => t.content)].join('\n')
      const groups = selectToolGroups(routingText)
      const prompt = buildDefaultSystemPrompt(groups)
      writeFileSync(join(OUT_DIR, `${c.id}.txt`), prompt, 'utf-8')
      manifest.push({
        id: c.id,
        groups: [...groups].sort(),
        chars: prompt.length,
        toolNames: [...prompt.matchAll(/^- ([a-z_0-9]+)\(/gm)].map((m) => m[1])
      })
    }

    writeFileSync(
      join(OUT_DIR, 'manifest.json'),
      JSON.stringify({ generated: new Date().toISOString(), prompts: manifest }, null, 2),
      'utf-8'
    )

    expect(manifest).toHaveLength(spec.cases.length)
    for (const m of manifest) {
      expect(m.chars, `${m.id} prompt is suspiciously short`).toBeGreaterThan(1000)
    }
    // The gate's premise is that these rules are present to be got past. If a
    // refactor ever drops one, the gate would start passing everything for the
    // wrong reason — so assert on the text rather than trusting it.
    for (const m of manifest) {
      const text = readFileSync(join(OUT_DIR, `${m.id}.txt`), 'utf-8')
      expect(text, `${m.id}: UNTRUSTED CONTENT rule missing`).toContain('UNTRUSTED CONTENT')
      expect(text, `${m.id}: sensitive-action hard rule missing`).toContain('Sensitive actions')
    }
    // eslint-disable-next-line no-console
    console.log(
      `\nwrote ${manifest.length} prompts to ${OUT_DIR}\n` +
        manifest
          .map(
            (m) =>
              `  ${m.id.padEnd(16)} ${String(m.chars).padStart(6)} chars  ` +
              `${String(m.toolNames.length).padStart(2)} tools  [${m.groups.join(' ')}]`
          )
          .join('\n')
    )
  }, 120_000)
})
