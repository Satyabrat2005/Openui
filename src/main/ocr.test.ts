import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ocrImage,
  ocrLines,
  normalizeOcrLines,
  resolveLangPath,
  currentLangPathDir,
  setLangPathForTests,
  setRecognizerForTests,
  langPathCandidates,
  localeToOcrLang,
  isSupportedOcrLang,
  ocrLanguageLabel,
  OCR_LANGUAGES,
  DEFAULT_OCR_LANG
} from './ocr'

const buf = Buffer.from('png')

// Fake OCR engine — captures the (image, lang, options) it is called with so we
// can assert what ocrImage passes, without ever running real tesseract.js.
const recognizeMock = vi.fn()

beforeEach(() => {
  recognizeMock.mockReset()
  recognizeMock.mockResolvedValue({ data: { text: 'hello\nworld' } })
  setRecognizerForTests((image, lang, options) => recognizeMock(image, lang, options))
})

afterEach(() => {
  setLangPathForTests(undefined) // restore normal resolution
  setRecognizerForTests(null) // restore the real (lazy-required) engine
})

describe('OCR language registry', () => {
  it('includes the bundled set and English is the default', () => {
    const codes = OCR_LANGUAGES.map((l) => l.code)
    expect(codes).toEqual(['eng', 'spa', 'fra', 'deu', 'por', 'hin', 'jpn', 'chi_sim'])
    expect(DEFAULT_OCR_LANG).toBe('eng')
  })

  it('isSupportedOcrLang recognises bundled codes only', () => {
    expect(isSupportedOcrLang('spa')).toBe(true)
    expect(isSupportedOcrLang('chi_sim')).toBe(true)
    expect(isSupportedOcrLang('xyz')).toBe(false)
  })

  it('ocrLanguageLabel maps codes to labels, falling back to the code', () => {
    expect(ocrLanguageLabel('deu')).toBe('German')
    expect(ocrLanguageLabel('unknown')).toBe('unknown')
  })
})

describe('localeToOcrLang', () => {
  it('maps OS/BCP-47 locales by primary subtag', () => {
    expect(localeToOcrLang('es-ES')).toBe('spa')
    expect(localeToOcrLang('pt_BR')).toBe('por')
    expect(localeToOcrLang('zh-CN')).toBe('chi_sim')
    expect(localeToOcrLang('ja')).toBe('jpn')
    expect(localeToOcrLang('en-US')).toBe('eng')
  })

  it('falls back to English for unknown/empty locales so auto never selects a missing pack', () => {
    expect(localeToOcrLang('sw-KE')).toBe('eng')
    expect(localeToOcrLang('')).toBe('eng')
    expect(localeToOcrLang(null)).toBe('eng')
    expect(localeToOcrLang(undefined)).toBe('eng')
  })
})

describe('normalizeOcrLines', () => {
  it('trims, collapses whitespace, drops <2-char lines, and de-dupes', () => {
    expect(normalizeOcrLines('  Save  file \nSave  file \nx\nOpen')).toEqual(['Save file', 'Open'])
  })
})

describe('langPathCandidates', () => {
  it('probes both a tessdata/ subdir and the flat base for each root', () => {
    const dirs = langPathCandidates('/res')
    // resourcesPath is most-specific and its tessdata subdir comes first.
    expect(dirs[0]).toBe(join('/res', 'tessdata'))
    expect(dirs[1]).toBe('/res')
    expect(dirs).toContain(join(process.cwd(), 'tessdata'))
  })
})

describe('resolveLangPath (per-language file lookup)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocr-'))
    await writeFile(join(dir, 'eng.traineddata'), 'x') // only English present
    setLangPathForTests(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds a present pack and returns null for an absent one', () => {
    expect(resolveLangPath('eng')).toBe(dir)
    expect(currentLangPathDir('eng')).toBe(dir)
    expect(resolveLangPath('spa')).toBeNull()
  })

  it('null override forces "no packs anywhere"', () => {
    setLangPathForTests(null)
    expect(resolveLangPath('eng')).toBeNull()
  })
})

describe('ocrImage language handling', () => {
  it('throws a clear, actionable error when a non-English pack is missing — never silently OCRs English', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocr-'))
    await writeFile(join(dir, 'eng.traineddata'), 'x')
    setLangPathForTests(dir)

    await expect(ocrImage(buf, 'spa')).rejects.toThrow(/Spanish/)
    await expect(ocrImage(buf, 'spa')).rejects.toThrow(/spa\.traineddata/)
    await expect(ocrImage(buf, 'spa')).rejects.toThrow(/fetch:ocr-langs/)
    // The engine must never run for a missing-pack language.
    expect(recognizeMock).not.toHaveBeenCalled()

    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an unsupported language code without invoking the engine', async () => {
    await expect(ocrImage(buf, 'xyz')).rejects.toThrow(/not supported/)
    expect(recognizeMock).not.toHaveBeenCalled()
  })

  it('passes langPath + gzip:false when the pack is found on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocr-'))
    await writeFile(join(dir, 'deu.traineddata'), 'x')
    setLangPathForTests(dir)

    const text = await ocrImage(buf, 'deu')
    expect(text).toBe('hello\nworld')
    const [, lang, options] = recognizeMock.mock.calls[0]
    expect(lang).toBe('deu')
    expect(options).toMatchObject({ langPath: dir, gzip: false })

    await rm(dir, { recursive: true, force: true })
  })

  it('English falls back to the CDN (warns, no langPath) when its pack is absent', async () => {
    setLangPathForTests(null) // nothing on disk
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const text = await ocrImage(buf) // defaults to English
    expect(text).toBe('hello\nworld')
    const [, lang, options] = recognizeMock.mock.calls[0]
    expect(lang).toBe('eng')
    expect(options).not.toHaveProperty('langPath')
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })

  it('ocrLines threads the language through and normalises the result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocr-'))
    await writeFile(join(dir, 'jpn.traineddata'), 'x')
    setLangPathForTests(dir)
    recognizeMock.mockResolvedValue({ data: { text: 'Alpha\nAlpha\nBeta' } })

    const lines = await ocrLines(buf, 'jpn')
    expect(lines).toEqual(['Alpha', 'Beta'])
    expect(recognizeMock.mock.calls[0][1]).toBe('jpn')

    await rm(dir, { recursive: true, force: true })
  })
})
