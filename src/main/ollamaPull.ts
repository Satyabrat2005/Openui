/**
 * ollamaPull.ts — download a missing local model, with real progress.
 *
 * WHY THIS EXISTS. A user who installs OpenUI and Ollama but has never run
 * `ollama pull` had no working path through the app at all: the first turn
 * resolved to a model that isn't there, Ollama answered 404, and the chat showed
 * a raw error. The only fix was to leave the app, open a terminal, and wait out a
 * multi-gigabyte download with no indication that was even required. The app has
 * never called /api/pull anywhere — there was no code for this.
 *
 * Two things make this worth its own module rather than a few lines inline:
 *
 *   1. HONEST PROGRESS. A multi-gigabyte download behind a silent spinner is
 *      indistinguishable from a hang, which is exactly how it was reported. So the
 *      byte counts Ollama streams are forwarded to the renderer as real
 *      percentages, and the layer digest is included so a stalled layer is
 *      visible rather than looking like a frozen bar.
 *   2. ONE PULL AT A TIME. Several turns can discover the same missing model at
 *      once (the chat turn, the planner, the refiner). Without de-duplication they
 *      would each start their own download of the same multi-gigabyte blob.
 *
 * The progress math is pure and exported so it can be tested without a network.
 */
import type { BrowserWindow } from 'electron'
import { invalidateModelPoolCache } from './models'

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'

/** One progress line from Ollama's /api/pull NDJSON stream. */
export interface OllamaPullLine {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

/** What the renderer is told about an in-flight pull. */
export interface ModelPullProgress {
  model: string
  /** Ollama's own phase text, e.g. "pulling manifest", "verifying sha256 digest". */
  status: string
  /** 0–100 for the current layer, or null when this phase reports no byte counts. */
  percent: number | null
  /** Bytes done / total for the current layer, when known. */
  completed: number | null
  total: number | null
  /** Short layer id, so a stall is attributable to a specific layer. */
  layer: string | null
  done: boolean
  error?: string
}

/**
 * Turn one raw NDJSON line into a renderer-ready progress record.
 *
 * Ollama reports byte counts PER LAYER, and only for the download phases —
 * "pulling manifest" and "verifying sha256 digest" carry none. Computing a
 * percentage from a missing/zero total yields NaN or a bogus 0%, both of which
 * render as a bar that appears stuck, so those phases deliberately report
 * `percent: null` and the UI shows the phase text instead of a number.
 */
export function toPullProgress(model: string, line: OllamaPullLine): ModelPullProgress {
  const total = typeof line.total === 'number' && line.total > 0 ? line.total : null
  const completed = typeof line.completed === 'number' && line.completed >= 0 ? line.completed : null
  const percent =
    total !== null && completed !== null ? Math.min(100, Math.floor((completed / total) * 100)) : null
  return {
    model,
    status: line.status ?? '',
    percent,
    completed,
    total,
    layer: line.digest ? line.digest.replace(/^sha256:/, '').slice(0, 12) : null,
    done: line.status === 'success',
    ...(line.error ? { error: line.error } : {})
  }
}

/** Split a possibly-partial NDJSON chunk into whole lines plus a remainder. */
export function splitNdjson(buffered: string): { lines: OllamaPullLine[]; rest: string } {
  const parts = buffered.split('\n')
  // The last element is either an empty string (chunk ended on a newline) or a
  // partial line that must be carried into the next chunk.
  const rest = parts.pop() ?? ''
  const lines: OllamaPullLine[] = []
  for (const p of parts) {
    const t = p.trim()
    if (!t) continue
    try {
      lines.push(JSON.parse(t) as OllamaPullLine)
    } catch {
      // A malformed line is not worth failing a multi-gigabyte download over.
    }
  }
  return { lines, rest }
}

/** Human-readable byte size for the progress label. */
export function formatBytes(n: number | null): string {
  if (n === null) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

/** In-flight pulls, keyed by model, so concurrent callers share one download. */
const inFlight = new Map<string, Promise<void>>()

/** Exported for tests. */
export function clearInFlightPullsForTests(): void {
  inFlight.clear()
}

function emit(win: BrowserWindow | null, channel: string, payload: unknown): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  } catch {
    /* renderer gone — a pull is still worth finishing */
  }
}

/**
 * Download `model`, streaming progress to the renderer. Resolves when the model
 * is available; rejects with an actionable message if the download fails.
 *
 * Concurrent calls for the same model share one download.
 */
export function pullModel(win: BrowserWindow | null, model: string): Promise<void> {
  const existing = inFlight.get(model)
  if (existing) return existing

  const run = (async (): Promise<void> => {
    emit(win, 'openui:model:pull', {
      model,
      status: 'starting download',
      percent: null,
      completed: null,
      total: null,
      layer: null,
      done: false
    } satisfies ModelPullProgress)

    const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true })
    })

    if (!res.ok || !res.body) {
      throw new Error(
        `Could not start downloading "${model}" (Ollama replied ${res.status}). ` +
          `Check the model name, or run \`ollama pull ${model}\` in a terminal.`
      )
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    let lastError: string | null = null
    let sawSuccess = false

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      const { lines, rest } = splitNdjson(buffered)
      buffered = rest
      for (const line of lines) {
        if (line.error) lastError = line.error
        const progress = toPullProgress(model, line)
        if (progress.done) sawSuccess = true
        emit(win, 'openui:model:pull', progress)
      }
    }

    if (lastError) {
      throw new Error(`Downloading "${model}" failed: ${lastError}`)
    }
    if (!sawSuccess) {
      // The stream ended without Ollama saying "success" — treat as a failure
      // rather than reporting a model we cannot prove is usable.
      throw new Error(
        `The download of "${model}" ended before completing. Check your connection and try again, ` +
          `or run \`ollama pull ${model}\` in a terminal.`
      )
    }

    // The freshly pulled model must become visible immediately, or the very turn
    // that triggered this pull still sees it as missing.
    invalidateModelPoolCache()
    emit(win, 'openui:model:pull', {
      model,
      status: 'ready',
      percent: 100,
      completed: null,
      total: null,
      layer: null,
      done: true
    } satisfies ModelPullProgress)
  })()

  inFlight.set(model, run)
  // Clear the slot whether it succeeded or failed, so a retry can start fresh.
  void run.catch(() => undefined).finally(() => inFlight.delete(model))
  return run
}
