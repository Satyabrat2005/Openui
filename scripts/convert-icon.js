/*
 * convert-icon.js — produce the Windows / macOS application icons.
 *
 *   resources/icon.png    1024px  source app icon (also used by png2icons)
 *   resources/icon.ico    multi-size Windows installer / app icon (16…256)
 *   resources/icon.icns   macOS app icon (only when png2icons is available)
 *
 * The task brief calls for a script that uses the `png2icons` npm package to
 * convert a >=256px PNG to .ico. OpenUI ships no branded source art, so this
 * script first SYNTHESISES a 1024px "orb" PNG (the same blue orb used for the
 * tray icon and the in-app popup) with nothing but Node's built-in `zlib`, then
 * converts it:
 *
 *   • If `png2icons` is installed (it is listed in devDependencies, so a normal
 *     `npm install` provides it) the PNG is converted with png2icons, which
 *     emits the most broadly-compatible BMP+PNG hybrid .ico and a real .icns.
 *   • If `png2icons` is absent (e.g. an offline checkout) the script falls back
 *     to a built-in multi-size PNG-in-ICO encoder. Modern Windows (Vista+) and
 *     electron-builder both accept PNG-compressed .ico entries, and the 256px
 *     entry satisfies electron-builder's "icon must be at least 256x256" rule.
 *
 * Run directly (`node scripts/convert-icon.js`) or via `npm run icons`.
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OUT_DIR = path.join(__dirname, '..', 'resources')
const SOURCE_PNG = path.join(OUT_DIR, 'icon.png')
const ICO_PATH = path.join(OUT_DIR, 'icon.ico')
const ICNS_PATH = path.join(OUT_DIR, 'icon.icns')

// ── PNG encoding (no dependencies — hand-rolled, same approach as the tray
//    icon generator) ─────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

// drawFn(x, y, size) -> [r, g, b, a]
function makePNG(size, drawFn) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter type 0 (none)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawFn(x, y, size)
      const off = y * (stride + 1) + 1 + x * 4
      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const idat = zlib.deflateSync(raw, { level: 9 })
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ── Icon artwork ────────────────────────────────────────────────────────────
// Anti-aliased coverage (0..1) of a disc of radius r centred at (cx, cy).
function disc(x, y, cx, cy, r) {
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
  return Math.max(0, Math.min(1, r + 0.5 - d))
}

// Anti-aliased coverage (0..1) of a rounded square centred in the canvas.
function roundedSquare(x, y, size, inset, radius) {
  const px = x + 0.5
  const py = y + 0.5
  const lo = inset
  const hi = size - inset
  // Distance OUTSIDE the rounded-rect (0 when fully inside the straight edges).
  const dx = Math.max(lo + radius - px, px - (hi - radius), 0)
  const dy = Math.max(lo + radius - py, py - (hi - radius), 0)
  // Inside the corner arcs, measure against the corner centre.
  const inCornerX = px < lo + radius || px > hi - radius
  const inCornerY = py < lo + radius || py > hi - radius
  let d
  if (inCornerX && inCornerY) d = Math.hypot(dx, dy) - radius
  else d = Math.max(lo - px, px - hi, lo - py, py - hi)
  return Math.max(0, Math.min(1, 0.5 - d))
}

// Composite `src` (rgba, premultiplied-by-alpha conceptually) over `dst`.
function over(dst, src) {
  const sa = src[3] / 255
  const da = dst[3] / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) return [0, 0, 0, 0]
  const blend = (s, d) => Math.round((s * sa + d * da * (1 - sa)) / oa)
  return [blend(src[0], dst[0]), blend(src[1], dst[1]), blend(src[2], dst[2]), Math.round(oa * 255)]
}

// The OpenUI mark: a blue rounded-square tile with a glowing white orb.
function appIcon(x, y, size) {
  const c = size / 2
  let px = [0, 0, 0, 0]

  // Rounded-square background with a top→bottom blue gradient.
  const bg = roundedSquare(x, y, size, size * 0.06, size * 0.22)
  if (bg > 0) {
    const t = y / size
    const r = Math.round(0x0a * (1 - t) + 0x00 * t)
    const g = Math.round(0x84 * (1 - t) + 0x5a * t)
    const b = Math.round(0xff * (1 - t) + 0xe0 * t)
    px = over(px, [r, g, b, Math.round(bg * 255)])
  }

  // Soft white glow behind the orb.
  const glow = disc(x, y, c, c, size * 0.34)
  if (glow > 0) px = over(px, [255, 255, 255, Math.round(glow * glow * 90)])

  // Outer white ring.
  const ringOuter = disc(x, y, c, c, size * 0.26)
  const ringInner = disc(x, y, c, c, size * 0.18)
  const ring = Math.max(0, ringOuter - ringInner)
  if (ring > 0) px = over(px, [255, 255, 255, Math.round(ring * 235)])

  // Solid white centre dot.
  const dot = disc(x, y, c, c, size * 0.12)
  if (dot > 0) px = over(px, [255, 255, 255, Math.round(dot * 255)])

  return px
}

// ── Built-in PNG-in-ICO encoder (used when png2icons is unavailable) ─────────
function buildIco(pngBySize) {
  const sizes = Object.keys(pngBySize)
    .map(Number)
    .sort((a, b) => a - b)
  const count = sizes.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const bodies = []
  sizes.forEach((size, i) => {
    const png = pngBySize[size]
    const e = i * 16
    dir[e] = size >= 256 ? 0 : size // width  (0 means 256)
    dir[e + 1] = size >= 256 ? 0 : size // height (0 means 256)
    dir[e + 2] = 0 // palette count
    dir[e + 3] = 0 // reserved
    dir.writeUInt16LE(1, e + 4) // colour planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(png.length, e + 8) // bytes in resource
    dir.writeUInt32LE(offset, e + 12) // offset of image data
    offset += png.length
    bodies.push(png)
  })
  return Buffer.concat([header, dir, ...bodies])
}

// ── Main ────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true })

// 1. Synthesise the high-resolution source PNG.
const source = makePNG(1024, appIcon)
fs.writeFileSync(SOURCE_PNG, source)
console.log('wrote resources/icon.png (1024x1024 source)')

// 2. Convert to .ico (+ .icns) — prefer png2icons, fall back to the built-in encoder.
let png2icons = null
try {
  png2icons = require('png2icons')
} catch {
  /* not installed — use the built-in encoder below */
}

if (png2icons) {
  const ico = png2icons.createICO(source, png2icons.BILINEAR, 0, false)
  fs.writeFileSync(ICO_PATH, ico)
  console.log('wrote resources/icon.ico (via png2icons)')

  const icns = png2icons.createICNS(source, png2icons.BILINEAR, 0)
  if (icns) {
    fs.writeFileSync(ICNS_PATH, icns)
    console.log('wrote resources/icon.icns (via png2icons)')
  }
} else {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngBySize = {}
  for (const s of sizes) pngBySize[s] = makePNG(s, appIcon)
  fs.writeFileSync(ICO_PATH, buildIco(pngBySize))
  console.log(`wrote resources/icon.ico (built-in encoder, sizes: ${sizes.join(', ')})`)
  console.log('note: png2icons not installed — skipped resources/icon.icns (macOS only).')
  console.log('      run `npm install` to enable the png2icons path for .icns output.')
}
