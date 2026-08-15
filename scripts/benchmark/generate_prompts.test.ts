/**
 * generate_prompts.test.ts — emit the per-case system prompts the benchmark runs.
 *
 * Not a test: a generator that happens to run under Vitest, because that is the
 * only way to import the app's REAL prompt builder (agent.ts pulls in electron
 * and the native SQLite binding, which plain Node cannot load). Run it with:
 *
 *   npx vitest run --dir scripts/benchmark
 *
 * Why generate rather than hand-write: the app builds a DIFFERENT tool surface
 * per request (selectToolGroups in toolGroups.ts), so one shared prompt would
 * not be the prompt any real turn sees. Reconstructing that by hand is exactly
 * the drift the eval harness README warns about. This calls the same two
 * functions the app calls, so a tool added or regrouped tomorrow shows up here.
 *
 * Difference from the fine-tune harness's capture_prompts.cjs, stated plainly:
 * that one drives the packaged Electron app and captures what crosses the wire,
 * which also picks up runtime state (a refiner-stored prompt, connected MCP
 * servers, the few-shot block). This calls the builder directly, so it reflects
 * a FRESH install with no tokens, no MCP and no learned prompt. That is the
 * right baseline for a published benchmark — it is the state a reader can
 * reproduce — but it is not identical to a long-lived install.
 *
 * Every system in the benchmark is handed the byte-identical prompt this
 * writes, so any accuracy difference is the model, not the prompt.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, 'prompts')

// electron and the native DB binding cannot load under a plain-Node runner.
// Nothing below affects the prompt TEXT — the tool schemas are imported for
// real, which is the whole point of generating rather than hand-writing.
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

interface BenchCase {
  id: string
  category: string
  prompt: string
  memory?: Array<{ channel: string; subject_label: string; age: string; summary: string }>
}

describe('benchmark prompt generation', () => {
  it('writes one system prompt per case using the app\'s own builder', async () => {
    const taskset = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync(join(HERE, 'taskset.json'), 'utf-8'))
    ) as { cases: BenchCase[] }

    const { buildDefaultSystemPrompt } = await import('../../src/main/agent')
    const { selectToolGroups } = await import('../../src/main/toolGroups')
    const { renderMemoryBlock } = await import('../../src/main/channelMemory')

    mkdirSync(OUT_DIR, { recursive: true })
    const manifest: Array<{ id: string; groups: string[]; chars: number; hasMemory: boolean }> = []

    for (const c of taskset.cases) {
      const groups = selectToolGroups(c.prompt)
      let prompt = buildDefaultSystemPrompt(groups)

      // Memory cases carry a fixed, published memory block so the fact under
      // test is identical for every system. Ages are frozen strings rather than
      // computed, so a rerun tomorrow produces the same bytes.
      if (c.memory?.length) {
        const now = 1_700_000_000
        const rows = c.memory.map((m, i) => ({
          id: `m${i}`,
          subject_key: m.subject_label.toLowerCase(),
          subject_label: m.subject_label,
          channel: m.channel,
          action: 'send_whatsapp_message',
          direction: 'sent',
          summary: m.summary,
          created_at: now - 3600
        }))
        prompt += renderMemoryBlock(rows, now)
      }

      writeFileSync(join(OUT_DIR, `${c.id}.txt`), prompt, 'utf-8')
      manifest.push({
        id: c.id,
        groups: [...groups].sort(),
        chars: prompt.length,
        hasMemory: Boolean(c.memory?.length)
      })
    }

    writeFileSync(
      join(OUT_DIR, 'manifest.json'),
      JSON.stringify({ generated: new Date().toISOString(), prompts: manifest }, null, 2),
      'utf-8'
    )

    expect(manifest).toHaveLength(taskset.cases.length)
    // A prompt that lost its tool list would score every system as failing.
    for (const m of manifest) expect(m.chars, `${m.id} prompt is suspiciously short`).toBeGreaterThan(1000)
    // eslint-disable-next-line no-console
    console.log(
      `\nwrote ${manifest.length} prompts to ${OUT_DIR}\n` +
        manifest.map((m) => `  ${m.id.padEnd(10)} ${String(m.chars).padStart(6)} chars  [${m.groups.join(' ')}]`).join('\n')
    )
  }, 120_000)
})
