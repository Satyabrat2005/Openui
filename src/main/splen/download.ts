/**
 * splen/download.ts — fetch Splen's weights from OpenUI's private storage.
 *
 * Splen is not on ollama.com or any public registry. The weights sit in a
 * private Cloudflare R2 bucket; the `splen-download` edge function checks the
 * caller's OpenUI sign-in and answers with a short-lived signed URL plus the
 * sha256 and size the file must have. Nothing here holds a storage key.
 *
 * What a user-initiated multi-gigabyte download has to get right:
 *   • RESUME. A dropped connection keeps what arrived (`splen.gguf.part`) and
 *     continues with an HTTP Range request. A signed URL only lives for minutes,
 *     so each attempt asks for a fresh one.
 *   • INTEGRITY. The file is hashed once it is complete and must match the
 *     sha256 the server stated before a single byte arrived. Only then is it
 *     moved into place and recorded (install.ts); a mismatch is discarded.
 *   • HONEST PROGRESS on the same channel Ollama pulls use
 *     (`openui:model:pull`), so the model screen needs no second code path.
 *   • NO TERMINAL. No message here names a command (see modelDownload.ts).
 */
import type { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, statfsSync } from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { join } from 'path'
import { callEdgeFunction, EdgeFunctionError } from '../edgeFunctions'
import type { DownloadFailure, DownloadResult } from '../modelDownload'
import type { ModelPullProgress } from '../ollamaPull'
import { withOllamaLock } from '../ollamaLock'
import { SPLEN_MODEL } from '../models'
import {
  readSplenInstall,
  splenDir,
  splenWeightsPath,
  writeSplenInstall,
  SPLEN_MANIFEST_FILE,
  type SplenInstall
} from './install'
import { unloadSplen } from './runtime'

/** The id the model screen and the progress channel know Splen by. */
export const SPLEN_DOWNLOAD_ID = SPLEN_MODEL

/** What `splen-download` answers with. */
export interface SplenGrant extends SplenInstall {
  url: string
}

/** Fresh signed URLs tried before a download is reported as failed. */
export const MAX_ATTEMPTS = 3

/** Headroom beyond the file itself, so the download never fills the disk. */
const DISK_HEADROOM_BYTES = 512 * 1024 * 1024

const PROGRESS_INTERVAL_MS = 250

export class SplenGrantError extends Error {
  constructor(
    readonly failure: DownloadFailure,
    message = failure.message
  ) {
    super(message)
    this.name = 'SplenGrantError'
  }
}

function isGrant(value: unknown): value is SplenGrant {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.url === 'string' &&
    v.url.startsWith('https://') &&
    typeof v.version === 'string' &&
    v.version.length > 0 &&
    typeof v.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.sha256) &&
    typeof v.bytes === 'number' &&
    Number.isSafeInteger(v.bytes) &&
    v.bytes > 0
  )
}

/** Ask the edge function for a signed URL. Pure mapping of its answers to failures. */
export async function requestSplenGrant(): Promise<SplenGrant> {
  let res: Response
  try {
    res = await callEdgeFunction('splen-download', {})
  } catch (err) {
    if (err instanceof EdgeFunctionError && err.code !== 'network_error') {
      throw new SplenGrantError({ ok: false, code: 'unauthenticated', message: 'Sign in to download Splen.' })
    }
    throw new SplenGrantError({
      ok: false,
      code: 'network',
      message: 'Could not reach OpenUI to start the download. Check your internet connection and try again.'
    })
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // handled below
  }
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  if (res.status === 403 && error === 'not_offered') {
    throw new SplenGrantError({
      ok: false,
      code: 'model_not_found',
      message: 'Splen isn’t available for your account yet.'
    })
  }
  if (res.status === 401 || res.status === 403) {
    throw new SplenGrantError({ ok: false, code: 'unauthenticated', message: 'Sign in to download Splen.' })
  }
  if (res.status === 429) {
    throw new SplenGrantError({
      ok: false,
      code: 'failed',
      message: 'Too many Splen downloads were started from this account today. Try again tomorrow.'
    })
  }
  if (!res.ok || !isGrant(body)) {
    throw new SplenGrantError({
      ok: false,
      code: 'model_not_found',
      message: 'Splen downloads aren’t available right now. Try again later.'
    })
  }
  return body
}

/** Whether the server offers Splen to this account, and how big it is. */
export interface SplenOffer {
  version: string
  bytes: number
}

const OFFER_CACHE_MS = 10 * 60 * 1000
let offerCache: { at: number; offer: SplenOffer | null } | null = null

/**
 * Ask the server whether to show Splen at all. The owner turns Splen on (and
 * can limit it to a few test accounts) without shipping a new build. Any
 * failure — signed out, offline, function not deployed — means "not offered":
 * the model screen simply does not show a row it could not deliver.
 */
export async function getSplenOffer(): Promise<SplenOffer | null> {
  if (offerCache && Date.now() - offerCache.at < OFFER_CACHE_MS) return offerCache.offer
  let offer: SplenOffer | null = null
  try {
    const res = await callEdgeFunction('splen-download', { action: 'status' })
    const body = res.ok ? ((await res.json()) as Record<string, unknown>) : null
    if (
      body?.available === true &&
      typeof body.version === 'string' &&
      typeof body.bytes === 'number' &&
      Number.isSafeInteger(body.bytes) &&
      body.bytes > 0
    ) {
      offer = { version: body.version, bytes: body.bytes }
    }
  } catch {
    offer = null
  }
  offerCache = { at: Date.now(), offer }
  return offer
}

export function clearSplenOfferCacheForTests(): void {
  offerCache = null
}

function emit(win: BrowserWindow | null, progress: ModelPullProgress): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('openui:model:pull', progress)
  } catch {
    /* renderer gone — the download is still worth finishing */
  }
}

function progress(status: string, completed: number | null, total: number | null, done = false): ModelPullProgress {
  return {
    model: SPLEN_DOWNLOAD_ID,
    status,
    percent: completed !== null && total ? Math.min(100, Math.floor((completed / total) * 100)) : null,
    completed,
    total,
    layer: null,
    done
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export interface SplenDownloadDeps {
  requestGrant: () => Promise<SplenGrant>
  fetch: typeof fetch
}

const defaultDeps: SplenDownloadDeps = { requestGrant: requestSplenGrant, fetch: (...a) => fetch(...a) }

/**
 * One attempt: continue `part` from where it stopped (or start it), until it
 * holds `grant.bytes` bytes. Throws on any network or server problem; what
 * arrived is kept for the next attempt.
 */
async function fetchInto(
  win: BrowserWindow | null,
  grant: SplenGrant,
  part: string,
  doFetch: typeof fetch
): Promise<void> {
  let have = existsSync(part) ? statSync(part).size : 0
  if (have > grant.bytes) {
    rmSync(part, { force: true })
    have = 0
  }
  if (have === grant.bytes) return

  const res = await doFetch(grant.url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {} })
  if (!res.ok || !res.body) throw new Error(`storage replied ${res.status}`)
  // A server that ignores Range sends the whole file with 200: start over
  // rather than append a second copy to the first half.
  const append = have > 0 && res.status === 206
  if (!append) have = 0

  let received = have
  let lastEmit = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now
        emit(win, progress('downloading', received, grant.bytes))
      }
      done(null, chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(res.body as import('stream/web').ReadableStream),
    counter,
    createWriteStream(part, { flags: append ? 'a' : 'w' })
  )
  if (received < grant.bytes) throw new Error('the connection closed early')
  if (received > grant.bytes) throw new Error('storage sent more bytes than the file has')
}

let inFlight: Promise<DownloadResult> | null = null

export function isSplenDownloadInFlight(): boolean {
  return inFlight !== null
}

/**
 * Download, verify and install Splen. Concurrent calls share one download.
 * Resolves with the outcome; never throws.
 */
export function downloadSplen(win: BrowserWindow | null, deps: SplenDownloadDeps = defaultDeps): Promise<DownloadResult> {
  if (inFlight) return inFlight
  const run = runDownload(win, deps).finally(() => {
    inFlight = null
  })
  inFlight = run
  return run
}

async function runDownload(win: BrowserWindow | null, deps: SplenDownloadDeps): Promise<DownloadResult> {
  emit(win, progress('starting download', null, null))
  let grant: SplenGrant
  try {
    grant = await deps.requestGrant()
  } catch (err) {
    return err instanceof SplenGrantError ? err.failure : { ok: false, code: 'failed', message: String(err) }
  }

  const installed = readSplenInstall()
  if (installed && installed.sha256 === grant.sha256) {
    emit(win, progress('ready', grant.bytes, grant.bytes, true))
    return { ok: true, model: SPLEN_DOWNLOAD_ID }
  }

  const dir = splenDir()
  mkdirSync(dir, { recursive: true })
  const part = `${splenWeightsPath()}.part`

  const alreadyHave = existsSync(part) ? statSync(part).size : 0
  const free = freeBytes(dir)
  if (free !== null && free < grant.bytes - alreadyHave + DISK_HEADROOM_BYTES) {
    return {
      ok: false,
      code: 'disk_space',
      message: `Splen needs about ${(grant.bytes / 1e9).toFixed(1)} GB of free disk space. Free up some space and start the download again.`
    }
  }

  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // The first grant is fresh; later attempts need a new signed URL.
      if (attempt > 0) grant = await deps.requestGrant()
      await fetchInto(win, grant, part, deps.fetch)
      lastError = null
      break
    } catch (err) {
      if (err instanceof SplenGrantError) return err.failure
      lastError = err
    }
  }
  if (lastError) {
    return {
      ok: false,
      code: 'network',
      message:
        'The Splen download stopped because the connection was lost. Start it again — what already arrived is kept, so it resumes rather than starting over.'
    }
  }

  emit(win, progress('verifying download', grant.bytes, grant.bytes))
  const actual = await sha256File(part)
  if (actual !== grant.sha256) {
    // A complete file with the wrong hash is corrupt or tampered with: never
    // load it, and do not resume from it.
    rmSync(part, { force: true })
    return {
      ok: false,
      code: 'failed',
      message: 'The downloaded file didn’t pass its integrity check, so it was discarded. Start the download again.'
    }
  }

  // Replacing an older Splen: free the loaded copy first (llama.cpp maps the
  // file, and Windows will not replace a mapped file), and drop its record
  // before the swap so a crash in between reads as "not installed".
  if (installed) {
    await withOllamaLock(unloadSplen)
    rmSync(join(dir, SPLEN_MANIFEST_FILE), { force: true })
  }
  renameSync(part, splenWeightsPath())
  writeSplenInstall({ version: grant.version, sha256: grant.sha256, bytes: grant.bytes })
  emit(win, progress('ready', grant.bytes, grant.bytes, true))
  return { ok: true, model: SPLEN_DOWNLOAD_ID }
}
