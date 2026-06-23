/*
 * Generates the menu-bar / tray icons used by the Electron main process.
 * No external dependencies — encodes PNGs by hand using zlib.
 *
 *   resources/tray.png            16px  colored orb  (Windows / Linux)
 *   resources/tray@2x.png         32px  colored orb  (HiDPI)
 *   resources/trayTemplate.png    16px  black + alpha (macOS template image)
 *   resources/trayTemplate@2x.png 32px  black + alpha (macOS HiDPI)
 *
 * macOS template images are monochrome (black with an alpha mask); the OS
 * recolors them automatically for light/dark menu bars.
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ── CRC32 (for PNG chunks) ────────────────────────────────────────────────
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

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
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
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Anti-aliased coverage of a disc of radius r centered at (cx, cy).
function disc(x, y, cx, cy, r) {
  const dx = x + 0.5 - cx
  const dy = y + 0.5 - cy
  const d = Math.sqrt(dx * dx + dy * dy)
  return Math.max(0, Math.min(1, r + 0.5 - d))
}

// Colored orb: blue circle with a white center dot (matches the popup orb).
function coloredOrb(x, y, size) {
  const c = size / 2
  const outer = disc(x, y, c, c, size * 0.46)
  const dot = disc(x, y, c, c, size * 0.16)
  // blend white dot over blue orb
  const r = dot > 0 ? 255 : 0x00
  const g = dot > 0 ? 255 : 0x7a
  const b = dot > 0 ? 255 : 0xff
  const baseR = 0x00, baseG = 0x7a, baseB = 0xff
  const fr = Math.round(baseR * (1 - dot) + 255 * dot)
  const fg = Math.round(baseG * (1 - dot) + 255 * dot)
  const fb = Math.round(baseB * (1 - dot) + 255 * dot)
  return [fr, fg, fb, Math.round(outer * 255)]
}

// macOS template: black ring with a black center dot, alpha-masked.
function templateOrb(x, y, size) {
  const c = size / 2
  const ringOuter = disc(x, y, c, c, size * 0.46)
  const ringInner = disc(x, y, c, c, size * 0.3)
  const ring = Math.max(0, ringOuter - ringInner)
  const dot = disc(x, y, c, c, size * 0.13)
  const a = Math.max(ring, dot)
  return [0, 0, 0, Math.round(a * 255)]
}

const outDir = path.join(__dirname, '..', 'resources')
fs.mkdirSync(outDir, { recursive: true })

const targets = [
  ['tray.png', 16, coloredOrb],
  ['tray@2x.png', 32, coloredOrb],
  ['trayTemplate.png', 16, templateOrb],
  ['trayTemplate@2x.png', 32, templateOrb]
]

for (const [name, size, fn] of targets) {
  fs.writeFileSync(path.join(outDir, name), makePNG(size, fn))
  console.log('wrote resources/' + name)
}
