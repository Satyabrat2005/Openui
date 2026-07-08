/**
 * pipeline.ts — periodic local LoRA fine-tuning of the coding model (Task 4).
 *
 * What this is: OpenUI records every approved interaction as a training
 * trajectory (trainingStore.ts). When enough new, quality-scored data has
 * accumulated and the user is away, this pipeline fine-tunes a LoRA adapter for
 * the local coding model on THAT data, builds it into a versioned Ollama tag
 * (openui-qwen-coder:vN), and promotes it ONLY if it does not regress on a
 * held-out slice of the same corpus. Rejected candidates never touch the
 * active pointer — the last-known-good model keeps serving (that is the
 * auto-rollback). Checkpoints are versioned and never deleted.
 *
 * What this is NOT (honest positioning, keep it that way in all product copy):
 * a small local model fine-tuned on your history adapts to YOUR workflows —
 * your project names, your phrasing, your recurring tasks. It does not and
 * will not compete with frontier cloud models on general capability. The value
 * is personalisation and privacy (all of this stays on the machine), not raw
 * intelligence.
 *
 * Deliberately separate from improvement.ts / promptRefiner.ts (the prompt-level
 * feedback loop, which works today without any training and stays untouched).
 *
 * Gates, in order (all must pass before any heavy work starts):
 *   1. AI Improvement toggle on AND the explicit finetune_enabled opt-in —
 *      training downloads a multi-GB base model and occupies the GPU/CPU for a
 *      long time; nobody gets that surprise by default.
 *   2. ≥ MIN_INTERVAL_MS since the last attempt (success or not).
 *   3. ≥ MIN_EXAMPLES quality-scored trajectories, with ≥ MIN_NEW_EXAMPLES new
 *      ones since the last attempt.
 *   4. Ollama reachable.
 *
 * Sidecar: scripts/finetune/train_lora.py (transformers + peft). Its absence or
 * missing Python deps fail the run with a clear message — never a crash.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { database } from '../database'
import { isImprovementEnabled } from '../improvement'
import { getFinetuneRecords } from '../trainingStore'
import { withOllamaLock } from '../ollamaLock'
import { startRun } from '../runLog'
import { enqueue } from '../taskQueue'
import { splitDataset, evaluateModel, isPromotable } from './evaluator'
import {
  loadManifest,
  nextVersion,
  versionDir,
  recordCheckpoint,
  promote,
  reject,
  getActiveTag
} from './manifest'

const IS_WIN = process.platform === 'win32'

/** Ollama model the adapter sits on — matches agent.ts localCodeModel(). */
const BASE_OLLAMA_MODEL = process.env.OLLAMA_CODE_MODEL ?? 'qwen2.5-coder:7b'
/** HuggingFace id of the same weights, for the Python training side. */
const DEFAULT_HF_BASE = 'Qwen/Qwen2.5-Coder-7B-Instruct'
const TAG_PREFIX = 'openui-qwen-coder'

const MIN_EXAMPLES = 50
const MIN_NEW_EXAMPLES = 20
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000
const MIN_QUALITY = 3

const TRAIN_TIMEOUT_MS = 2 * 60 * 60 * 1000 // LoRA on a 7B model is slow on consumer hardware
const OLLAMA_CREATE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_PROC_OUTPUT = 64 * 1024

// Settings keys (settings DB). active_finetuned_model is read by agent.ts.
const S_ACTIVE_MODEL = 'active_finetuned_model'
const S_ENABLED = 'finetune_enabled'
const S_LAST_AT = 'last_finetune_at'
const S_LAST_COUNT = 'last_finetune_example_count'

function getSettingStr(key: string): string | null {
  try {
    const v: unknown = database.settings.getSetting(key)
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

function setSettingStr(key: string, value: string): void {
  try {
    database.settings.setSetting(key, value)
  } catch (err) {
    console.error('[finetune] failed to persist setting', key, err)
  }
}

function ollamaUrl(): string {
  return (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
}

async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Bounded subprocess (no shell): resolves with combined output, never rejects. */
function runProc(
  file: string,
  argv: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, argv, { cwd, windowsHide: true })
    } catch (err) {
      resolvePromise({ ok: false, output: err instanceof Error ? err.message : String(err) })
      return
    }
    let output = ''
    let settled = false
    let timedOut = false
    const append = (c: Buffer): void => {
      if (output.length < MAX_PROC_OUTPUT) output += c.toString('utf8')
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    const settle = (ok: boolean, extra = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok, output: `${extra}${output}`.trim().slice(0, MAX_PROC_OUTPUT) })
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(
        false,
        err.code === 'ENOENT' ? `"${file}" is not installed or not on PATH.\n` : `${err.message}\n`
      )
    })
    child.on('exit', (code) => {
      if (timedOut) settle(false, `Timed out after ${Math.round(timeoutMs / 60000)} min.\n`)
      else settle(code === 0)
    })
  })
}

/** Cheap pre-checks. Returns null when a pass should run, else the skip reason. */
export async function fineTuneSkipReason(): Promise<string | null> {
  if (!isImprovementEnabled()) return 'AI Improvement is disabled'
  if (getSettingStr(S_ENABLED) !== 'true') return 'local fine-tuning is not enabled (opt-in setting)'

  const lastAt = Number(getSettingStr(S_LAST_AT) ?? 0)
  if (Number.isFinite(lastAt) && Date.now() - lastAt < MIN_INTERVAL_MS) {
    return 'ran within the last 24 h'
  }

  let total = 0
  try {
    total = database.training.getStats().total
  } catch {
    return 'training store unavailable'
  }
  if (total < MIN_EXAMPLES) return `only ${total}/${MIN_EXAMPLES} training examples so far`
  const lastCount = Number(getSettingStr(S_LAST_COUNT) ?? 0)
  if (total - lastCount < MIN_NEW_EXAMPLES) {
    return `only ${total - lastCount}/${MIN_NEW_EXAMPLES} new examples since the last pass`
  }

  if (!(await isOllamaReachable())) return 'Ollama is not running'
  return null
}

let running = false

/**
 * Gate-check and, if due, run one fine-tuning pass on the 'finetune' queue
 * lane. Called opportunistically (scheduler, when the user is away). Cheap
 * when gated out; never throws.
 */
export function maybeRunFineTune(): void {
  if (running) return
  void fineTuneSkipReason().then((skip) => {
    if (skip) return
    if (running) return
    running = true
    enqueue('finetune', 'local LoRA fine-tune', () => runFineTunePass())
      .catch((err) => console.error('[finetune] pass failed:', err))
      .finally(() => {
        running = false
      })
  })
}

/** One complete fine-tune → build → eval → promote/reject pass. */
export async function runFineTunePass(): Promise<void> {
  const version = nextVersion()
  const tag = `${TAG_PREFIX}:v${version}`
  const dir = versionDir(version)
  const runLog = startRun('finetune', { version, tag, base: BASE_OLLAMA_MODEL })

  // Stamp the attempt up front so a crash mid-run cannot cause a retry storm.
  const records = getFinetuneRecords(MIN_QUALITY)
  setSettingStr(S_LAST_AT, String(Date.now()))
  try {
    setSettingStr(S_LAST_COUNT, String(database.training.getStats().total))
  } catch {
    /* stats already read once in the gate */
  }

  const fail = (note: string): void => {
    recordCheckpoint({
      version,
      tag,
      baseModel: BASE_OLLAMA_MODEL,
      createdAt: new Date().toISOString(),
      trainSize: 0,
      holdoutSize: 0,
      evalScore: null,
      baselineScore: null,
      status: 'failed',
      note: note.slice(0, 500)
    })
    runLog.end('failure', note.slice(0, 300))
  }

  try {
    const { train, holdout } = splitDataset(records)
    if (train.length < MIN_EXAMPLES - holdout.length || holdout.length < 4) {
      fail(`not enough scorable data (train ${train.length}, holdout ${holdout.length})`)
      return
    }

    mkdirSync(dir, { recursive: true })
    const trainFile = join(dir, 'train.jsonl')
    const holdoutFile = join(dir, 'holdout.jsonl')
    writeFileSync(trainFile, train.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    writeFileSync(holdoutFile, holdout.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    runLog.event('dataset', { train: train.length, holdout: holdout.length })

    // 1. Train the adapter (Python sidecar; transformers + peft).
    const script = join(app.getAppPath(), 'scripts', 'finetune', 'train_lora.py')
    const hfBase = getSettingStr('finetune_hf_base') ?? DEFAULT_HF_BASE
    const adapterDir = join(dir, 'adapter')
    runLog.event('train_start', { hfBase })
    const trainRes = await runProc(
      IS_WIN ? 'python' : 'python3',
      [script, '--base', hfBase, '--data', trainFile, '--out', adapterDir],
      dir,
      TRAIN_TIMEOUT_MS
    )
    if (!trainRes.ok) {
      fail(`training failed: ${trainRes.output.slice(-400)}`)
      return
    }
    runLog.event('train_done')

    // 2. Build a versioned Ollama model from base + adapter.
    writeFileSync(join(dir, 'Modelfile'), `FROM ${BASE_OLLAMA_MODEL}\nADAPTER ./adapter\n`, 'utf8')
    const createRes = await runProc(
      'ollama',
      ['create', tag, '-f', 'Modelfile'],
      dir,
      OLLAMA_CREATE_TIMEOUT_MS
    )
    if (!createRes.ok) {
      fail(`ollama create failed: ${createRes.output.slice(-400)}`)
      return
    }
    runLog.event('ollama_created', { tag })

    // 3. Held-out eval: candidate vs whatever is serving right now.
    const baselineTag = getActiveTag() ?? getSettingStr(S_ACTIVE_MODEL) ?? BASE_OLLAMA_MODEL
    const url = ollamaUrl()
    const { candidateScore, baselineScore } = await withOllamaLock(async () => {
      const candidateScore = await evaluateModel(url, tag, holdout)
      const baselineScore = await evaluateModel(url, baselineTag, holdout)
      return { candidateScore, baselineScore }
    })
    runLog.event('eval', { candidateScore, baselineScore, baselineTag })

    // 4. Promote only on no-regression; otherwise the candidate is rejected and
    //    the last-known-good model keeps serving (auto-rollback).
    recordCheckpoint({
      version,
      tag,
      baseModel: BASE_OLLAMA_MODEL,
      createdAt: new Date().toISOString(),
      trainSize: train.length,
      holdoutSize: holdout.length,
      evalScore: candidateScore,
      baselineScore,
      status: 'rejected', // flipped to active below iff promotable
      note: `baseline ${baselineTag}`
    })
    if (isPromotable(candidateScore, baselineScore)) {
      promote(version, candidateScore, baselineScore)
      setSettingStr(S_ACTIVE_MODEL, tag)
      runLog.end(
        'success',
        `promoted ${tag} (${candidateScore.toFixed(3)} vs ${baselineScore.toFixed(3)} ${baselineTag})`
      )
      console.log(
        `[finetune] ${tag} promoted — the local coding model now adapts to this user's workflows ` +
          `(personalisation, not frontier-model capability).`
      )
    } else {
      reject(
        version,
        'rejected',
        `held-out regression: ${candidateScore.toFixed(3)} < ${baselineScore.toFixed(3)} (${baselineTag})`,
        candidateScore,
        baselineScore
      )
      runLog.end(
        'failure',
        `rejected ${tag}: held-out ${candidateScore.toFixed(3)} vs baseline ${baselineScore.toFixed(3)} — keeping ${baselineTag}`
      )
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

/** Manifest summary for the UI/logs (read-only). */
export function getFineTuneStatus(): {
  activeTag: string | null
  versions: number
  enabled: boolean
} {
  const m = loadManifest()
  return {
    activeTag: getActiveTag(),
    versions: m.entries.length,
    enabled: getSettingStr(S_ENABLED) === 'true'
  }
}
