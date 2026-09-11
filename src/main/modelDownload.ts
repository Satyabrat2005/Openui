/**
 * modelDownload.ts — the app-side "Download model" path.
 *
 * `ollamaPull.pullModel` already streams a real, byte-accurate download. What it
 * does not do is answer the questions a *user-initiated* download raises, and
 * those are the ones that decide whether the feature is usable without a
 * terminal:
 *
 *   • Is this person allowed to download a model at all? (a session is required)
 *   • Is the local engine even installed / running? (the most common failure,
 *     and the one most likely to send someone to a terminal if handled badly)
 *   • Did it fail because the disk is full, the network dropped, or the model
 *     name is wrong? Each of those needs its own message — "download failed"
 *     tells a user nothing they can act on.
 *   • Is a download for this model already running?
 *
 * TERMINAL BOUNDARY. No message produced here may contain a shell command. When
 * Ollama itself is missing we hand back an installer URL for the UI to open —
 * we do NOT silently install it (that is real scope of its own) and we do not
 * fall back to "run this in your terminal".
 *
 * HONEST SCOPE. Gating the download behind a session is a UX boundary, not
 * enforcement: anyone with admin rights on their own machine can install a model
 * outside this app. What this guarantees is that OpenUI never requires, shows,
 * or documents a terminal to get one.
 *
 * The classification is pure and exported so every branch is testable without a
 * network, a daemon, or a multi-gigabyte download.
 */
import type { BrowserWindow } from 'electron'
import { isPullInFlight, pullModel } from './ollamaPull'
import { DEFAULT_CODE_MODEL, DEFAULT_GENERAL_MODEL, getAvailableModels } from './models'
import { hasAccountSession } from './auth/sessionManager'

/** Where a user is sent to install the local engine, if they don't have it. */
export const OLLAMA_INSTALL_URL = 'https://ollama.com/download'

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'

/**
 * The models OpenUI runs locally today. This is an allowlist, not a suggestion
 * list: an arbitrary string arriving over IPC must never be handed to the pull
 * endpoint, and the UI has no reason to offer anything the app doesn't route to.
 * Sizes are approximate and labelled as such — an exact figure we can't verify
 * before the download starts would be a fabricated number.
 */
export interface CatalogModel {
  id: string
  label: string
  /** What this model is used for, in the user's terms. */
  purpose: string
  /** Approximate download size, for setting expectations before a long wait. */
  approxSize: string
}

/**
 * Sizes are the real model-layer size from the Ollama registry manifest, not an
 * estimate. Verified 2026-09-11. `about 2 GB` shipped here previously and was
 * wrong by 3.3x for the default model, which is the worst place to be wrong: it
 * is the first download a new user starts, and someone on a metered or slow
 * connection consented to a figure that was not real.
 *
 * Re-derive before changing a tag — these move when upstream repoints `latest`:
 *
 *   curl -s -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
 *     https://registry.ollama.ai/v2/library/<name>/manifests/<tag> \
 *     | jq '.layers[] | select(.mediaType | endswith(".model")) | .size'
 *
 * The number shown *during* the download comes from Ollama's own byte counts
 * (see ollamaPull.ts) and is always live; only this pre-download figure is
 * static.
 */
export const MODEL_LAYER_BYTES: Record<string, number> = {
  [DEFAULT_GENERAL_MODEL]: 6_594_462_816,
  [DEFAULT_CODE_MODEL]: 4_683_074_048
}

/**
 * Render a byte count as the figure shown before a download starts.
 *
 * The label is DERIVED from the byte count rather than written beside it, so a
 * corrected manifest size cannot leave a stale string behind — which is exactly
 * how `about 2 GB` survived next to a 6.6 GB model.
 */
export function approxSizeLabel(bytes: number): string {
  return `about ${(bytes / 1e9).toFixed(1)} GB`
}

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: DEFAULT_GENERAL_MODEL,
    label: 'General assistant',
    purpose: 'Everyday chat, planning and running tasks across your apps.',
    approxSize: approxSizeLabel(MODEL_LAYER_BYTES[DEFAULT_GENERAL_MODEL])
  },
  {
    id: DEFAULT_CODE_MODEL,
    label: 'Coding assistant',
    purpose: 'Writing and editing code in the autonomous builder.',
    approxSize: approxSizeLabel(MODEL_LAYER_BYTES[DEFAULT_CODE_MODEL])
  }
]

export function isCatalogModel(model: string): boolean {
  return MODEL_CATALOG.some((m) => m.id === model)
}

/** Why a download could not be started or did not finish. */
export type DownloadErrorCode =
  | 'unauthenticated'
  | 'unknown_model'
  | 'already_in_progress'
  | 'engine_unavailable'
  | 'disk_space'
  | 'network'
  | 'model_not_found'
  | 'failed'

export interface DownloadFailure {
  ok: false
  code: DownloadErrorCode
  message: string
  /** Set only for `engine_unavailable`: the page the UI should open. */
  installUrl?: string
}

export type DownloadResult = { ok: true; model: string } | DownloadFailure

/** One row of the model list the UI renders. */
export interface ModelStatus extends CatalogModel {
  installed: boolean
  downloading: boolean
}

/**
 * Turn a failure from the pull stream into a specific, actionable code.
 *
 * Ollama surfaces these as plain English inside its NDJSON `error` field, so
 * matching on the text is the only signal available. Everything unmatched stays
 * `failed` with the original message preserved — an unfamiliar failure has to
 * remain visible rather than be flattened into a friendly guess.
 *
 * Pure and exported for tests.
 */
export function classifyPullFailure(raw: unknown): DownloadFailure {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '')
  const t = text.toLowerCase()

  if (/no space left|not enough space|insufficient space|disk full|enospc/.test(t)) {
    return {
      ok: false,
      code: 'disk_space',
      message:
        'There isn’t enough free disk space to finish the download. Free up a few gigabytes and start it again.'
    }
  }
  if (
    /econnreset|econnrefused|enotfound|etimedout|socket hang up|network|connection|timeout|fetch failed|ended before completing/.test(
      t
    )
  ) {
    return {
      ok: false,
      code: 'network',
      message:
        'The download stopped because the connection was lost. Check your internet connection and start it again — finished parts are kept, so it resumes rather than starting over.'
    }
  }
  if (/file does not exist|not found|manifest unknown|pull model manifest|404/.test(t)) {
    return {
      ok: false,
      code: 'model_not_found',
      message: 'That model isn’t available from the model library right now. Try again later.'
    }
  }
  return {
    ok: false,
    code: 'failed',
    message: text ? `The download failed: ${text}` : 'The download failed. Please try again.'
  }
}

/**
 * Is the local engine reachable? Short timeout and never throws — an unreachable
 * daemon is an expected state here, not an exception.
 */
export async function isEngineReachable(timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/** The failure returned when the engine can't be reached. */
export function engineUnavailable(): DownloadFailure {
  return {
    ok: false,
    code: 'engine_unavailable',
    message:
      'OpenUI needs the local AI engine (Ollama) installed and running before it can download a model. Install it, then come back to this screen — OpenUI starts it for you from then on.',
    installUrl: OLLAMA_INSTALL_URL
  }
}

/**
 * List the catalog with live installed / downloading state, so the UI can render
 * a real status per model instead of guessing from a single global flag.
 */
export async function listModelStatus(): Promise<ModelStatus[]> {
  let installedIds: string[] = []
  try {
    installedIds = (await getAvailableModels())
      .filter((m) => m.provider === 'ollama')
      .map((m) => m.id)
  } catch {
    // Engine unreachable — nothing is installed as far as we can prove.
  }
  return MODEL_CATALOG.map((m) => ({
    ...m,
    installed: installedIds.includes(m.id),
    downloading: isPullInFlight(m.id)
  }))
}

/**
 * Start a user-initiated download and resolve once it finishes.
 *
 * Progress reaches the renderer over the existing `openui:model:pull` channel
 * (ollamaPull emits it), so this resolves only with the terminal outcome.
 */
export async function downloadModel(win: BrowserWindow | null, model: unknown): Promise<DownloadResult> {
  if (!hasAccountSession()) {
    return {
      ok: false,
      code: 'unauthenticated',
      message: 'Sign in to download a model.'
    }
  }
  if (typeof model !== 'string' || !isCatalogModel(model)) {
    return {
      ok: false,
      code: 'unknown_model',
      message: 'That model isn’t one OpenUI offers.'
    }
  }
  if (isPullInFlight(model)) {
    return {
      ok: false,
      code: 'already_in_progress',
      message: 'That model is already downloading — progress is shown above.'
    }
  }
  if (!(await isEngineReachable())) {
    return engineUnavailable()
  }

  try {
    await pullModel(win, model)
    return { ok: true, model }
  } catch (err) {
    return classifyPullFailure(err)
  }
}
