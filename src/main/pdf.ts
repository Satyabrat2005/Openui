/**
 * pdf.ts — native PDF generation, editing and export for the OpenUI agent.
 *
 * Self-contained tool module (schemas + registry) mirroring spreadsheet.ts,
 * presentation.ts and worddoc.ts. It creates and edits real PDFs with pdf-lib
 * and extracts text with pdf-parse, instead of driving a PDF viewer or a print
 * dialog through computer_use — deterministic, fast, and scriptable.
 *
 * EXPORT-TO-PDF, AND ITS ONE HONEST CAVEAT:
 *   export_to_pdf renders .docx / .pptx / .xlsx to PDF WITHOUT Word, PowerPoint
 *   or LibreOffice installed. For .docx/.pptx it re-renders the same sidecar
 *   spec that produced the Office file (see worddoc.ts / presentation.ts), so
 *   the CONTENT is exactly the content that was authored — headings, runs,
 *   bullets, tables, images and charts all come across.
 *
 *   It is a native re-render, NOT an Office-fidelity conversion: fonts fall back
 *   to the PDF standard family (Helvetica) and the layout is this module's own,
 *   so a page will not be pixel-identical to PowerPoint's renderer. For files
 *   authored by these tools that is the whole picture; for a file authored in
 *   Office (no sidecar) there is nothing to re-render, and the tool says so and
 *   points at the LibreOffice/Word route instead of guessing.
 *
 * SECURITY / SAFETY:
 *   - Every path passes through resolveSafePath(): reads are blocked from
 *     sensitive dirs (SENSITIVE_PATH_RE); writes are additionally confined to
 *     the user's home tree. Source PDFs are opened READ-ONLY; only the
 *     destination is resolved as mutating.
 *   - Page counts, text output, file sizes and merge inputs are all capped, so
 *     one call cannot flood context or exhaust memory. read_pdf truncates.
 *   - Encrypted PDFs are refused rather than silently mangled.
 *   - The mutating tools (create_pdf, merge_pdfs, split_pdf, watermark_pdf,
 *     export_to_pdf) are registered in STATE_CHANGING_TOOLS (tools.ts) so they
 *     are HITL-gated. read_pdf is read-only and ungated, like list_sheets.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import ExcelJS from 'exceljs'
import { resolveSafePath } from './fs/pathSafety'
import { loadDeckSpec, type ChartSpec, type DeckSpec } from './presentation'
import { loadDocSpec, type DocSpec } from './worddoc'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// Caps — keep a single accidental call from flooding context or exhausting RAM.
const MAX_PDF_BYTES = 100 * 1024 * 1024
const MAX_PAGES = 2_000
const MAX_MERGE_INPUTS = 50
const MAX_TEXT_OUTPUT = 60_000
const MAX_BLOCKS = 5_000
const MAX_TEXT_CHARS = 20_000
const MAX_XLSX_ROWS = 500
const MAX_XLSX_COLS = 15

// A4 portrait, and 16:9 landscape for slide re-rendering.
const A4: [number, number] = [595.28, 841.89]
const SLIDE: [number, number] = [720, 405]
const MARGIN = 56
const HEADING_SIZES = [22, 17, 14, 12]
const BODY_SIZE = 11
const LINE_GAP = 4

/** Categorical palette for chart series — same order pptxgenjs uses by default. */
const CHART_COLORS = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9E480E']

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** "4472C4" → pdf-lib rgb(). Falls back to black on anything malformed. */
function hex(color: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return rgb(0, 0, 0)
  const n = parseInt(m[1], 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and THROW on any character they
 * cannot encode (CJK, emoji, most typographic punctuation). Text arriving here
 * comes from model output and user documents, so it is normalised first:
 * common smart punctuation is folded to ASCII and anything still outside
 * WinAnsi becomes "?" — a readable PDF beats a failed tool call.
 */
function sanitize(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    // Non-breaking / thin / narrow-no-break spaces collapse to a plain space.
    .replace(/[\u00a0\u2007\u2009\u202f]/g, ' ')
    .replace(/[•●▪]/g, '-')
    .replace(/\t/g, '    ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x20-\x7E\xA1-\xFF]/g, '?')
}

/** Greedy word-wrap to a pixel width, honouring explicit newlines. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = []
  for (const paragraph of sanitize(text).split('\n')) {
    if (!paragraph) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      // A single word longer than the column is hard-broken by character.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = ''
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            out.push(chunk)
            chunk = ch
          } else chunk += ch
        }
        line = chunk
      } else line = word
    }
    out.push(line)
  }
  return out
}

/** The three standard faces every renderer here draws with. */
interface Fonts {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
}

async function embedFonts(pdf: PDFDocument): Promise<Fonts> {
  return {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique)
  }
}

/**
 * A tiny flowing-layout cursor: tracks the current page and y position and
 * starts a new page when content runs past the bottom margin.
 */
class Layout {
  page: PDFPage
  y: number
  readonly width: number

  constructor(
    private readonly pdf: PDFDocument,
    private readonly size: [number, number]
  ) {
    this.page = pdf.addPage(size)
    this.y = size[1] - MARGIN
    this.width = size[0] - MARGIN * 2
  }

  /** Ensure `needed` points of vertical room, breaking to a new page if not. */
  need(needed: number): void {
    if (this.y - needed >= MARGIN) return
    this.newPage()
  }

  newPage(): void {
    this.page = this.pdf.addPage(this.size)
    this.y = this.size[1] - MARGIN
  }

  text(value: string, font: PDFFont, size: number, opts: { indent?: number; color?: string } = {}): void {
    const indent = opts.indent ?? 0
    for (const line of wrap(value, font, size, this.width - indent)) {
      this.need(size + LINE_GAP)
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y - size,
        size,
        font,
        color: opts.color ? hex(opts.color) : rgb(0.1, 0.1, 0.1)
      })
      this.y -= size + LINE_GAP
    }
  }

  gap(points: number): void {
    this.y -= points
  }
}

// ── shared drawing: tables and charts ────────────────────────────────────────

/** Draw a bordered table, breaking across pages, with a bold header row. */
function drawTable(layout: Layout, rows: string[][], fonts: Fonts, size = 9): void {
  if (rows.length === 0) return
  const cols = Math.max(...rows.map((r) => r.length))
  const colWidth = layout.width / cols
  const pad = 4

  rows.forEach((row, ri) => {
    const font = ri === 0 ? fonts.bold : fonts.regular
    // Wrap every cell first so the row is as tall as its tallest cell.
    const cells = Array.from({ length: cols }, (_, ci) =>
      wrap(row[ci] ?? '', font, size, colWidth - pad * 2)
    )
    const rowHeight = Math.max(...cells.map((c) => c.length)) * (size + 2) + pad * 2
    layout.need(rowHeight)
    const top = layout.y

    for (let ci = 0; ci < cols; ci++) {
      const x = MARGIN + ci * colWidth
      layout.page.drawRectangle({
        x,
        y: top - rowHeight,
        width: colWidth,
        height: rowHeight,
        borderColor: hex('CCCCCC'),
        borderWidth: 0.5,
        color: ri === 0 ? hex('F2F2F2') : undefined
      })
      cells[ci].forEach((line, li) => {
        layout.page.drawText(line, {
          x: x + pad,
          y: top - pad - size - li * (size + 2),
          size,
          font,
          color: rgb(0.1, 0.1, 0.1)
        })
      })
    }
    layout.y = top - rowHeight
  })
  layout.gap(10)
}

/** Approximate a pie/doughnut wedge as a polygon path (no SVG arc needed). */
function wedgePath(cx: number, cy: number, r: number, from: number, to: number): string {
  const steps = Math.max(2, Math.ceil(((to - from) / (Math.PI * 2)) * 64))
  let d = `M ${cx} ${cy}`
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps
    d += ` L ${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`
  }
  return `${d} Z`
}

/**
 * Render a chart spec with pdf-lib primitives. bar/line get real axes and
 * gridlines; pie/doughnut get polygon wedges. This is what makes export_to_pdf
 * carry a deck's charts across instead of dropping them.
 */
function drawChart(layout: Layout, chart: ChartSpec, fonts: Fonts, height = 200): void {
  layout.need(height + 30)
  const top = layout.y
  const boxW = layout.width
  const originX = MARGIN + 40
  const plotW = boxW - 50
  const plotH = height - 30
  const baseY = top - height + 20

  if (chart.title) {
    layout.page.drawText(sanitize(chart.title), {
      x: MARGIN, y: top - 12, size: 11, font: fonts.bold, color: rgb(0.1, 0.1, 0.1)
    })
  }

  if (chart.type === 'pie' || chart.type === 'doughnut') {
    const values = chart.series[0]?.values ?? []
    const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1
    const r = Math.min(plotH, plotW) / 2 - 10
    const cx = MARGIN + r + 10
    const cy = baseY + plotH / 2
    let angle = -Math.PI / 2
    values.forEach((v, i) => {
      const sweep = (Math.abs(v) / total) * Math.PI * 2
      layout.page.drawSvgPath(wedgePath(cx, cy, r, angle, angle + sweep), {
        color: hex(CHART_COLORS[i % CHART_COLORS.length]),
        borderWidth: 0
      })
      angle += sweep
    })
    if (chart.type === 'doughnut') {
      layout.page.drawCircle({ x: cx, y: cy, size: r * 0.55, color: rgb(1, 1, 1) })
    }
    // Legend to the right of the pie.
    chart.labels.forEach((label, i) => {
      const ly = baseY + plotH - 12 - i * 14
      if (ly < baseY) return
      layout.page.drawRectangle({
        x: cx + r + 24, y: ly, width: 9, height: 9,
        color: hex(CHART_COLORS[i % CHART_COLORS.length])
      })
      const pct = ((Math.abs(values[i] ?? 0) / total) * 100).toFixed(0)
      layout.page.drawText(sanitize(`${label} (${pct}%)`), {
        x: cx + r + 38, y: ly, size: 8, font: fonts.regular, color: rgb(0.2, 0.2, 0.2)
      })
    })
    layout.y = top - height
    layout.gap(10)
    return
  }

  // bar / line share axes, gridlines and a value scale.
  const all = chart.series.flatMap((s) => s.values)
  const max = Math.max(...all, 0)
  const min = Math.min(...all, 0)
  const span = max - min || 1
  const scale = (v: number): number => baseY + ((v - min) / span) * plotH

  for (let i = 0; i <= 4; i++) {
    const gy = baseY + (plotH * i) / 4
    layout.page.drawLine({
      start: { x: originX, y: gy },
      end: { x: originX + plotW, y: gy },
      thickness: 0.4,
      color: hex('E0E0E0')
    })
    layout.page.drawText((min + (span * i) / 4).toFixed(0), {
      x: MARGIN, y: gy - 3, size: 7, font: fonts.regular, color: rgb(0.45, 0.45, 0.45)
    })
  }
  layout.page.drawLine({
    start: { x: originX, y: scale(0) },
    end: { x: originX + plotW, y: scale(0) },
    thickness: 0.8,
    color: hex('999999')
  })

  const slot = plotW / Math.max(chart.labels.length, 1)
  if (chart.type === 'bar') {
    const barW = Math.max(2, (slot * 0.7) / chart.series.length)
    chart.series.forEach((s, si) => {
      s.values.forEach((v, vi) => {
        const x = originX + vi * slot + slot * 0.15 + si * barW
        const yTop = scale(v)
        const zero = scale(0)
        layout.page.drawRectangle({
          x, y: Math.min(yTop, zero), width: barW, height: Math.abs(yTop - zero),
          color: hex(CHART_COLORS[si % CHART_COLORS.length])
        })
      })
    })
  } else {
    chart.series.forEach((s, si) => {
      const color = hex(CHART_COLORS[si % CHART_COLORS.length])
      for (let i = 1; i < s.values.length; i++) {
        layout.page.drawLine({
          start: { x: originX + (i - 1) * slot + slot / 2, y: scale(s.values[i - 1]) },
          end: { x: originX + i * slot + slot / 2, y: scale(s.values[i]) },
          thickness: 1.5,
          color
        })
      }
    })
  }

  // Category labels, thinned out when they would collide.
  const every = Math.ceil((chart.labels.length * 34) / Math.max(plotW, 1))
  chart.labels.forEach((label, i) => {
    if (i % every !== 0) return
    layout.page.drawText(sanitize(label).slice(0, 12), {
      x: originX + i * slot + slot / 2 - 10, y: baseY - 12, size: 7,
      font: fonts.regular, color: rgb(0.3, 0.3, 0.3)
    })
  })
  // Series legend.
  chart.series.forEach((s, si) => {
    layout.page.drawRectangle({
      x: originX + si * 90, y: baseY - 26, width: 8, height: 8,
      color: hex(CHART_COLORS[si % CHART_COLORS.length])
    })
    layout.page.drawText(sanitize(s.name).slice(0, 14), {
      x: originX + si * 90 + 12, y: baseY - 26, size: 7, font: fonts.regular, color: rgb(0.3, 0.3, 0.3)
    })
  })

  layout.y = top - height - 10
}

/** Embed a base64 image. pdf-lib handles PNG and JPEG only. */
async function drawImage(
  pdf: PDFDocument,
  layout: Layout,
  data: string,
  kind: string,
  maxW: number
): Promise<boolean> {
  const bytes = Buffer.from(data.replace(/^[^,]*,/, ''), 'base64')
  let img
  try {
    if (/png/i.test(kind)) img = await pdf.embedPng(bytes)
    else if (/jpe?g/i.test(kind)) img = await pdf.embedJpg(bytes)
    else return false
  } catch {
    return false
  }
  const w = Math.min(img.width, maxW)
  const h = (img.height / img.width) * w
  layout.need(h + 8)
  layout.page.drawImage(img, { x: MARGIN, y: layout.y - h, width: w, height: h })
  layout.y -= h + 8
  return true
}

// ── renderers: sidecar spec → PDF ────────────────────────────────────────────

async function renderDocSpec(spec: DocSpec): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  if (spec.title) pdf.setTitle(sanitize(spec.title))
  const fonts = await embedFonts(pdf)
  const layout = new Layout(pdf, A4)

  for (const block of spec.blocks) {
    if (block.kind === 'heading') {
      const size = HEADING_SIZES[Math.min(Math.max(block.level, 1), 4) - 1]
      layout.gap(6)
      layout.text(block.text, fonts.bold, size)
      layout.gap(2)
    } else if (block.kind === 'paragraph') {
      // Runs can mix faces, so each run is wrapped and drawn in sequence on the
      // same baseline until it overflows the column.
      let x = MARGIN
      layout.need(BODY_SIZE + LINE_GAP)
      for (const run of block.runs) {
        const font = run.bold ? fonts.bold : run.italic ? fonts.italic : fonts.regular
        for (const word of sanitize(run.text).split(/(\s+)/)) {
          if (!word) continue
          const w = font.widthOfTextAtSize(word, BODY_SIZE)
          if (x + w > MARGIN + layout.width && word.trim()) {
            layout.y -= BODY_SIZE + LINE_GAP
            layout.need(BODY_SIZE + LINE_GAP)
            x = MARGIN
          }
          layout.page.drawText(word, {
            x, y: layout.y - BODY_SIZE, size: BODY_SIZE, font, color: rgb(0.1, 0.1, 0.1)
          })
          x += w
        }
      }
      layout.y -= BODY_SIZE + LINE_GAP
      layout.gap(4)
    } else if (block.kind === 'table') {
      drawTable(layout, block.rows, fonts)
    } else if (block.kind === 'image') {
      await drawImage(pdf, layout, block.data, block.type, layout.width)
    } else {
      layout.newPage()
    }
  }
  return pdf
}

async function renderDeckSpec(spec: DeckSpec): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  if (spec.title) pdf.setTitle(sanitize(spec.title))
  const fonts = await embedFonts(pdf)

  for (const slide of spec.slides) {
    // One PDF page per slide — a deck exports as slide-per-page, not reflowed.
    const layout = new Layout(pdf, SLIDE)
    if (slide.layout === 'title') {
      const size = 28
      const lines = wrap(slide.heading ?? '', fonts.bold, size, layout.width)
      let y = SLIDE[1] / 2 + lines.length * size * 0.5
      for (const line of lines) {
        const w = fonts.bold.widthOfTextAtSize(line, size)
        layout.page.drawText(line, {
          x: (SLIDE[0] - w) / 2, y, size, font: fonts.bold, color: rgb(0.1, 0.1, 0.1)
        })
        y -= size + 6
      }
      if (slide.subtitle) {
        const w = fonts.regular.widthOfTextAtSize(sanitize(slide.subtitle), 14)
        layout.page.drawText(sanitize(slide.subtitle), {
          x: (SLIDE[0] - w) / 2, y: y - 6, size: 14, font: fonts.regular, color: rgb(0.4, 0.4, 0.4)
        })
      }
      layout.y = y - 30
    } else {
      if (slide.heading) {
        layout.text(slide.heading, fonts.bold, 20)
        layout.gap(6)
      }
      for (const bullet of slide.bullets ?? []) {
        layout.text(`- ${bullet.text}`, fonts.regular, 12, { indent: 14 + bullet.level * 16 })
      }
      for (const bullet of slide.bulletsRight ?? []) {
        layout.text(`- ${bullet.text}`, fonts.regular, 12, { indent: 14 + bullet.level * 16 })
      }
    }
    if (slide.image) {
      const mime = /^([^;,]+)/.exec(slide.image)?.[1] ?? ''
      await drawImage(pdf, layout, slide.image, mime, layout.width * 0.6)
    }
    for (const table of slide.tables ?? []) drawTable(layout, table, fonts, 8)
    for (const chart of slide.charts ?? []) drawChart(layout, chart, fonts, 170)
  }
  if (spec.slides.length === 0) pdf.addPage(SLIDE)
  return pdf
}

/** Render a workbook's first sheet as a table — no sidecar needed, exceljs reads. */
async function renderWorkbook(file: string): Promise<PDFDocument> {
  const wb = new ExcelJS.Workbook()
  if (/\.csv$/i.test(file)) await wb.csv.readFile(file)
  else await wb.xlsx.readFile(file)

  const pdf = await PDFDocument.create()
  const fonts = await embedFonts(pdf)
  for (const ws of wb.worksheets) {
    const layout = new Layout(pdf, A4)
    layout.text(ws.name, fonts.bold, 16)
    layout.gap(8)
    const rows: string[][] = []
    const rowCount = Math.min(ws.rowCount || 0, MAX_XLSX_ROWS)
    const colCount = Math.min(ws.columnCount || 0, MAX_XLSX_COLS)
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r)
      const cells: string[] = []
      for (let c = 1; c <= colCount; c++) {
        const v = row.getCell(c).value
        cells.push(
          v === null || v === undefined
            ? ''
            : typeof v === 'object' && 'formula' in (v as object)
              ? String((v as { result?: unknown }).result ?? '')
              : String(v)
        )
      }
      rows.push(cells)
    }
    if (rows.length) drawTable(layout, rows, fonts, 8)
  }
  return pdf
}

// ── shared path helpers ──────────────────────────────────────────────────────

function resolveOut(raw: unknown, tool: string, ext = '.pdf'): string | ToolResult {
  let file: string
  try {
    file = resolveSafePath(raw, { mutating: true })
  } catch (e) {
    return { ok: false, error: `${tool}: ${errText(e)}` }
  }
  if (ext && !new RegExp(`\\${ext}$`, 'i').test(file)) {
    return { ok: false, error: `${tool}: output path must end in ${ext} (got "${basename(file)}").` }
  }
  return file
}

/** Open a source PDF read-only, with size/encryption/page-count guards. */
async function openPdf(raw: unknown, tool: string): Promise<{ pdf: PDFDocument; file: string } | ToolResult> {
  let file: string
  try {
    file = resolveSafePath(raw, { mutating: false })
  } catch (e) {
    return { ok: false, error: `${tool}: ${errText(e)}` }
  }
  if (!/\.pdf$/i.test(file)) {
    return { ok: false, error: `${tool}: "${basename(file)}" is not a .pdf.` }
  }
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (e) {
    return { ok: false, error: `${tool}: cannot read ${file} — ${errText(e)}` }
  }
  if (bytes.length > MAX_PDF_BYTES) {
    return { ok: false, error: `${tool}: ${file} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB (limit ${MAX_PDF_BYTES / 1024 / 1024} MB).` }
  }
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false })
    if (pdf.getPageCount() > MAX_PAGES) {
      return { ok: false, error: `${tool}: ${file} has ${pdf.getPageCount()} pages (limit ${MAX_PAGES}).` }
    }
    return { pdf, file }
  } catch (e) {
    const msg = errText(e)
    if (/encrypt/i.test(msg)) {
      return { ok: false, error: `${tool}: ${file} is password-protected — it cannot be edited. Ask the user to supply an unlocked copy.` }
    }
    return { ok: false, error: `${tool}: ${file} is not a readable PDF — ${msg}` }
  }
}

async function savePdf(pdf: PDFDocument, out: string): Promise<number> {
  const bytes = await pdf.save()
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, bytes)
  return bytes.length
}

// ── read_pdf ─────────────────────────────────────────────────────────────────

async function read_pdf(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `read_pdf: ${errText(e)}` }
  }
  if (!/\.pdf$/i.test(file)) return { ok: false, error: `read_pdf: "${basename(file)}" is not a .pdf.` }

  let parser: { getText: () => Promise<{ text?: string; total?: number }>; destroy: () => Promise<void> } | null = null
  try {
    const bytes = await readFile(file)
    if (bytes.length > MAX_PDF_BYTES) {
      return { ok: false, error: `read_pdf: ${file} is too large (limit ${MAX_PDF_BYTES / 1024 / 1024} MB).` }
    }
    // pdf-parse v2 exports a PDFParse CLASS (v1's callable default is gone).
    const { PDFParse } = await import('pdf-parse')
    parser = new PDFParse({ data: bytes })
    const result = await parser.getText()
    const text = (result.text ?? '').trim()
    if (!text) {
      return {
        ok: true,
        output: `${file}: ${result.total ?? 0} page(s), but no extractable text — it is probably a scanned/image PDF. Use computer_use or an OCR pass to read it.`
      }
    }
    const clipped = text.length > MAX_TEXT_OUTPUT
    return {
      ok: true,
      output:
        `${file} — ${result.total ?? 0} page(s):\n${text.slice(0, MAX_TEXT_OUTPUT)}` +
        (clipped ? `\n… output truncated at ${MAX_TEXT_OUTPUT} chars.` : '')
    }
  } catch (e) {
    return { ok: false, error: `read_pdf failed: ${errText(e)}` }
  } finally {
    try {
      await parser?.destroy()
    } catch {
      // Releasing the worker is best-effort; the text is already extracted.
    }
  }
}

// ── create_pdf ───────────────────────────────────────────────────────────────

async function create_pdf(args: Record<string, unknown>): Promise<ToolResult> {
  const out = resolveOut(args.path, 'create_pdf')
  if (typeof out !== 'string') return out

  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const raw = args.content
  const blocks = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : null
  if (!blocks || blocks.length === 0) {
    return {
      ok: false,
      error:
        'create_pdf: "content" must be a non-empty array of blocks, e.g. ' +
        '[{"heading":"Intro","level":1},{"paragraph":"Body text"},{"bullets":["a","b"]}].'
    }
  }
  if (blocks.length > MAX_BLOCKS) {
    return { ok: false, error: `create_pdf: too many blocks (limit ${MAX_BLOCKS}).` }
  }

  // Translate the flat block list into a DocSpec and reuse the shared renderer.
  const spec: DocSpec = { version: 1, title: title || undefined, blocks: [] }
  if (title) spec.blocks.push({ kind: 'heading', text: title, level: 1 })

  for (const b of blocks) {
    if (typeof b === 'string') {
      if (b.length > MAX_TEXT_CHARS) return { ok: false, error: `create_pdf: a block exceeds ${MAX_TEXT_CHARS} chars.` }
      spec.blocks.push({ kind: 'paragraph', runs: [{ text: b }] })
      continue
    }
    if (!b || typeof b !== 'object') {
      return { ok: false, error: 'create_pdf: each content block must be a string or an object.' }
    }
    const o = b as Record<string, unknown>
    if (typeof o.heading === 'string') {
      const level = Number(o.level ?? 1)
      if (!Number.isInteger(level) || level < 1 || level > 4) {
        return { ok: false, error: `create_pdf: heading "level" must be 1-4 (got ${String(o.level)}).` }
      }
      spec.blocks.push({ kind: 'heading', text: o.heading, level })
    } else if (typeof o.paragraph === 'string') {
      if (o.paragraph.length > MAX_TEXT_CHARS) {
        return { ok: false, error: `create_pdf: a paragraph exceeds ${MAX_TEXT_CHARS} chars.` }
      }
      spec.blocks.push({
        kind: 'paragraph',
        runs: [{ text: o.paragraph, bold: o.bold === true || undefined, italic: o.italic === true || undefined }]
      })
    } else if (Array.isArray(o.bullets)) {
      for (const bullet of o.bullets) {
        spec.blocks.push({ kind: 'paragraph', runs: [{ text: `- ${String(bullet)}` }] })
      }
    } else if (Array.isArray(o.rows) || Array.isArray(o.table)) {
      const rows = (Array.isArray(o.rows) ? o.rows : o.table) as unknown[]
      spec.blocks.push({
        kind: 'table',
        rows: rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')]))
      })
    } else if (o.page_break === true) {
      spec.blocks.push({ kind: 'pagebreak' })
    } else {
      return {
        ok: false,
        error: 'create_pdf: unknown block — use { heading, level }, { paragraph }, { bullets }, { rows }, or { page_break: true }.'
      }
    }
  }

  try {
    const pdf = await renderDocSpec(spec)
    const bytes = await savePdf(pdf, out)
    return { ok: true, output: `Created ${out} — ${pdf.getPageCount()} page(s), ${(bytes / 1024).toFixed(1)} KB.` }
  } catch (e) {
    return { ok: false, error: `create_pdf failed: ${errText(e)}` }
  }
}

// ── merge_pdfs ───────────────────────────────────────────────────────────────

async function merge_pdfs(args: Record<string, unknown>): Promise<ToolResult> {
  const out = resolveOut(args.output, 'merge_pdfs')
  if (typeof out !== 'string') return out

  const paths = Array.isArray(args.paths) ? args.paths : null
  if (!paths || paths.length < 2) {
    return { ok: false, error: 'merge_pdfs: "paths" must be an array of at least two .pdf paths, in order.' }
  }
  if (paths.length > MAX_MERGE_INPUTS) {
    return { ok: false, error: `merge_pdfs: too many inputs (limit ${MAX_MERGE_INPUTS}).` }
  }

  try {
    const merged = await PDFDocument.create()
    let total = 0
    for (const p of paths) {
      const opened = await openPdf(p, 'merge_pdfs')
      if (!('pdf' in opened)) return opened
      const pages = await merged.copyPages(opened.pdf, opened.pdf.getPageIndices())
      for (const page of pages) merged.addPage(page)
      total += pages.length
      if (total > MAX_PAGES) return { ok: false, error: `merge_pdfs: combined output exceeds ${MAX_PAGES} pages.` }
    }
    const bytes = await savePdf(merged, out)
    return { ok: true, output: `Merged ${paths.length} PDFs into ${out} — ${total} page(s), ${(bytes / 1024).toFixed(1)} KB.` }
  } catch (e) {
    return { ok: false, error: `merge_pdfs failed: ${errText(e)}` }
  }
}

// ── split_pdf ────────────────────────────────────────────────────────────────

/** Parse "1-3,7,10-12" into 0-based page indices, validated against the doc. */
function parseRanges(spec: string, pageCount: number): number[] | string {
  const out: number[] = []
  for (const part of spec.split(',')) {
    const chunk = part.trim()
    if (!chunk) continue
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(chunk)
    if (!m) return `bad page range "${chunk}" (expected e.g. "1-3", "5", or "1-3,7").`
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (from < 1 || to < from) return `bad page range "${chunk}" (pages are 1-based and ascending).`
    if (to > pageCount) return `page ${to} is out of range — the document has ${pageCount} page(s).`
    for (let p = from; p <= to; p++) out.push(p - 1)
  }
  if (out.length === 0) return 'no pages selected.'
  return out
}

async function split_pdf(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openPdf(args.path, 'split_pdf')
  if (!('pdf' in opened)) return opened
  const { pdf, file } = opened
  const out = resolveOut(args.output, 'split_pdf')
  if (typeof out !== 'string') return out

  const spec = typeof args.pages === 'string' ? args.pages.trim() : ''
  if (!spec) {
    return { ok: false, error: 'split_pdf: "pages" is required, e.g. "1-3" or "1,4,9-12".' }
  }
  const indices = parseRanges(spec, pdf.getPageCount())
  if (typeof indices === 'string') return { ok: false, error: `split_pdf: ${indices}` }

  try {
    const extracted = await PDFDocument.create()
    const pages = await extracted.copyPages(pdf, indices)
    for (const page of pages) extracted.addPage(page)
    const bytes = await savePdf(extracted, out)
    return {
      ok: true,
      output: `Extracted page(s) ${spec} from ${file} into ${out} — ${pages.length} page(s), ${(bytes / 1024).toFixed(1)} KB.`
    }
  } catch (e) {
    return { ok: false, error: `split_pdf failed: ${errText(e)}` }
  }
}

// ── watermark_pdf ────────────────────────────────────────────────────────────

async function watermark_pdf(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openPdf(args.path, 'watermark_pdf')
  if (!('pdf' in opened)) return opened
  const { pdf, file } = opened

  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (!text) return { ok: false, error: 'watermark_pdf: "text" must be a non-empty string, e.g. "DRAFT".' }
  if (text.length > 120) return { ok: false, error: 'watermark_pdf: "text" is too long (limit 120 chars).' }

  // Default to writing in place — a watermark is normally meant to stick.
  const out = args.output === undefined || args.output === null || args.output === ''
    ? resolveOut(file, 'watermark_pdf')
    : resolveOut(args.output, 'watermark_pdf')
  if (typeof out !== 'string') return out

  const opacity = args.opacity === undefined ? 0.18 : Number(args.opacity)
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) {
    return { ok: false, error: `watermark_pdf: "opacity" must be between 0 and 1 (got ${String(args.opacity)}).` }
  }

  try {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold)
    const clean = sanitize(text)
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize()
      // Scale the text to ~70% of the diagonal so it reads on any page size.
      const size = Math.min(90, (Math.hypot(width, height) * 0.7) / Math.max(font.widthOfTextAtSize(clean, 10) / 10, 1))
      const textWidth = font.widthOfTextAtSize(clean, size)
      page.drawText(clean, {
        x: width / 2 - (textWidth / 2) * Math.cos(Math.PI / 6),
        y: height / 2 - (textWidth / 2) * Math.sin(Math.PI / 6),
        size,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity,
        rotate: degrees(30)
      })
    }
    const bytes = await savePdf(pdf, out)
    return {
      ok: true,
      output: `Watermarked ${pdf.getPageCount()} page(s) with "${text}" → ${out} (${(bytes / 1024).toFixed(1)} KB).`
    }
  } catch (e) {
    return { ok: false, error: `watermark_pdf failed: ${errText(e)}` }
  }
}

// ── export_to_pdf ────────────────────────────────────────────────────────────

async function export_to_pdf(args: Record<string, unknown>): Promise<ToolResult> {
  let src: string
  try {
    src = resolveSafePath(args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `export_to_pdf: ${errText(e)}` }
  }
  const ext = extname(src).toLowerCase()
  if (!['.docx', '.pptx', '.xlsx', '.csv'].includes(ext)) {
    return {
      ok: false,
      error: `export_to_pdf: unsupported source "${ext || '(none)'}" — supports .docx, .pptx, .xlsx and .csv.`
    }
  }

  const out = args.output === undefined || args.output === null || args.output === ''
    ? resolveOut(join(dirname(src), `${basename(src, extname(src))}.pdf`), 'export_to_pdf')
    : resolveOut(args.output, 'export_to_pdf')
  if (typeof out !== 'string') return out

  try {
    let pdf: PDFDocument
    let what: string
    if (ext === '.docx') {
      const spec = await loadDocSpec(src)
      if (!spec) return noSidecar('export_to_pdf', src, 'document')
      pdf = await renderDocSpec(spec)
      what = `${spec.blocks.length} block(s)`
    } else if (ext === '.pptx') {
      const spec = await loadDeckSpec(src)
      if (!spec) return noSidecar('export_to_pdf', src, 'deck')
      pdf = await renderDeckSpec(spec)
      what = `${spec.slides.length} slide(s)`
    } else {
      // Workbooks need no sidecar — exceljs reads any .xlsx/.csv directly.
      pdf = await renderWorkbook(src)
      what = 'workbook'
    }
    const bytes = await savePdf(pdf, out)
    return {
      ok: true,
      output:
        `Exported ${basename(src)} (${what}) → ${out} — ${pdf.getPageCount()} page(s), ${(bytes / 1024).toFixed(1)} KB. ` +
        `Native render: content is exact, but fonts/layout are not pixel-identical to Word/PowerPoint.`
    }
  } catch (e) {
    return { ok: false, error: `export_to_pdf failed: ${errText(e)}` }
  }
}

/** Shared "this file wasn't made by us" error for export_to_pdf. */
function noSidecar(tool: string, file: string, kind: string): ToolResult {
  return {
    ok: false,
    error:
      `${tool}: ${file} has no OpenUI ${kind} spec, so there is nothing to re-render. ` +
      `Only ${kind}s created by these tools can be exported natively. For a file authored in Office, ` +
      `convert it with LibreOffice ("soffice --headless --convert-to pdf") or Word's own Save-As-PDF ` +
      `via computer_use — this tool will not guess at its layout.`
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const pdfToolSchemas: ToolSchema[] = [
  {
    name: 'read_pdf',
    description:
      'Extract the text of a PDF and return it. Use this to READ a PDF instead of opening it with ' +
      'computer_use. Returns a clear notice when the PDF is scanned/image-only and has no text layer.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .pdf file.' }
      },
      required: ['path']
    }
  },
  {
    name: 'create_pdf',
    description:
      'Create a PDF natively from a list of content blocks — no Word/print dialog involved. ' +
      'Prefer this over computer_use for generating a PDF. To turn an existing .docx/.pptx/.xlsx ' +
      'into a PDF instead, use export_to_pdf.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination .pdf path inside your home folder.' },
        title: { type: 'string', description: 'Optional document title; becomes the first heading and the PDF metadata title.' },
        content: {
          type: 'array',
          description:
            'Array of blocks, in order. Each is { "heading": "...", "level": 1-4 }, { "paragraph": "...", "bold": true }, ' +
            '{ "bullets": ["a","b"] }, { "rows": [["H1","H2"],["a","b"]] } for a table, or { "page_break": true }. ' +
            'A plain string is treated as a paragraph.'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'merge_pdfs',
    description: 'Combine several PDFs into one, in the order given.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', description: 'Array of at least two .pdf paths to merge, in order.' },
        output: { type: 'string', description: 'Destination .pdf path for the combined file.' }
      },
      required: ['paths', 'output']
    }
  },
  {
    name: 'split_pdf',
    description: 'Extract a page range from a PDF into a new PDF, e.g. pull pages 1-3 out of a report.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source .pdf.' },
        pages: { type: 'string', description: '1-based pages to extract, e.g. "1-3", "5", or "1-3,7,10-12".' },
        output: { type: 'string', description: 'Destination .pdf path for the extracted pages.' }
      },
      required: ['path', 'pages', 'output']
    }
  },
  {
    name: 'watermark_pdf',
    description: 'Stamp diagonal watermark text (e.g. "DRAFT", "CONFIDENTIAL") across every page of a PDF.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .pdf to watermark.' },
        text: { type: 'string', description: 'The watermark text, e.g. "DRAFT".' },
        opacity: { type: 'number', description: 'Optional 0-1 opacity (default 0.18).' },
        output: { type: 'string', description: 'Optional destination .pdf. Defaults to overwriting the source in place.' }
      },
      required: ['path', 'text']
    }
  },
  {
    name: 'export_to_pdf',
    description:
      'Convert a .docx, .pptx, .xlsx or .csv into a PDF natively — no Word, PowerPoint or LibreOffice needed. ' +
      'This is the "save/print as PDF" step for files these tools created. Workbooks convert directly; ' +
      '.docx/.pptx must have been created by create_document / create_presentation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source .docx/.pptx/.xlsx/.csv file.' },
        output: { type: 'string', description: 'Optional destination .pdf. Defaults to the same name and folder with a .pdf extension.' }
      },
      required: ['path']
    }
  }
]

export const pdfRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  read_pdf,
  create_pdf,
  merge_pdfs,
  split_pdf,
  watermark_pdf,
  export_to_pdf
}

// Shared with mailmerge.ts so a merged run can emit PDFs directly.
export { renderDocSpec, savePdf }
