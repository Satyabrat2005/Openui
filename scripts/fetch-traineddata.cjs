#!/usr/bin/env node
/**
 * fetch-traineddata.cjs — download the Tesseract language packs OpenUI bundles
 * into ./tessdata so electron-builder can ship them (see package.json
 * `extraResources`) and local `npm run dev` OCR works offline in each language.
 *
 * WHY A SCRIPT (not committed binaries): `*.traineddata` is gitignored (large
 * binary blobs don't belong in git). This script is the supported way to
 * populate them — idempotent, so repeated builds are instant, and it FAILS LOUD
 * if a required pack can't be obtained rather than shipping an installer that is
 * silently English-only.
 *
 * Run manually:   npm run fetch:ocr-langs
 * Runs automatically before packaging via build:mac / build:win.
 *
 * Source: tesseract-ocr/tessdata_fast (the integer "fast" models — the best
 * size/latency trade-off for reading UI text). Pinned to a tag for reproducible
 * builds. Keep LANGS in sync with OCR_LANGUAGES in src/main/ocr.ts.
 *
 * APPROX INSTALLER SIZE IMPACT (tessdata_fast, uncompressed):
 *   eng 3.9 MB · spa 2.2 MB · fra 1.1 MB · deu 1.5 MB · por 1.9 MB
 *   hin 1.1 MB · jpn 2.4 MB · chi_sim 2.4 MB   →  ~16 MB total
 *   (English was already bundled, so the 7 added packs add ~12 MB.)
 */
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

// Pinned tessdata_fast release tag — bump deliberately, never track a moving branch.
const REF = '4.1.0'
const BASE_URL = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${REF}`

// Tesseract language codes == `<code>.traineddata` filenames. Keep in sync with
// OCR_LANGUAGES in src/main/ocr.ts and OCR_LANGUAGE_OPTIONS in SettingsModal.tsx.
const LANGS = ['eng', 'spa', 'fra', 'deu', 'por', 'hin', 'jpn', 'chi_sim']

// Any real pack is well over 1 MB; this floor rejects truncated downloads and
// HTML error pages masquerading as a 200.
const MIN_BYTES = 100 * 1024
const MAX_REDIRECTS = 5
const MAX_ATTEMPTS = 3

const OUT_DIR = path.join(__dirname, '..', 'tessdata')

/** GET `url` to `dest`, following redirects; rejects on non-200 / short body. */
function download(url, dest, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume() // drain
        if (redirectsLeft <= 0) return reject(new Error(`too many redirects for ${url}`))
        const next = new URL(headers.location, url).toString()
        return resolve(download(next, dest, redirectsLeft - 1))
      }
      if (statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${statusCode} for ${url}`))
      }
      const tmp = `${dest}.download`
      const out = fs.createWriteStream(tmp)
      let bytes = 0
      res.on('data', (c) => (bytes += c.length))
      res.pipe(out)
      out.on('error', reject)
      out.on('finish', () => {
        out.close(() => {
          const expected = Number(headers['content-length'] || 0)
          if (expected && bytes !== expected) {
            fs.rmSync(tmp, { force: true })
            return reject(new Error(`truncated: got ${bytes} of ${expected} bytes for ${url}`))
          }
          if (bytes < MIN_BYTES) {
            fs.rmSync(tmp, { force: true })
            return reject(new Error(`suspiciously small (${bytes} bytes) for ${url}`))
          }
          fs.renameSync(tmp, dest)
          resolve(bytes)
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => req.destroy(new Error(`timeout for ${url}`)))
  })
}

async function fetchLang(code) {
  const dest = path.join(OUT_DIR, `${code}.traineddata`)
  // Idempotent: a present, plausibly-sized file is trusted (fast rebuilds).
  if (fs.existsSync(dest) && fs.statSync(dest).size >= MIN_BYTES) {
    return { code, bytes: fs.statSync(dest).size, cached: true }
  }
  const url = `${BASE_URL}/${code}.traineddata`
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const bytes = await download(url, dest)
      return { code, bytes, cached: false }
    } catch (err) {
      lastErr = err
      console.warn(`  ! ${code}: attempt ${attempt}/${MAX_ATTEMPTS} failed — ${err.message}`)
    }
  }
  throw new Error(`could not download ${code}.traineddata (${REF}): ${lastErr && lastErr.message}`)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  console.log(`[fetch-traineddata] tessdata_fast@${REF} → ${OUT_DIR}`)
  let total = 0
  for (const code of LANGS) {
    const r = await fetchLang(code)
    total += r.bytes
    const mb = (r.bytes / 1024 / 1024).toFixed(1)
    console.log(`  ${r.cached ? '·' : '↓'} ${code.padEnd(8)} ${mb.padStart(5)} MB${r.cached ? ' (cached)' : ''}`)
  }
  console.log(`[fetch-traineddata] ${LANGS.length} packs, ${(total / 1024 / 1024).toFixed(1)} MB total.`)
}

main().catch((err) => {
  console.error(`[fetch-traineddata] FAILED: ${err.message}`)
  console.error('OCR language packs are REQUIRED to package OpenUI. Check your network and retry.')
  process.exit(1)
})
