/**
 * pipeline.test.ts — the fine-tune pass's preconditions.
 *
 * This exists because of two bugs that made the LIVE pipeline (scheduler →
 * maybeRunFineTune) incapable of ever succeeding, while looking fine in review:
 *
 *   1. It invoked train_lora.py, which loads the base in bf16 (~15 GB for a 7B
 *      base) against the 8 GB card this project targets — guaranteed OOM, and
 *      only after downloading the whole base model.
 *   2. It wrote `ADAPTER ./adapter`, pointing at the peft save_pretrained()
 *      directory. Ollama rejects that. Reproduced on 0.31.2 against a real
 *      trained adapter: "Error: no Modelfile or safetensors files found" —
 *      despite adapter_model.safetensors sitting in that directory. Every pass
 *      that got that far discarded hours of training at the final step.
 *
 * The second one is the reason the GGUF converter is checked in
 * fineTuneSkipReason() — i.e. BEFORE the two-hour training budget is spent —
 * rather than being discovered at `ollama create`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings = new Map<string, unknown>()

vi.mock('electron', () => ({
  app: { getAppPath: () => 'C:/app' },
  BrowserWindow: class {}
}))
vi.mock('../database', () => ({
  database: {
    settings: {
      getSetting: (k: string) => settings.get(k) ?? null,
      setSetting: (k: string, v: unknown) => settings.set(k, v)
    },
    training: { getStats: () => ({ total: 500 }) }
  }
}))
vi.mock('../improvement', () => ({ isImprovementEnabled: () => true }))
vi.mock('../trainingStore', () => ({ getFinetuneRecords: () => [] }))
vi.mock('../ollamaLock', () => ({ withOllamaLock: (fn: () => unknown) => fn() }))
vi.mock('../runLog', () => ({
  startRun: () => ({ event: () => {}, end: () => {} })
}))
vi.mock('../taskQueue', () => ({ enqueue: async (_l: string, _n: string, fn: () => unknown) => fn() }))
vi.mock('./evaluator', () => ({
  splitDataset: () => ({ train: [], holdout: [] }),
  evaluateModel: async () => 1,
  isPromotable: () => true
}))
vi.mock('./manifest', () => ({
  loadManifest: () => ({ versions: [] }),
  nextVersion: () => 1,
  versionDir: () => 'C:/tmp/v1',
  recordCheckpoint: () => {},
  promote: () => {},
  reject: () => {},
  getActiveTag: () => null
}))

import { fineTuneSkipReason, GGUF_SETUP_HINT } from './pipeline'

let dir: string

beforeEach(() => {
  settings.clear()
  dir = mkdtempSync(join(tmpdir(), 'openui-llamacpp-'))
  // Reachable Ollama, so the skip reason under test is the one we mean.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })))
  delete process.env.LLAMACPP_DIR
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** Everything green except the thing each test is probing. */
function enableFineTuning(): void {
  settings.set('finetune_enabled', 'true')
  settings.set('last_finetune_at', '0')
  settings.set('last_finetune_example_count', '0')
}

describe('fineTuneSkipReason — GGUF converter precondition', () => {
  it('refuses to start a pass when llama.cpp is not configured', async () => {
    enableFineTuning()
    const reason = await fineTuneSkipReason()
    expect(reason).toBe(GGUF_SETUP_HINT)
  })

  // The point of checking early: training is a 2-hour budget, and without the
  // converter the run is thrown away at the very last step.
  it('names the real cause and the fix, not the misleading Ollama error', async () => {
    enableFineTuning()
    const reason = (await fineTuneSkipReason()) ?? ''
    expect(reason).toMatch(/GGUF/)
    expect(reason).toMatch(/llama\.cpp/)
    expect(reason).toMatch(/finetune_llamacpp_dir|LLAMACPP_DIR/)
    // Must NOT repeat Ollama's own misleading wording, which points at a file
    // that is actually present.
    expect(reason).not.toMatch(/no Modelfile or safetensors files found/)
  })

  it('does not skip once a real llama.cpp checkout is configured', async () => {
    enableFineTuning()
    writeFileSync(join(dir, 'convert_lora_to_gguf.py'), '# stub\n', 'utf8')
    settings.set('finetune_llamacpp_dir', dir)
    expect(await fineTuneSkipReason()).toBeNull()
  })

  it('rejects a configured directory that does not contain the converter', async () => {
    enableFineTuning()
    settings.set('finetune_llamacpp_dir', dir) // empty dir
    expect(await fineTuneSkipReason()).toBe(GGUF_SETUP_HINT)
  })

  it('accepts the LLAMACPP_DIR env var too', async () => {
    enableFineTuning()
    writeFileSync(join(dir, 'convert_lora_to_gguf.py'), '# stub\n', 'utf8')
    process.env.LLAMACPP_DIR = dir
    expect(await fineTuneSkipReason()).toBeNull()
  })

  // The earlier gates must still win, so the new check can't mask them.
  it('still reports the opt-in gate first', async () => {
    expect(await fineTuneSkipReason()).toMatch(/not enabled/)
  })
})

describe('the shipped trainer script', () => {
  // Guards bug 1: pipeline.ts must not invoke the deprecated bf16 trainer.
  it('is train_qlora.py, not the deprecated bf16 train_lora.py', () => {
    const src = readFileSync(join(__dirname, 'pipeline.ts'), 'utf8')
    expect(src).toContain("'train_qlora.py'")
    expect(src).not.toContain("'train_lora.py'")
  })

  // Guards bug 2: the Modelfile must never point ADAPTER at a directory again.
  it('never writes a directory-style ADAPTER line', () => {
    const src = readFileSync(join(__dirname, 'pipeline.ts'), 'utf8')
    expect(src).not.toContain('ADAPTER ./adapter\\n')
    expect(src).toMatch(/ADAPTER \$\{gguf\.path\}/)
  })
})
