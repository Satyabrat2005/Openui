/**
 * splen/install.ts — where Splen lives on disk, and how the app knows it is whole.
 *
 * WHERE. Inside OpenUI's own user-data folder, never Ollama's model store.
 * Anything in the Ollama store can be run from a terminal (`ollama run`) or by
 * any other program talking to the daemon on 127.0.0.1:11434; the owner's
 * requirement is that Splen runs only inside OpenUI. Honest limit: this is a
 * file in the user's profile, so a determined user can still copy it. What it
 * removes is every *supported* path to the model outside the app.
 *
 * WHOLE. A 2.8 GB download can be cut off, resumed, or tampered with. Hashing it
 * on every launch would cost seconds of disk I/O, so the hash is checked once,
 * as the download finishes, and only then is `splen.json` written beside the
 * weights. No `splen.json`, or a size that no longer matches it, means Splen is
 * not installed — never "installed, probably".
 */
import { app } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'

export const SPLEN_WEIGHTS_FILE = 'splen.gguf'
export const SPLEN_MANIFEST_FILE = 'splen.json'

/** What a verified download leaves behind. */
export interface SplenInstall {
  /** Release of the weights, e.g. "4b-run4" — reported with every gate result. */
  version: string
  /** Lower-case hex sha256 of the weights file, checked when it was downloaded. */
  sha256: string
  bytes: number
}

let dirOverride: string | null = null

/** Tests point this at a temp folder; the app never calls it. */
export function setSplenDirForTests(dir: string | null): void {
  dirOverride = dir
}

export function splenDir(): string {
  return dirOverride ?? join(app.getPath('userData'), 'models', 'splen')
}

export function splenWeightsPath(): string {
  return join(splenDir(), SPLEN_WEIGHTS_FILE)
}

function isInstallRecord(value: unknown): value is SplenInstall {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.version === 'string' &&
    v.version.length > 0 &&
    typeof v.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.sha256) &&
    typeof v.bytes === 'number' &&
    Number.isSafeInteger(v.bytes) &&
    v.bytes > 0
  )
}

/**
 * The verified install, or null. Cheap enough to call per turn: one small JSON
 * read and one stat, no hashing.
 */
export function readSplenInstall(): SplenInstall | null {
  const manifestPath = join(splenDir(), SPLEN_MANIFEST_FILE)
  const weightsPath = splenWeightsPath()
  if (!existsSync(manifestPath) || !existsSync(weightsPath)) return null
  let record: unknown
  try {
    record = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (!isInstallRecord(record)) return null
  try {
    if (statSync(weightsPath).size !== record.bytes) return null
  } catch {
    return null
  }
  return record
}

export function isSplenInstalled(): boolean {
  return readSplenInstall() !== null
}

/**
 * Record a verified download. Only the downloader calls this, and only after
 * the sha256 of the bytes on disk matched. Written via a temp file and rename so
 * a crash mid-write cannot leave a half-written manifest that parses.
 */
export function writeSplenInstall(record: SplenInstall): void {
  if (!isInstallRecord(record)) throw new Error('Refusing to record an invalid Splen install.')
  const manifestPath = join(splenDir(), SPLEN_MANIFEST_FILE)
  const tmp = `${manifestPath}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, manifestPath)
}
