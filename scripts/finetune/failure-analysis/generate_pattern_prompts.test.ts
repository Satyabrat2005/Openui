/**
 * generate_pattern_prompts.test.ts — emit the system prompts for the candidate
 * turns in pattern-cases.json using the APP'S OWN builder.
 *
 * Not a test: a generator, run under Vitest for the same reason
 * scripts/benchmark/generate_prompts.test.ts is — buildDefaultSystemPrompt and
 * selectToolGroups live in agent.ts / toolGroups.ts, which pull in electron and
 * the native SQLite binding that plain Node cannot load.
 *
 * WHY THIS RATHER THAN HAND-WRITTEN PROMPTS. The app builds a different tool
 * surface per request (selectToolGroups). A hand-written prompt would be a
 * prompt no real turn ever sees, and a fine-tune trained on it would be trained
 * for a distribution the product does not produce. The three failures this is
 * collecting for are all surface-dependent — P3 exists ONLY because a group the
 * request needs is absent from the surface — so generating them any other way
 * would destroy the thing under study.
 *
 * Run:
 *   npx vitest run --config scripts/finetune/failure-analysis/vitest.gen.config.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, 'prompts')

// Same mocks as the benchmark generator: electron and the native DB binding
// cannot load under a plain-Node runner. None of this affects the prompt TEXT.
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

interface MemRow {
  channel: string
  subject_label: string
  age: string
  summary: string
}
interface PatternCase {
  id: string
  pattern: string
  prompt: string
  memory?: string
}

describe('failure-pattern prompt generation', () => {
  it("writes one system prompt per candidate turn using the app's own builder", async () => {
    const spec = JSON.parse(readFileSync(join(HERE, 'pattern-cases.json'), 'utf-8')) as {
      cases: PatternCase[]
      memory_blocks: Record<string, MemRow[]>
    }

    const { buildDefaultSystemPrompt } = await import('../../../src/main/agent')
    const { selectToolGroups } = await import('../../../src/main/toolGroups')
    const { renderMemoryBlock } = await import('../../../src/main/channelMemory')

    mkdirSync(OUT_DIR, { recursive: true })
    const manifest: Array<{
      id: string
      pattern: string
      groups: string[]
      chars: number
      hasMemory: boolean
      // Recorded so the collector can tell a "the tool was absent" failure from
      // a "the tool was there and it still went wrong" failure. For P3 the whole
      // point is that the needed group is NOT selected.
      toolNames: string[]
    }> = []

    for (const c of spec.cases) {
      const groups = selectToolGroups(c.prompt)
      let prompt = buildDefaultSystemPrompt(groups)

      if (c.memory) {
        const rows = spec.memory_blocks[c.memory]
        if (!rows) throw new Error(`${c.id}: unknown memory block ${c.memory}`)
        // Frozen clock, same convention as the benchmark generator, so a rerun
        // tomorrow produces byte-identical prompts.
        const now = 1_700_000_000
        prompt += renderMemoryBlock(
          rows.map((m, i) => ({
            id: `m${i}`,
            subject_key: m.subject_label.toLowerCase(),
            subject_label: m.subject_label,
            channel: m.channel,
            action: `send_${m.channel}_message`,
            direction: 'sent',
            summary: m.summary,
            created_at: now - 3600
          })),
          now
        )
      }

      writeFileSync(join(OUT_DIR, `${c.id}.txt`), prompt, 'utf-8')
      manifest.push({
        id: c.id,
        pattern: c.pattern,
        groups: [...groups].sort(),
        chars: prompt.length,
        hasMemory: Boolean(c.memory),
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
      expect(m.toolNames.length, `${m.id} has no tool list`).toBeGreaterThan(5)
    }
    // eslint-disable-next-line no-console
    console.log(
      `\nwrote ${manifest.length} prompts to ${OUT_DIR}\n` +
        manifest
          .map(
            (m) =>
              `  ${m.id.padEnd(10)} ${m.pattern.padEnd(24)} ${String(m.chars).padStart(6)} chars  ` +
              `${String(m.toolNames.length).padStart(2)} tools  [${m.groups.join(' ')}]`
          )
          .join('\n')
    )
  }, 120_000)
})
