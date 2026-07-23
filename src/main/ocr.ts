/**
 * ocr.ts — one shared, OFFLINE-SAFE entry point for Tesseract OCR, now
 * MULTI-LANGUAGE.
 *
 * WHY THIS EXISTS: both OCR call sites in tools.ts previously called
 * `Tesseract.recognize(buf, 'eng', …)` with no options. tesseract.js resolves
 * language data from a CDN in that configuration, which meant (a) OCR silently
 * failed with no network, and (b) the "local, private" free-tier screen-read
 * path made a third-party network request on every first use.
 *
 * WHY MULTI-LANGUAGE: with only `eng.traineddata` bundled, computer_use and
 * read_screen were effectively English-only — any non-English UI degraded
 * SILENTLY to garbage OCR output with no error telling the model why. That is a
 * reliability trap the same way a wrong click coordinate is, just less visible.
 * The fix is threefold and lives here + at the call sites:
 *   1. Bundle a small set of extra language packs (see `OCR_LANGUAGES` and
 *      scripts/fetch-traineddata.cjs) so common non-English UIs OCR correctly.
 *   2. Resolve the caller-selected language to its `<code>.traineddata` file
 *      using the same candidate-directory search that always found `eng`.
 *   3. If a REQUIRED non-English pack is not installed, throw a clear, actionable
 *      error naming the missing language — NEVER silently fall back to the
 *      English model against non-English text and return garbage.
 *
 * The English baseline keeps its original contract: if `eng.traineddata` cannot
 * be located we warn loudly and let tesseract.js fall back to its CDN, rather
 * than hard-failing, because English is the always-present default.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Language tesseract falls back to and the one guaranteed to be bundled. */
export const DEFAULT_OCR_LANG = 'eng'

/**
 * The language packs OpenUI bundles. `code` is BOTH the tesseract language
 * identifier passed to `recognize()` AND the `<code>.traineddata` filename.
 *
 * Kept deliberately small (a reasonable common set, not every language
 * tesseract supports) to control installer size — see the size report in
 * scripts/fetch-traineddata.cjs. Keep this list in sync with:
 *   • scripts/fetch-traineddata.cjs (the download list), and
 *   • the picker in src/renderer/src/components/SettingsModal.tsx.
 */
export const OCR_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: 'eng', label: 'English' },
  { code: 'spa', label: 'Spanish' },
  { code: 'fra', label: 'French' },
  { code: 'deu', label: 'German' },
  { code: 'por', label: 'Portuguese' },
  { code: 'hin', label: 'Hindi' },
  { code: 'jpn', label: 'Japanese' },
  { code: 'chi_sim', label: 'Chinese (Simplified)' }
]

const SUPPORTED_CODES = new Set(OCR_LANGUAGES.map((l) => l.code))

/** True when `code` names one of the bundled OCR language packs. */
export function isSupportedOcrLang(code: string): boolean {
  return SUPPORTED_CODES.has(code)
}

/** Human-readable label for a language code (falls back to the code itself). */
export function ocrLanguageLabel(code: string): string {
  return OCR_LANGUAGES.find((l) => l.code === code)?.label ?? code
}

/** `<code>.traineddata` — the filename tesseract.js expects for a language. */
function trainedDataFile(code: string): string {
  return `${code}.traineddata`
}

/**
 * Map an OS/BCP-47 locale (e.g. "es-ES", "zh-CN", "pt_BR") to a bundled OCR
 * language code, used for the "Auto (detect from system)" Settings default.
 * Only the primary subtag is considered; anything we don't bundle resolves to
 * English so auto-detect can never select a pack that isn't installed.
 */
const LOCALE_PREFIX_TO_LANG: Readonly<Record<string, string>> = {
  en: 'eng',
  es: 'spa',
  fr: 'fra',
  de: 'deu',
  pt: 'por',
  hi: 'hin',
  ja: 'jpn',
  zh: 'chi_sim'
}

export function localeToOcrLang(locale: string | null | undefined): string {
  if (!locale) return DEFAULT_OCR_LANG
  const primary = locale.toLowerCase().split(/[-_]/)[0]
  return LOCALE_PREFIX_TO_LANG[primary] ?? DEFAULT_OCR_LANG
}

// ── Language-data-file resolution ────────────────────────────────────────────

// Resolved once per language per process — the answer cannot change at runtime
// and the existsSync probing is not worth repeating on every OCR call.
const cachedLangDir = new Map<string, string | null>()

// Warn at most once per language so a missing English pack does not spam logs.
const warnedMissing = new Set<string>()

/**
 * Test seam. `undefined` restores normal resolution; a directory string makes
 * that directory (and its `tessdata/` subdir) the ONLY search location — so a
 * test can create a temp dir holding a subset of packs and verify both the
 * found and the missing-pack paths; `null` forces "no packs anywhere".
 */
let testCandidateBase: string | null | undefined
export function setLangPathForTests(dir: string | null | undefined): void {
  testCandidateBase = dir
  cachedLangDir.clear()
  warnedMissing.clear()
}

/**
 * Candidate directories that may contain the `.traineddata` packs, most-specific
 * first. Packaged builds get them via electron-builder `extraResources` (the
 * `tessdata/` folder → `process.resourcesPath/tessdata`); dev runs read them
 * from the repo's `tessdata/` (two levels up from `out/main` or `src/main`).
 *
 * Each base is probed twice: its `tessdata/` subdir (the multi-language layout
 * populated by scripts/fetch-traineddata.cjs) AND the base itself (back-compat
 * with a legacy `eng.traineddata` sitting flat at the repo/resources root).
 */
export function langPathCandidates(resourcesPath?: string): string[] {
  const bases: string[] = []
  if (resourcesPath) bases.push(resourcesPath)
  // __dirname is out/main (built) or src/main (vitest/tsx) — walk up to the root.
  bases.push(join(__dirname, '..', '..'), join(__dirname, '..'), process.cwd())
  const dirs: string[] = []
  for (const base of bases) {
    dirs.push(join(base, 'tessdata'), base)
  }
  return dirs
}

function candidateDirs(): string[] {
  if (testCandidateBase !== undefined) {
    if (testCandidateBase === null) return []
    return [join(testCandidateBase, 'tessdata'), testCandidateBase]
  }
  // `process.resourcesPath` only exists in a packaged Electron process.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return langPathCandidates(resourcesPath)
}

/**
 * Directory containing `<code>.traineddata`, or null when it cannot be located.
 * Returns a DIRECTORY (not the file) because that is what tesseract's
 * `langPath` option takes.
 */
export function resolveLangPath(lang: string = DEFAULT_OCR_LANG): string | null {
  const cached = cachedLangDir.get(lang)
  if (cached !== undefined) return cached
  const file = trainedDataFile(lang)
  for (const dir of candidateDirs()) {
    if (existsSync(join(dir, file))) {
      cachedLangDir.set(lang, dir)
      return dir
    }
  }
  cachedLangDir.set(lang, null)
  return null
}

/** Normalise a caller-supplied language: trim, default to English when blank. */
function normalizeLang(lang: string | null | undefined): string {
  const code = (lang ?? '').trim()
  return code || DEFAULT_OCR_LANG
}

/** The subset of tesseract.js `recognize` we depend on. */
type Recognizer = (
  image: Buffer,
  lang: string,
  options: Record<string, unknown>
) => Promise<{ data: { text?: string } }>

// Test seam: inject a fake recognizer so unit tests never spin up the real OCR
// engine. `null` restores the lazy-required tesseract.js. Mirrors
// setLangPathForTests — a require()'d native module resists vi.mock, so this
// explicit indirection is the reliable way to keep the tests engine-free.
let recognizerOverride: Recognizer | null = null
export function setRecognizerForTests(fn: Recognizer | null): void {
  recognizerOverride = fn
}

function getRecognizer(): Recognizer {
  if (recognizerOverride) return recognizerOverride
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Tesseract = require('tesseract.js') as any
  return (image, lang, options) => Tesseract.recognize(image, lang, options)
}

/**
 * Run OCR over a PNG buffer in `lang` (default English) and return the raw
 * recognised text.
 *
 * Never throws for "no text found" (returns ''), but DOES propagate genuine
 * engine/IO failures so callers can distinguish "the screen has no text" from
 * "OCR is broken" — and, crucially, throws a clear, actionable error when a
 * NON-English language is requested but its pack is not installed, instead of
 * silently OCR'ing non-English UI with the English model.
 */
export async function ocrImage(
  pngBuffer: Buffer,
  lang: string = DEFAULT_OCR_LANG
): Promise<string> {
  const code = normalizeLang(lang)
  if (!isSupportedOcrLang(code)) {
    throw new Error(
      `OCR language "${code}" is not supported. Bundled languages: ` +
        `${OCR_LANGUAGES.map((l) => l.code).join(', ')}.`
    )
  }

  const langPath = resolveLangPath(code)
  const options: Record<string, unknown> = { logger: () => {} }
  if (langPath) {
    options.langPath = langPath
    // The bundled traineddata is uncompressed; without this tesseract.js looks
    // for `<code>.traineddata.gz` and falls through to the CDN when it is absent.
    options.gzip = false
  } else if (code !== DEFAULT_OCR_LANG) {
    // A non-English language was selected but its pack isn't installed. Fail
    // loudly NAMING the language — never silently OCR non-English text with the
    // English model (that returns garbage with no hint why).
    throw new Error(
      `OCR language "${ocrLanguageLabel(code)}" (${code}) is selected but its data file ` +
        `${trainedDataFile(code)} is not installed. Run "npm run fetch:ocr-langs" to download the ` +
        `bundled language packs, or pick a different language under Settings → Screen OCR language.`
    )
  } else if (!warnedMissing.has(code)) {
    // English baseline missing: keep the original contract (warn + CDN fallback)
    // rather than hard-failing, since English is the always-present default.
    warnedMissing.add(code)
    console.warn(
      `[ocr] ${trainedDataFile(code)} not found on disk — tesseract.js will fall back to its CDN. ` +
        'OCR will not work offline.'
    )
  }

  const { data } = await getRecognizer()(pngBuffer, code, options)
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
export async function ocrLines(
  pngBuffer: Buffer,
  lang: string = DEFAULT_OCR_LANG
): Promise<string[]> {
  return normalizeOcrLines(await ocrImage(pngBuffer, lang))
}

/** Exposed for diagnostics: the directory a language resolved to, if any. */
export function currentLangPathDir(lang: string = DEFAULT_OCR_LANG): string | null {
  return resolveLangPath(lang)
}
