/**
 * presentation.ts — native PowerPoint automation for the OpenUI agent (Part 4.2).
 *
 * Self-contained tool module (schemas + registry) mirroring spreadsheet.ts and
 * figma.ts. It builds real .pptx decks with pptxgenjs instead of driving the
 * PowerPoint GUI through computer_use — deterministic, fast, and scriptable.
 *
 * WHY THERE IS A SIDECAR SPEC:
 *   pptxgenjs is WRITE-ONLY — it has no load/open/parse API, so a .pptx on disk
 *   cannot be re-opened and appended to. To make add_slide/add_chart/add_table
 *   incremental anyway, every deck these tools create is accompanied by a JSON
 *   "deck spec" sidecar (".<name>.pptx.openui.json") holding the slide model.
 *   Each mutating tool loads that spec, appends to it, re-renders the WHOLE
 *   .pptx from scratch, and saves the spec back. The .pptx stays a completely
 *   normal PowerPoint file — the sidecar is additive metadata, never embedded
 *   into the OOXML package (an undeclared zip part would make PowerPoint prompt
 *   to "repair" the file).
 *
 *   The consequence is a REAL limitation the model must know about: these tools
 *   cannot edit a .pptx authored in PowerPoint, and cannot attach to a deck
 *   already open in a running PowerPoint instance. Mutating a deck with no
 *   sidecar fails with a message pointing at computer_use. See the presentation
 *   workflow block in agent.ts.
 *
 * SECURITY / SAFETY:
 *   - Every path passes through resolveSafePath(): reads are blocked from
 *     sensitive dirs (SENSITIVE_PATH_RE); writes are additionally confined to
 *     the user's home tree. Same trust boundary as the file_* tools. Image
 *     paths are resolved READ-ONLY (mutating: false) — they are only ever read.
 *   - Slide/bullet/table/chart/image sizes are capped to avoid context flooding
 *     and runaway memory on a hostile or accidental huge input.
 *   - The five mutating tools (create_presentation, add_slide, add_chart,
 *     add_table, set_slide_notes) are registered in STATE_CHANGING_TOOLS
 *     (tools.ts) so they are HITL-gated. list_slides is read-only and ungated,
 *     exactly like list_sheets.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import PptxGenJS from 'pptxgenjs'
import { resolveSafePath } from './fs/pathSafety'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// Caps — keep a single accidental call from flooding context or exhausting RAM.
const MAX_SLIDES = 200
const MAX_BULLETS_PER_SLIDE = 60
const MAX_BULLET_CHARS = 2_000
const MAX_BULLET_LEVEL = 4
const MAX_TABLE_ROWS = 200
const MAX_TABLE_COLS = 20
const MAX_CELL_CHARS = 1_000
const MAX_CHART_SERIES = 12
const MAX_CHART_POINTS = 300
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_NOTES_CHARS = 10_000
const MAX_HEADING_CHARS = 500
const MAX_OUTPUT_CHARS = 60_000

const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut'] as const
const LAYOUTS = ['title', 'title+content', 'two-content', 'blank'] as const

type ChartTypeName = (typeof CHART_TYPES)[number]
type LayoutName = (typeof LAYOUTS)[number]

/** Image extensions pptxgenjs can embed, mapped to their MIME type. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── deck spec (the sidecar model re-rendered on every mutation) ───────────────

export interface BulletSpec {
  text: string
  level: number
}

export interface ChartSpec {
  type: ChartTypeName
  labels: string[]
  series: { name: string; values: number[] }[]
  title?: string
  showLegend?: boolean
  showValue?: boolean
}

export interface SlideSpec {
  layout: LayoutName
  heading?: string
  subtitle?: string
  bullets?: BulletSpec[]
  bulletsRight?: BulletSpec[]
  image?: string
  notes?: string
  charts?: ChartSpec[]
  tables?: string[][][]
}

export interface DeckSpec {
  version: 1
  title?: string
  slides: SlideSpec[]
}

/** Sidecar path for a deck: ~/x/deck.pptx → ~/x/.deck.pptx.openui.json */
function sidecarPath(file: string): string {
  return join(dirname(file), `.${basename(file)}.openui.json`)
}

/**
 * Read a deck's sidecar spec. Exported so pdf.ts can render the SAME model to
 * PDF without reimplementing the sidecar convention.
 */
export async function loadDeckSpec(file: string): Promise<DeckSpec | null> {
  return loadSpec(file)
}

/** Load a deck spec, or null when the file was not created by these tools. */
async function loadSpec(file: string): Promise<DeckSpec | null> {
  try {
    const raw = await readFile(sidecarPath(file), 'utf8')
    const spec = JSON.parse(raw) as DeckSpec
    if (!spec || !Array.isArray(spec.slides)) return null
    return spec
  } catch {
    return null
  }
}

async function saveSpec(file: string, spec: DeckSpec): Promise<void> {
  await writeFile(sidecarPath(file), JSON.stringify(spec, null, 2), 'utf8')
}

/**
 * The error every mutating tool returns when the target has no sidecar. Names
 * the real limitation and the fallback, so the model stops retrying natively.
 */
function noSpecError(tool: string, file: string): ToolResult {
  return {
    ok: false,
    error:
      `${tool}: no OpenUI deck spec found for ${file}. These tools can only edit presentations ` +
      `they created themselves (start with create_presentation). They CANNOT open a .pptx authored ` +
      `in PowerPoint, and cannot attach to a deck already open in a running PowerPoint window — ` +
      `for those, fall back to computer_use.`
  }
}

// ── input coercion + validation ──────────────────────────────────────────────

/** Trim a string arg, returning '' for anything that is not a non-empty string. */
function str(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Normalise the `bullets` input into BulletSpec[], or return an error string.
 * Accepts ["a","b"] or [{text,level}] so the model can nest sub-bullets.
 */
function coerceBullets(raw: unknown, field: string): BulletSpec[] | string {
  if (raw === undefined || raw === null) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  if (arr.length > MAX_BULLETS_PER_SLIDE) {
    return `too many ${field} (limit ${MAX_BULLETS_PER_SLIDE} per slide).`
  }
  const out: BulletSpec[] = []
  for (const item of arr) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      const text = String(item)
      if (text.length > MAX_BULLET_CHARS) return `a ${field} entry exceeds ${MAX_BULLET_CHARS} chars.`
      out.push({ text, level: 0 })
      continue
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const text = typeof o.text === 'string' ? o.text : ''
      if (!text) return `each ${field} entry needs a non-empty "text".`
      if (text.length > MAX_BULLET_CHARS) return `a ${field} entry exceeds ${MAX_BULLET_CHARS} chars.`
      const rawLevel = o.level ?? o.indentLevel ?? 0
      const level = Number(rawLevel)
      if (!Number.isFinite(level) || level < 0 || level > MAX_BULLET_LEVEL) {
        return `a ${field} entry has level ${String(rawLevel)} (expected 0-${MAX_BULLET_LEVEL}).`
      }
      out.push({ text, level: Math.floor(level) })
      continue
    }
    return `each ${field} entry must be a string or { text, level }.`
  }
  return out
}

/**
 * Normalise a 2-D table into string rows — the same `data` convention as
 * write_spreadsheet, so the model reuses a shape it already knows.
 */
function coerceTableRows(raw: unknown): string[][] | string {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)
      ? (raw as { rows: unknown[] }).rows
      : null
  if (!rows) return 'expected an array of rows (or { rows: [...] }), each row an array of cell values.'
  if (rows.length === 0) return 'at least one row is required.'
  if (rows.length > MAX_TABLE_ROWS) return `too many rows (limit ${MAX_TABLE_ROWS}).`
  const out: string[][] = []
  for (const row of rows) {
    const arr = Array.isArray(row) ? row : [row]
    if (arr.length > MAX_TABLE_COLS) return `too many columns (limit ${MAX_TABLE_COLS}).`
    out.push(
      arr.map((cell) => {
        const s = cell === null || cell === undefined ? '' : String(cell)
        return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s
      })
    )
  }
  return out
}

/**
 * Normalise chart `data` into labels + series, or return an error string.
 * Accepts { labels, series:[{name, values}] } and the flatter
 * { labels, values } / [{name, labels, values}] shapes.
 */
function coerceChartData(raw: unknown): { labels: string[]; series: { name: string; values: number[] }[] } | string {
  if (!raw || typeof raw !== 'object') {
    return 'expected { "labels": ["Q1","Q2"], "series": [{ "name": "Revenue", "values": [10, 20] }] }.'
  }
  // [{ name, labels, values }] — pptxgenjs' own native shape.
  if (Array.isArray(raw)) {
    const first = raw[0] as Record<string, unknown> | undefined
    if (!first || !Array.isArray(first.labels)) {
      return 'when "data" is an array, each entry needs "labels" and "values".'
    }
    const labels = (first.labels as unknown[]).map((l) => String(l))
    const series: { name: string; values: number[] }[] = []
    for (const s of raw as Record<string, unknown>[]) {
      const values = Array.isArray(s.values) ? s.values.map((v) => Number(v)) : null
      if (!values || values.some((v) => !Number.isFinite(v))) return 'every series "values" entry must be a number.'
      series.push({ name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `Series ${series.length + 1}`, values })
    }
    return validateChartSize(labels, series)
  }
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.labels)) return '"data.labels" must be an array of category labels.'
  const labels = (o.labels as unknown[]).map((l) => String(l))
  let series: { name: string; values: number[] }[] = []
  if (Array.isArray(o.series)) {
    for (const s of o.series as unknown[]) {
      if (!s || typeof s !== 'object') return 'each "data.series" entry must be an object { name, values }.'
      const so = s as Record<string, unknown>
      const values = Array.isArray(so.values) ? so.values.map((v) => Number(v)) : null
      if (!values || values.some((v) => !Number.isFinite(v))) return 'every series "values" entry must be a number.'
      series.push({ name: typeof so.name === 'string' && so.name.trim() ? so.name.trim() : `Series ${series.length + 1}`, values })
    }
  } else if (Array.isArray(o.values)) {
    const values = (o.values as unknown[]).map((v) => Number(v))
    if (values.some((v) => !Number.isFinite(v))) return 'every "data.values" entry must be a number.'
    series = [{ name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Series 1', values }]
  } else {
    return '"data" needs either "series": [{ name, values }] or a flat "values" array.'
  }
  if (series.length === 0) return '"data" needs at least one series.'
  return validateChartSize(labels, series)
}

function validateChartSize(
  labels: string[],
  series: { name: string; values: number[] }[]
): { labels: string[]; series: { name: string; values: number[] }[] } | string {
  if (labels.length === 0) return '"data.labels" must not be empty.'
  if (labels.length > MAX_CHART_POINTS) return `too many labels (limit ${MAX_CHART_POINTS}).`
  if (series.length > MAX_CHART_SERIES) return `too many series (limit ${MAX_CHART_SERIES}).`
  for (const s of series) {
    if (s.values.length !== labels.length) {
      return `series "${s.name}" has ${s.values.length} values but there are ${labels.length} labels — they must match.`
    }
  }
  return { labels, series }
}

/**
 * Resolve + read an image as a pptxgenjs data URI. Read-only path check and a
 * hard byte cap, so a huge or off-limits file can never be embedded.
 */
async function readImageData(raw: unknown): Promise<{ data: string } | { error: string }> {
  let img: string
  try {
    img = resolveSafePath(raw, { mutating: false })
  } catch (e) {
    return { error: `image: ${errText(e)}` }
  }
  const mime = IMAGE_MIME[extname(img).toLowerCase()]
  if (!mime) {
    return { error: `image: unsupported type "${extname(img) || '(none)'}" (use ${Object.keys(IMAGE_MIME).join(', ')}).` }
  }
  try {
    const buf = await readFile(img)
    if (buf.length > MAX_IMAGE_BYTES) {
      return { error: `image: ${img} is ${(buf.length / 1024 / 1024).toFixed(1)} MB (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB).` }
    }
    return { data: `${mime};base64,${buf.toString('base64')}` }
  } catch (e) {
    return { error: `image: cannot read ${img} — ${errText(e)}` }
  }
}

/** Validate a 1-based slide index against the deck, returning its 0-based form. */
function resolveSlideIndex(raw: unknown, spec: DeckSpec, tool: string): number | string {
  const n = Number(raw)
  if (!Number.isInteger(n)) return `${tool}: "slide_index" must be a whole number (1-based).`
  if (spec.slides.length === 0) return `${tool}: the deck has no slides yet — call add_slide first.`
  if (n < 1 || n > spec.slides.length) {
    return `${tool}: slide_index ${n} is out of range (deck has ${spec.slides.length} slide(s), 1-${spec.slides.length}).`
  }
  return n - 1
}

// ── rendering (spec → real .pptx) ────────────────────────────────────────────

/** Convert BulletSpec[] into pptxgenjs text runs with real bullet nesting. */
function bulletRuns(bullets: BulletSpec[]): { text: string; options: Record<string, unknown> }[] {
  return bullets.map((b) => ({
    text: b.text,
    options: { bullet: true, indentLevel: b.level, breakLine: true }
  }))
}

/**
 * Re-render the entire deck from its spec. Called on every mutation because
 * pptxgenjs cannot reopen its own output.
 */
async function renderDeck(file: string, spec: DeckSpec): Promise<void> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  if (spec.title) {
    pptx.title = spec.title
    pptx.subject = spec.title
  }

  for (const s of spec.slides) {
    const slide = pptx.addSlide()
    const hasImage = Boolean(s.image)
    // Body width shrinks to leave room when an image shares the slide.
    const bodyW = hasImage ? 5.2 : 8.6

    if (s.layout === 'title') {
      slide.addText(s.heading ?? '', {
        x: 0.6, y: 2.1, w: 8.8, h: 1.4, fontSize: 40, bold: true, align: 'center'
      })
      if (s.subtitle) {
        slide.addText(s.subtitle, { x: 0.6, y: 3.5, w: 8.8, h: 0.8, fontSize: 20, align: 'center', color: '666666' })
      }
    } else if (s.layout === 'blank') {
      if (s.heading) slide.addText(s.heading, { x: 0.6, y: 0.4, w: 8.8, h: 0.9, fontSize: 28, bold: true })
      if (s.bullets?.length) {
        slide.addText(bulletRuns(s.bullets), {
          x: 0.6, y: s.heading ? 1.5 : 0.6, w: bodyW, h: 4, fontSize: 16
        })
      }
    } else if (s.layout === 'two-content') {
      if (s.heading) slide.addText(s.heading, { x: 0.6, y: 0.4, w: 8.8, h: 0.9, fontSize: 28, bold: true })
      if (s.bullets?.length) {
        slide.addText(bulletRuns(s.bullets), { x: 0.6, y: 1.5, w: 4.2, h: 3.8, fontSize: 16 })
      }
      if (s.bulletsRight?.length) {
        slide.addText(bulletRuns(s.bulletsRight), { x: 5.1, y: 1.5, w: 4.2, h: 3.8, fontSize: 16 })
      }
    } else {
      // title+content
      if (s.heading) slide.addText(s.heading, { x: 0.6, y: 0.4, w: 8.8, h: 0.9, fontSize: 28, bold: true })
      if (s.bullets?.length) {
        slide.addText(bulletRuns(s.bullets), { x: 0.6, y: 1.5, w: bodyW, h: 3.8, fontSize: 16 })
      }
    }

    if (s.image) {
      // Right-hand column when the slide has body text, else centred.
      const placed = s.layout === 'title' || !(s.bullets?.length)
        ? { x: 2.8, y: 1.6, w: 4.4, h: 3.3 }
        : { x: 6.1, y: 1.5, w: 3.3, h: 3.3 }
      slide.addImage({ data: s.image, ...placed })
    }

    for (const t of s.tables ?? []) {
      // pptxgenjs accepts bare strings at runtime but its types want cell
      // objects, so each cell is wrapped in { text }.
      slide.addTable(
        t.map((row) => row.map((text) => ({ text }))),
        {
          x: 0.6, y: 1.5, w: 8.8,
          border: { type: 'solid', pt: 1, color: 'DDDDDD' },
          fontSize: 12,
          fill: { color: 'FFFFFF' }
        }
      )
    }

    for (const c of s.charts ?? []) {
      const type =
        c.type === 'bar' ? pptx.ChartType.bar
          : c.type === 'line' ? pptx.ChartType.line
            : c.type === 'pie' ? pptx.ChartType.pie
              : pptx.ChartType.doughnut
      // pie/doughnut are single-series by definition — extra series are dropped.
      const series = c.type === 'pie' || c.type === 'doughnut' ? c.series.slice(0, 1) : c.series
      slide.addChart(
        type,
        series.map((sr) => ({ name: sr.name, labels: c.labels, values: sr.values })),
        {
          x: 0.6, y: 1.5, w: 8.8, h: 3.8,
          showLegend: c.showLegend ?? true,
          legendPos: 'b',
          showValue: c.showValue ?? false,
          ...(c.title ? { showTitle: true, title: c.title } : {})
        }
      )
    }

    if (s.notes) slide.addNotes(s.notes)
  }

  await pptx.writeFile({ fileName: file })
}

/** Resolve the target path and enforce the .pptx extension. */
function resolveDeckPath(raw: unknown, tool: string, mutating: boolean): string | ToolResult {
  let file: string
  try {
    file = resolveSafePath(raw, { mutating })
  } catch (e) {
    return { ok: false, error: `${tool}: ${errText(e)}` }
  }
  if (!/\.pptx$/i.test(file)) {
    return { ok: false, error: `${tool}: path must end in .pptx (got "${basename(file)}").` }
  }
  return file
}

/**
 * Shared prologue for the four mutating tools that edit an EXISTING deck:
 * resolve the path, load the sidecar spec, or return the right error.
 */
async function openDeck(
  raw: unknown,
  tool: string
): Promise<{ file: string; spec: DeckSpec } | ToolResult> {
  const file = resolveDeckPath(raw, tool, true)
  if (typeof file !== 'string') return file
  const spec = await loadSpec(file)
  if (!spec) return noSpecError(tool, file)
  return { file, spec }
}

// ── create_presentation ──────────────────────────────────────────────────────

async function create_presentation(args: Record<string, unknown>): Promise<ToolResult> {
  const file = resolveDeckPath(args.path, 'create_presentation', true)
  if (typeof file !== 'string') return file

  const title = str(args.title)
  if (title.length > MAX_HEADING_CHARS) {
    return { ok: false, error: `create_presentation: "title" exceeds ${MAX_HEADING_CHARS} chars.` }
  }

  const spec: DeckSpec = {
    version: 1,
    title: title || undefined,
    // A deck always opens with a title slide, so the file is valid immediately.
    slides: title ? [{ layout: 'title', heading: title }] : []
  }
  try {
    await renderDeck(file, spec)
    await saveSpec(file, spec)
    return {
      ok: true,
      output:
        `Created ${file}${title ? ` with a title slide ("${title}")` : ' (no slides yet)'}. ` +
        `Add content with add_slide / add_chart / add_slide_table.`
    }
  } catch (e) {
    return { ok: false, error: `create_presentation failed: ${errText(e)}` }
  }
}

// ── add_slide ────────────────────────────────────────────────────────────────

async function add_slide(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDeck(args.path, 'add_slide')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  const layout = (str(args.layout) || 'title+content') as LayoutName
  if (!LAYOUTS.includes(layout)) {
    return { ok: false, error: `add_slide: bad layout "${layout}" (expected one of: ${LAYOUTS.join(', ')}).` }
  }
  if (spec.slides.length >= MAX_SLIDES) {
    return { ok: false, error: `add_slide: deck already has ${spec.slides.length} slides (limit ${MAX_SLIDES}).` }
  }

  const content = (args.content && typeof args.content === 'object' && !Array.isArray(args.content)
    ? (args.content as Record<string, unknown>)
    : {}) as Record<string, unknown>

  const heading = str(content.heading) || str(content.title)
  if (heading.length > MAX_HEADING_CHARS) {
    return { ok: false, error: `add_slide: "heading" exceeds ${MAX_HEADING_CHARS} chars.` }
  }
  const subtitle = str(content.subtitle)
  if (subtitle.length > MAX_HEADING_CHARS) {
    return { ok: false, error: `add_slide: "subtitle" exceeds ${MAX_HEADING_CHARS} chars.` }
  }

  const bullets = coerceBullets(content.bullets ?? content.body, 'bullets')
  if (typeof bullets === 'string') return { ok: false, error: `add_slide: ${bullets}` }
  const bulletsRight = coerceBullets(content.bullets_right ?? content.bulletsRight, 'bullets_right')
  if (typeof bulletsRight === 'string') return { ok: false, error: `add_slide: ${bulletsRight}` }

  if (layout !== 'blank' && !heading && bullets.length === 0 && !content.image) {
    return { ok: false, error: 'add_slide: nothing to add — provide content.heading, content.bullets, or content.image.' }
  }
  if (layout === 'two-content' && bulletsRight.length === 0 && bullets.length > 0) {
    return {
      ok: false,
      error: 'add_slide: the "two-content" layout needs content.bullets_right as well (that is the second column).'
    }
  }

  const notes = str(content.notes)
  if (notes.length > MAX_NOTES_CHARS) {
    return { ok: false, error: `add_slide: "notes" exceeds ${MAX_NOTES_CHARS} chars.` }
  }

  let image: string | undefined
  if (content.image !== undefined && content.image !== null && content.image !== '') {
    const got = await readImageData(content.image)
    if ('error' in got) return { ok: false, error: `add_slide: ${got.error}` }
    image = got.data
  }

  const slide: SlideSpec = {
    layout,
    heading: heading || undefined,
    subtitle: subtitle || undefined,
    bullets: bullets.length ? bullets : undefined,
    bulletsRight: bulletsRight.length ? bulletsRight : undefined,
    image,
    notes: notes || undefined
  }
  spec.slides.push(slide)

  try {
    await renderDeck(file, spec)
    await saveSpec(file, spec)
    return {
      ok: true,
      output:
        `Added slide ${spec.slides.length} ("${heading || layout}", layout "${layout}"` +
        `${bullets.length ? `, ${bullets.length} bullet(s)` : ''}${image ? ', 1 image' : ''}) to ${file}.`
    }
  } catch (e) {
    return { ok: false, error: `add_slide failed: ${errText(e)}` }
  }
}

// ── add_chart ────────────────────────────────────────────────────────────────

async function add_chart(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDeck(args.path, 'add_chart')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  const idx = resolveSlideIndex(args.slide_index, spec, 'add_chart')
  if (typeof idx === 'string') return { ok: false, error: idx }

  const chartType = str(args.chart_type).toLowerCase() as ChartTypeName
  if (!CHART_TYPES.includes(chartType)) {
    return { ok: false, error: `add_chart: bad chart_type "${str(args.chart_type)}" (expected one of: ${CHART_TYPES.join(', ')}).` }
  }

  const data = coerceChartData(args.data)
  if (typeof data === 'string') return { ok: false, error: `add_chart: ${data}` }

  const options = (args.options && typeof args.options === 'object' && !Array.isArray(args.options)
    ? (args.options as Record<string, unknown>)
    : {}) as Record<string, unknown>

  const chart: ChartSpec = {
    type: chartType,
    labels: data.labels,
    series: data.series,
    title: str(options.title) || undefined,
    showLegend: typeof options.show_legend === 'boolean' ? options.show_legend : undefined,
    showValue: typeof options.show_values === 'boolean' ? options.show_values : undefined
  }
  const target = spec.slides[idx]
  target.charts = [...(target.charts ?? []), chart]

  try {
    await renderDeck(file, spec)
    await saveSpec(file, spec)
    const dropped = (chartType === 'pie' || chartType === 'doughnut') && data.series.length > 1
    return {
      ok: true,
      output:
        `Added a native ${chartType} chart (${data.series.length} series × ${data.labels.length} points) ` +
        `to slide ${idx + 1} of ${file}.` +
        (dropped ? ` Note: ${chartType} charts show one series, so only "${data.series[0].name}" is plotted.` : '')
    }
  } catch (e) {
    return { ok: false, error: `add_chart failed: ${errText(e)}` }
  }
}

// ── add_slide_table ──────────────────────────────────────────────────────────

/**
 * Named add_slide_table rather than add_table because worddoc.ts owns the
 * document-scoped add_doc_table: the tool registry is one flat namespace, so a
 * shared "add_table" name would pair one module's schema with the other's
 * implementation. The slide/doc prefixes also stop the model from aiming a
 * slide_index at a .docx.
 */
async function add_slide_table(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDeck(args.path, 'add_slide_table')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  const idx = resolveSlideIndex(args.slide_index, spec, 'add_slide_table')
  if (typeof idx === 'string') return { ok: false, error: idx }

  const rows = coerceTableRows(args.rows)
  if (typeof rows === 'string') return { ok: false, error: `add_slide_table: ${rows}` }

  const target = spec.slides[idx]
  target.tables = [...(target.tables ?? []), rows]

  try {
    await renderDeck(file, spec)
    await saveSpec(file, spec)
    return {
      ok: true,
      output: `Added a ${rows.length}×${rows[0].length} table to slide ${idx + 1} of ${file}.`
    }
  } catch (e) {
    return { ok: false, error: `add_slide_table failed: ${errText(e)}` }
  }
}

// ── set_slide_notes ──────────────────────────────────────────────────────────

async function set_slide_notes(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDeck(args.path, 'set_slide_notes')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  const idx = resolveSlideIndex(args.slide_index, spec, 'set_slide_notes')
  if (typeof idx === 'string') return { ok: false, error: idx }

  const notes = typeof args.notes === 'string' ? args.notes : ''
  if (!notes.trim()) return { ok: false, error: 'set_slide_notes: "notes" must be a non-empty string.' }
  if (notes.length > MAX_NOTES_CHARS) {
    return { ok: false, error: `set_slide_notes: "notes" exceeds ${MAX_NOTES_CHARS} chars.` }
  }

  spec.slides[idx].notes = notes
  try {
    await renderDeck(file, spec)
    await saveSpec(file, spec)
    return { ok: true, output: `Set speaker notes (${notes.length} chars) on slide ${idx + 1} of ${file}.` }
  } catch (e) {
    return { ok: false, error: `set_slide_notes failed: ${errText(e)}` }
  }
}

// ── list_slides ──────────────────────────────────────────────────────────────

async function list_slides(args: Record<string, unknown>): Promise<ToolResult> {
  const file = resolveDeckPath(args.path, 'list_slides', false)
  if (typeof file !== 'string') return file

  const spec = await loadSpec(file)
  if (!spec) return noSpecError('list_slides', file)

  if (spec.slides.length === 0) {
    return { ok: true, output: `${file} has no slides yet (created by OpenUI; add one with add_slide).` }
  }
  const lines = [`${spec.slides.length} slide(s) in ${file}${spec.title ? ` — "${spec.title}"` : ''}:`]
  spec.slides.forEach((s, i) => {
    const bits: string[] = [`layout "${s.layout}"`]
    if (s.bullets?.length) bits.push(`${s.bullets.length} bullet(s)`)
    if (s.bulletsRight?.length) bits.push(`${s.bulletsRight.length} right bullet(s)`)
    if (s.tables?.length) bits.push(`${s.tables.length} table(s)`)
    if (s.charts?.length) bits.push(`${s.charts.map((c) => c.type).join('/')} chart`)
    if (s.image) bits.push('image')
    if (s.notes) bits.push('notes')
    lines.push(`${i + 1}. ${s.heading || '(untitled)'} — ${bits.join(', ')}`)
    if (lines.join('\n').length > MAX_OUTPUT_CHARS) lines.push(`… truncated at ${MAX_OUTPUT_CHARS} chars.`)
  })
  return { ok: true, output: lines.slice(0, spec.slides.length + 2).join('\n') }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const presentationToolSchemas: ToolSchema[] = [
  {
    name: 'create_presentation',
    description:
      'Create a new PowerPoint .pptx deck natively (no PowerPoint app needed), optionally with a title slide. ' +
      'ALWAYS use this instead of computer_use when generating a presentation from scratch. ' +
      'Follow up with add_slide / add_chart / add_table. Note: these tools can only edit decks they created — ' +
      'they cannot open a .pptx made in PowerPoint or one already open in a running PowerPoint window.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination .pptx path inside your home folder (e.g. "~/Documents/q4.pptx").' },
        title: { type: 'string', description: 'Optional deck title; when given, a title slide is created as slide 1.' }
      },
      required: ['path']
    }
  },
  {
    name: 'add_slide',
    description:
      'Append a slide to a deck created by create_presentation. Layouts: "title", "title+content", ' +
      '"two-content" (needs content.bullets_right), "blank". Bullets accept nesting for sub-bullets.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .pptx created by create_presentation.' },
        layout: {
          type: 'string',
          description: 'One of "title", "title+content" (default), "two-content", "blank".'
        },
        content: {
          type: 'object',
          description:
            'Slide content: { "heading": "Q4 Results", "subtitle": "(title layout only)", ' +
            '"bullets": ["Revenue up 20%", { "text": "EMEA led growth", "level": 1 }], ' +
            '"bullets_right": [...] (two-content only), "image": "~/Pictures/chart.png", "notes": "speaker notes" }. ' +
            'A bullet is a plain string, or { text, level } where level 0-4 nests it as a sub-bullet.'
        }
      },
      required: ['path', 'layout', 'content']
    }
  },
  {
    name: 'add_chart',
    description:
      'Add a REAL native PowerPoint chart (an editable chart object, not a picture of one) to an existing slide. ' +
      'Chart types: bar, line, pie, doughnut. pie/doughnut plot a single series.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .pptx created by create_presentation.' },
        slide_index: { type: 'number', description: '1-based slide number to place the chart on (see list_slides).' },
        chart_type: { type: 'string', description: 'One of "bar", "line", "pie", "doughnut".' },
        data: {
          type: 'object',
          description:
            'Chart data: { "labels": ["Q1","Q2","Q3"], "series": [{ "name": "Revenue", "values": [10,20,30] }] }. ' +
            'Every series must have exactly as many values as there are labels.'
        },
        options: {
          type: 'object',
          description: 'Optional { "title": "Revenue by quarter", "show_legend": true, "show_values": false }.'
        }
      },
      required: ['path', 'slide_index', 'chart_type', 'data']
    }
  },
  {
    name: 'add_slide_table',
    description:
      'Add a table to an existing SLIDE from a 2-D array of rows — the same "rows" convention as write_spreadsheet. ' +
      'The first row reads as the header. (For a Word document, use add_doc_table instead.)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .pptx created by create_presentation.' },
        slide_index: { type: 'number', description: '1-based slide number to place the table on.' },
        rows: {
          // 'array' (not 'object') — validateArgs rejects arrays for 'object'.
          type: 'array',
          description: 'Array of arrays, e.g. [["Region","Revenue"],["EMEA",1200],["APAC",900]].'
        }
      },
      required: ['path', 'slide_index', 'rows']
    }
  },
  {
    name: 'set_slide_notes',
    description: 'Set (replace) the speaker notes on an existing slide.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .pptx created by create_presentation.' },
        slide_index: { type: 'number', description: '1-based slide number.' },
        notes: { type: 'string', description: 'The speaker notes text.' }
      },
      required: ['path', 'slide_index', 'notes']
    }
  },
  {
    name: 'list_slides',
    description:
      'List the slides in a deck created by these tools — count plus a one-line summary (title, layout, contents) each. ' +
      'Use this to find the right slide_index before add_chart / add_slide_table / set_slide_notes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .pptx file.' }
      },
      required: ['path']
    }
  }
]

export const presentationRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  create_presentation,
  add_slide,
  add_chart,
  add_slide_table,
  set_slide_notes,
  list_slides
}
