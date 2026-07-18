/**
 * ocr.ts — one shared, OFFLINE-SAFE entry point for Tesseract OCR.
 *
 * WHY THIS EXISTS: both OCR call sites in tools.ts previously called
 * `Tesseract.recognize(buf, 'eng', …)` with no options. tesseract.js resolves
 * language data from a CDN in that configuration, which meant (a) OCR silently
 * failed with no network, and (b) the "local, private" free-tier screen-read
 * path made a third-party network request on every first use. The repo has
 * shipped `eng.traineddata` at its root the whole time — nothing pointed at it.
 *
 * resolveLangPath() finds that file in both dev (repo root) and packaged
 * (process.resourcesPath) layouts and pins tesseract to it with `gzip:false`
 * (the bundled file is uncompressed). If it genuinely cannot be found we fall
 * back to tesseract's default resolution rather than hard-failing, but we warn
 * loudly, because that path is the one that reaches the network.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Filename tesseract.js expects for English language data. */
const TRAINEDDATA = 'eng.traineddata'

// Resolved once per process — the answer cannot change at runtime and the
// existsSync probing is not worth repeating on every OCR call.
let cachedLangPath: string | null | undefined

/** Test seam: force a langPath (pass undefined to restore auto-detection). */
export function setLangPathForTests(dir: string | null | undefined): void {
  cachedLangPath = dir
}

/**
 * Candidate directories that may contain eng.traineddata, most-specific first.
 * Packaged builds get it via electron-builder `extraResources` →
 * `process.resourcesPath`; dev runs read it straight from the repo root, which
 * is two levels up from `out/main` and one level up from `src/main`.
 */
export function langPathCandidates(resourcesPath?: string): string[] {
  const dirs: string[] = []
  if (resourcesPath) dirs.push(resourcesPath)
  // __dirname is out/main (built) or src/main (vitest/tsx) — walk up to the root.
  dirs.push(join(__dirname, '..', '..'), join(__dirname, '..'), process.cwd())
  return dirs
}

/**
 * Directory containing eng.traineddata, or null when it cannot be located.
 * Returns a DIRECTORY (not the file) because that is what tesseract's
 * `langPath` option takes.
 */
export function resolveLangPath(): string | null {
  if (cachedLangPath !== undefined) return cachedLangPath
  // `process.resourcesPath` only exists in a packaged Electron process.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  for (const dir of langPathCandidates(resourcesPath)) {
    if (existsSync(join(dir, TRAINEDDATA))) {
      cachedLangPath = dir
      return dir
    }
  }
  console.warn(
    `[ocr] ${TRAINEDDATA} not found on disk — tesseract.js will fall back to its CDN. ` +
      'OCR will not work offline.'
  )
  cachedLangPath = null
  return null
}

/**
 * Run OCR over a PNG buffer and return the raw recognised text.
 *
 * Never throws for "no text found" (returns ''), but DOES propagate genuine
 * engine/IO failures so callers can distinguish "the screen has no text" from
 * "OCR is broken".
 */
export async function ocrImage(pngBuffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const Tesseract = require('tesseract.js') as any
  const langPath = resolveLangPath()
  const options: Record<string, unknown> = { logger: () => {} }
  if (langPath) {
    options.langPath = langPath
    // The bundled traineddata is uncompressed; without this tesseract.js looks
    // for `eng.traineddata.gz` and falls through to the CDN when it is absent.
    options.gzip = false
  }
  const { data } = (await Tesseract.recognize(pngBuffer, 'eng', options)) as {
    data: { text?: string }
  }
  return data.text ?? ''
}

/**
 * OCR a frame and return normalised, de-duplicated text lines.
 *
 * This is the form the agent loop compares between frames: raw OCR output is
 * noisy (stray single characters, inconsistent whitespace, repeated chrome), so
 * comparing raw strings produces false "the screen changed" signals. Trimming,
 * collapsing internal whitespace, and dropping sub-2-character lines makes
 * frame-to-frame comparison stable enough to verify an action.
 */
export function normalizeOcrLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line.length < 2) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/** Convenience: capture-to-lines in one call. */
export async function ocrLines(pngBuffer: Buffer): Promise<string[]> {
  return normalizeOcrLines(await ocrImage(pngBuffer))
}

/** Exposed for diagnostics: the directory the resolver settled on, if any. */
export function currentLangPathDir(): string | null {
  return resolveLangPath()
}
