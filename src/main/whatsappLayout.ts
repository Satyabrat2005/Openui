/**
 * whatsappLayout — reading WhatsApp Desktop's window as two panes.
 *
 * WhatsApp has no API on the desktop, so OpenUI reads it by OCR. OCR of the
 * WHOLE window was the reason summaries came back as nonsense: tesseract reads
 * across the page, so every line spliced a chat-list name onto a sentence from
 * the open conversation ("Colossal-a-pi… 19:11 and more thing for any other…").
 * Measured on a real window (2026-10-23), splitting at the divider first turns
 * the conversation pane into clean, one-message-per-line text.
 *
 * Everything here is pure (pixels and OCR lines in, structure out) so it can be
 * tested without a WhatsApp window. The capture and the clicks live in tools.ts.
 */

/** A decoded RGBA frame, the shape jimp's bitmap exposes. */
export interface RgbaFrame {
  width: number
  height: number
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array | Buffer
}

/** One OCR'd line with its box, in pixels of the image it was read from. */
export interface OcrBox {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Where the panes sit if no divider can be found: measured on a real window. */
export const FALLBACK_SPLIT = 0.42

function lum(f: RgbaFrame, x: number, y: number): number {
  const i = (y * f.width + x) * 4
  return 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2]
}

/**
 * The x (as a fraction of width) of the chat-list | conversation divider.
 *
 * The divider is the one vertical edge that runs unbroken down the window: text
 * and avatars make edges too, but never at the same x on almost every row. The
 * list's width depends on the window's, so a fixed fraction is wrong for most
 * windows (the old 0.34 cut through the chat list on an 800px-wide window).
 * Returns null when no column is an edge on at least 80% of sampled rows.
 */
export function findPaneSplit(f: RgbaFrame): number | null {
  const y0 = Math.round(f.height * 0.2)
  const y1 = Math.round(f.height * 0.85)
  const rows = Math.max(1, Math.floor((y1 - y0) / 2))
  let best = { x: -1, coverage: 0 }
  for (let x = Math.max(1, Math.round(f.width * 0.2)); x < Math.round(f.width * 0.7); x++) {
    let edges = 0
    for (let y = y0; y < y1; y += 2) if (Math.abs(lum(f, x, y) - lum(f, x - 1, y)) > 4) edges++
    const coverage = edges / rows
    if (coverage > best.coverage) best = { x, coverage }
  }
  return best.coverage >= 0.8 ? best.x / f.width : null
}

/** True for WhatsApp's own green: unread badges, unread times, the "All" chip. */
function isWhatsAppGreen(f: RgbaFrame, x: number, y: number): boolean {
  const i = (y * f.width + x) * 4
  const r = f.data[i]
  const g = f.data[i + 1]
  const b = f.data[i + 2]
  return g > 150 && r < 120 && b < 160 && g - r > 70
}

/**
 * Rows (pixel y ranges) of the chat list that carry a green unread badge.
 *
 * OCR misses badges about half the time — the digit sits in a filled circle —
 * but their colour is unambiguous, so unread is decided by colour. Only the
 * right-hand third of the list is scanned: that is where badges sit, and it
 * keeps green avatars out.
 */
export function findBadgeRows(f: RgbaFrame, fromY = 0): Array<{ y0: number; y1: number }> {
  const xStart = Math.round(f.width * 0.67)
  const rows: Array<{ y0: number; y1: number }> = []
  let runStart = -1
  for (let y = Math.max(0, fromY); y < f.height; y++) {
    let green = 0
    for (let x = xStart; x < f.width; x++) if (isWhatsAppGreen(f, x, y)) green++
    const hit = green >= 3
    if (hit && runStart < 0) runStart = y
    if (!hit && runStart >= 0) {
      // A badge is a circle ~10-30px tall; a 1-2px run is anti-aliasing noise.
      if (y - runStart >= 6) rows.push({ y0: runStart, y1: y })
      runStart = -1
    }
  }
  return rows
}

/** One chat in the list, as read off the screen. */
export interface ListedChat {
  name: string
  /** The last message as the list shows it (WhatsApp truncates it). */
  preview: string
  /**
   * Has a green unread badge. Decided by colour, not OCR: the badge digit sits
   * in a filled circle and was misread in measurement (a "1" read as "4"), so
   * the count itself is not reported.
   */
  unread: boolean
}

// "19:11", "7:05 pm", "Yesterday", "Monday", "23/10/2026", "10/23/26" — and
// "1842", which is how OCR read a real "18:42" (the colon dropped out).
const TIME_AT_END =
  /\s+((?:[01]?\d|2[0-3])[:.]?[0-5]\d(\s?[ap]\.?m\.?)?|yesterday|today|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?|\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i

/** A trailing "(3)" / "125" badge digit OCR read into the preview — not message text. */
const BADGE_AT_END = /\s*[([]?(\d{1,4})[)\]]?\s*$/

/**
 * Turn the chat list's OCR lines into chats, marking the ones with a badge.
 *
 * A chat row is a NAME line ending in a time, then a PREVIEW line. `badgeRows`
 * (from findBadgeRows, same coordinates as `lines`) decides which are unread.
 * Lines above `headerBottom` (title, search box, filter chips) are ignored.
 */
export function parseChatList(
  lines: OcrBox[],
  badgeRows: Array<{ y0: number; y1: number }>,
  headerBottom = 0
): ListedChat[] {
  const rows = lines
    .filter((l) => l.y0 >= headerBottom && l.text.trim())
    .sort((a, b) => a.y0 - b.y0)
  const chats: ListedChat[] = []
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].text.trim().match(TIME_AT_END)
    if (!m) continue
    const name = cleanName(rows[i].text.trim().slice(0, m.index))
    if (!name) continue
    const next = rows[i + 1] && !TIME_AT_END.test(rows[i + 1].text.trim()) ? rows[i + 1] : null
    const top = rows[i].y0
    const bottom = next ? next.y1 : rows[i].y1 + (rows[i].y1 - rows[i].y0) * 2
    const badged = badgeRows.some((b) => b.y1 >= top && b.y0 <= bottom)
    let preview = next ? next.text.trim() : ''
    const bm = preview.match(BADGE_AT_END)
    if (bm && bm.index !== undefined && bm.index > 0) preview = preview.slice(0, bm.index)
    chats.push({ name, preview: cleanPreview(preview), unread: badged })
  }
  return chats
}

/** Strip OCR'd icon debris from the start: "> Echo", "° 9 Colossal…", "a ~coding…". */
function stripLeadingDebris(raw: string): string {
  return raw.replace(/^([^\p{L}\p{N}~]+|\S\s+)+/u, '').trim()
}

function cleanName(raw: string): string {
  return stripLeadingDebris(raw)
}

/** Drop the mention/mute icons OCR reads as "@" or stray symbols at the end. */
function cleanPreview(raw: string): string {
  return stripLeadingDebris(raw.replace(/(\s+[^\p{L}\p{N}\s]{1,2}|\s+\p{L})+\s*$/u, ''))
}

/** WhatsApp's own text in the conversation pane — never a message. */
const CONVERSATION_CHROME = [
  /^type a message$/i,
  /^click here for (group|contact) info$/i,
  /^\d+ unread messages?$/i,
  /^messages and calls are end-to-end encrypted/i,
  /^(today|yesterday)$/i
]

/**
 * The conversation pane's OCR lines as message text, oldest first.
 * Drops WhatsApp's own labels and OCR debris (lines with fewer than 2 letters).
 */
export function conversationLines(lines: OcrBox[]): string[] {
  return lines
    .slice()
    .sort((a, b) => a.y0 - b.y0)
    .map((l) => l.text.replace(/\s+/g, ' ').trim())
    .filter((t) => (t.match(/\p{L}/gu) ?? []).length >= 2)
    .filter((t) => !CONVERSATION_CHROME.some((re) => re.test(t)))
}

/** A listed name with WhatsApp's truncation removed, for searching. */
export function searchableName(listed: string): string {
  return listed.replace(/(\.{2,}|…)\s*$/u, '').trim()
}
