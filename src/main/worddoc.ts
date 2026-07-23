/**
 * worddoc.ts — native Word document automation for the OpenUI agent (Part 4.3).
 *
 * Self-contained tool module (schemas + registry) mirroring spreadsheet.ts and
 * presentation.ts. It builds real .docx files with the `docx` package instead of
 * driving the Word GUI through computer_use — deterministic, fast, scriptable.
 *
 * WHY THERE IS A SIDECAR SPEC:
 *   The `docx` package is WRITE-ONLY — it exposes Packer for output and no
 *   loader, so a .docx on disk cannot be re-opened and appended to. Exactly like
 *   presentation.ts, every document these tools create carries a JSON "doc spec"
 *   sidecar (".<name>.docx.openui.json") holding the block model. Each mutating
 *   tool loads that spec, appends a block, re-renders the WHOLE .docx, and saves
 *   the spec back. The .docx itself stays a completely normal Word file — the
 *   sidecar is never embedded into the OOXML package.
 *
 *   The consequence is a REAL limitation the model must know about: these tools
 *   cannot edit a .docx authored in Word, and cannot attach to a document
 *   already open in a running Word instance. Mutating a document with no sidecar
 *   fails with a message pointing at computer_use. See the document workflow
 *   block in agent.ts.
 *
 * SECURITY / SAFETY:
 *   - Every path passes through resolveSafePath(): reads are blocked from
 *     sensitive dirs (SENSITIVE_PATH_RE); writes are additionally confined to
 *     the user's home tree. Same trust boundary as the file_* tools. Image
 *     paths are resolved READ-ONLY (mutating: false) — they are only ever read.
 *   - Block counts, paragraph length, table size and image bytes are capped to
 *     avoid context flooding and runaway memory on a hostile or huge input.
 *   - The six mutating tools (create_document, add_heading, add_paragraph,
 *     add_doc_table, add_image, add_page_break) are registered in
 *     STATE_CHANGING_TOOLS (tools.ts) so they are HITL-gated.
 *     list_document_structure is read-only and ungated, like list_sheets.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import {
  Document,
  HeadingLevel,
  ImageRun,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import { resolveSafePath } from './fs/pathSafety'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// Caps — keep a single accidental call from flooding context or exhausting RAM.
const MAX_BLOCKS = 5_000
const MAX_HEADINGS = 500
const MAX_PARAGRAPH_CHARS = 20_000
const MAX_HEADING_CHARS = 500
const MAX_RUNS = 100
const MAX_TABLE_ROWS = 500
const MAX_TABLE_COLS = 25
const MAX_CELL_CHARS = 2_000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_DIM = 2_000
const MAX_OUTPUT_CHARS = 60_000

const PARAGRAPH_STYLES = ['normal', 'bold', 'italic'] as const
type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number]

/**
 * docx v9's ImageRun requires an explicit `type`, so only the raster formats it
 * names are accepted (SVG needs a separate fallback image and is left out).
 */
const IMAGE_TYPES: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif',
  '.bmp': 'bmp'
}

const HEADING_FOR_LEVEL = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4
] as const

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

// ── doc spec (the sidecar model re-rendered on every mutation) ───────────────

/** One formatting run — the richer form of add_paragraph's `text`. */
export interface RunSpec {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export type BlockSpec =
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'paragraph'; runs: RunSpec[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'image'; data: string; type: 'png' | 'jpg' | 'gif' | 'bmp'; width: number; height: number }
  | { kind: 'pagebreak' }

export interface DocSpec {
  version: 1
  title?: string
  blocks: BlockSpec[]
}

/** Sidecar path for a document: ~/x/report.docx → ~/x/.report.docx.openui.json */
function sidecarPath(file: string): string {
  return join(dirname(file), `.${basename(file)}.openui.json`)
}

/**
 * Read a document's sidecar spec. Exported so pdf.ts can render the SAME model
 * to PDF and mailmerge.ts can clone it per data row, without either of them
 * reimplementing the sidecar convention.
 */
export async function loadDocSpec(file: string): Promise<DocSpec | null> {
  return loadSpec(file)
}

/** Write a document spec and its .docx together (used by mailmerge.ts). */
export async function writeDocFromSpec(file: string, spec: DocSpec): Promise<void> {
  await renderDoc(file, spec)
  await saveSpec(file, spec)
}

async function loadSpec(file: string): Promise<DocSpec | null> {
  try {
    const raw = await readFile(sidecarPath(file), 'utf8')
    const spec = JSON.parse(raw) as DocSpec
    if (!spec || !Array.isArray(spec.blocks)) return null
    return spec
  } catch {
    return null
  }
}

async function saveSpec(file: string, spec: DocSpec): Promise<void> {
  await writeFile(sidecarPath(file), JSON.stringify(spec, null, 2), 'utf8')
}

/** The error every mutating tool returns when the target has no sidecar. */
function noSpecError(tool: string, file: string): ToolResult {
  return {
    ok: false,
    error:
      `${tool}: no OpenUI document spec found for ${file}. These tools can only edit documents ` +
      `they created themselves (start with create_document). They CANNOT open a .docx authored in Word, ` +
      `and cannot attach to a document already open in a running Word window — for those, ` +
      `fall back to computer_use.`
  }
}

// ── input coercion + validation ──────────────────────────────────────────────

/**
 * Normalise add_paragraph's `text` into runs. Accepts a plain string (styled by
 * the `style` arg) or an array of { text, bold, italic, underline } for mixed
 * formatting inside one paragraph — docx models this natively as TextRuns.
 */
function coerceRuns(rawText: unknown, style: ParagraphStyle): RunSpec[] | string {
  if (typeof rawText === 'string') {
    if (rawText.length > MAX_PARAGRAPH_CHARS) return `"text" exceeds ${MAX_PARAGRAPH_CHARS} chars.`
    return [{ text: rawText, bold: style === 'bold' || undefined, italic: style === 'italic' || undefined }]
  }
  if (!Array.isArray(rawText)) {
    return '"text" must be a string, or an array of { text, bold, italic, underline } runs.'
  }
  if (rawText.length === 0) return '"text" must not be an empty array.'
  if (rawText.length > MAX_RUNS) return `too many formatting runs (limit ${MAX_RUNS}).`
  const runs: RunSpec[] = []
  let total = 0
  for (const item of rawText) {
    if (typeof item === 'string') {
      total += item.length
      runs.push({ text: item })
      continue
    }
    if (!item || typeof item !== 'object') return 'each run must be a string or an object with "text".'
    const o = item as Record<string, unknown>
    if (typeof o.text !== 'string') return 'each run needs a string "text".'
    total += o.text.length
    runs.push({
      text: o.text,
      bold: o.bold === true || undefined,
      italic: o.italic === true || undefined,
      underline: o.underline === true || undefined
    })
  }
  if (total > MAX_PARAGRAPH_CHARS) return `paragraph text exceeds ${MAX_PARAGRAPH_CHARS} chars.`
  return runs
}

/** Same 2-D array convention as write_spreadsheet / add_slide_table. */
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
  let width = 0
  for (const row of rows) {
    const arr = Array.isArray(row) ? row : [row]
    if (arr.length > MAX_TABLE_COLS) return `too many columns (limit ${MAX_TABLE_COLS}).`
    width = Math.max(width, arr.length)
    out.push(
      arr.map((cell) => {
        const s = cell === null || cell === undefined ? '' : String(cell)
        return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s
      })
    )
  }
  // Word tables must be rectangular — pad short rows so the file stays valid.
  for (const row of out) while (row.length < width) row.push('')
  return out
}

/** Resolve the target path and enforce the .docx extension. */
function resolveDocPath(raw: unknown, tool: string, mutating: boolean): string | ToolResult {
  let file: string
  try {
    file = resolveSafePath(raw, { mutating })
  } catch (e) {
    return { ok: false, error: `${tool}: ${errText(e)}` }
  }
  if (!/\.docx$/i.test(file)) {
    return { ok: false, error: `${tool}: path must end in .docx (got "${basename(file)}").` }
  }
  return file
}

/** Shared prologue for the mutating tools that edit an EXISTING document. */
async function openDoc(raw: unknown, tool: string): Promise<{ file: string; spec: DocSpec } | ToolResult> {
  const file = resolveDocPath(raw, tool, true)
  if (typeof file !== 'string') return file
  const spec = await loadSpec(file)
  if (!spec) return noSpecError(tool, file)
  if (spec.blocks.length >= MAX_BLOCKS) {
    return { ok: false, error: `${tool}: document already has ${spec.blocks.length} blocks (limit ${MAX_BLOCKS}).` }
  }
  return { file, spec }
}

// ── rendering (spec → real .docx) ────────────────────────────────────────────

/** Re-render the whole document from its spec (docx cannot reopen its output). */
async function renderDoc(file: string, spec: DocSpec): Promise<void> {
  const children: (Paragraph | Table)[] = []

  for (const b of spec.blocks) {
    if (b.kind === 'heading') {
      children.push(
        new Paragraph({
          text: b.text,
          heading: HEADING_FOR_LEVEL[Math.min(Math.max(b.level, 1), 4) - 1]
        })
      )
    } else if (b.kind === 'paragraph') {
      children.push(
        new Paragraph({
          children: b.runs.map(
            (r) => new TextRun({ text: r.text, bold: r.bold, italics: r.italic, underline: r.underline ? {} : undefined })
          )
        })
      )
    } else if (b.kind === 'table') {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map(
            (row, ri) =>
              new TableRow({
                // First row is the header band, rendered bold.
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [new Paragraph({ children: [new TextRun({ text: cell, bold: ri === 0 || undefined })] })]
                    })
                )
              })
          )
        })
      )
    } else if (b.kind === 'image') {
      children.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: b.type,
              data: Buffer.from(b.data, 'base64'),
              transformation: { width: b.width, height: b.height }
            })
          ]
        })
      )
    } else {
      children.push(new Paragraph({ children: [new PageBreak()] }))
    }
  }

  // Word rejects a section with no children, so an empty doc gets one blank para.
  if (children.length === 0) children.push(new Paragraph({ text: '' }))

  const doc = new Document({
    ...(spec.title ? { title: spec.title } : {}),
    sections: [{ properties: {}, children }]
  })
  await writeFile(file, await Packer.toBuffer(doc))
}

// ── create_document ──────────────────────────────────────────────────────────

async function create_document(args: Record<string, unknown>): Promise<ToolResult> {
  const file = resolveDocPath(args.path, 'create_document', true)
  if (typeof file !== 'string') return file

  const title = str(args.title)
  if (title.length > MAX_HEADING_CHARS) {
    return { ok: false, error: `create_document: "title" exceeds ${MAX_HEADING_CHARS} chars.` }
  }

  const spec: DocSpec = {
    version: 1,
    title: title || undefined,
    // A title becomes the document's H1 so the file is meaningful immediately.
    blocks: title ? [{ kind: 'heading', text: title, level: 1 }] : []
  }
  try {
    await renderDoc(file, spec)
    await saveSpec(file, spec)
    return {
      ok: true,
      output:
        `Created ${file}${title ? ` with "${title}" as the level-1 heading` : ' (empty)'}. ` +
        `Add content with add_heading / add_paragraph / add_doc_table / add_image.`
    }
  } catch (e) {
    return { ok: false, error: `create_document failed: ${errText(e)}` }
  }
}

// ── add_heading ──────────────────────────────────────────────────────────────

async function add_heading(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDoc(args.path, 'add_heading')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  const text = str(args.text)
  if (!text) return { ok: false, error: 'add_heading: "text" must be a non-empty string.' }
  if (text.length > MAX_HEADING_CHARS) {
    return { ok: false, error: `add_heading: "text" exceeds ${MAX_HEADING_CHARS} chars.` }
  }
  const level = Number(args.level ?? 1)
  if (!Number.isInteger(level) || level < 1 || level > 4) {
    return { ok: false, error: `add_heading: "level" must be a whole number 1-4 (got ${String(args.level)}).` }
  }
  const headings = spec.blocks.filter((b) => b.kind === 'heading').length
  if (headings >= MAX_HEADINGS) {
    return { ok: false, error: `add_heading: document already has ${headings} headings (limit ${MAX_HEADINGS}).` }
  }

  spec.blocks.push({ kind: 'heading', text, level })
  try {
    await renderDoc(file, spec)
    await saveSpec(file, spec)
    return { ok: true, output: `Added level-${level} heading "${text}" to ${file}.` }
  } catch (e) {
    return { ok: false, error: `add_heading failed: ${errText(e)}` }
  }
}

// ── add_paragraph ────────────────────────────────────────────────────────────

async function add_paragraph(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDoc(args.path, 'add_paragraph')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  const style = (str(args.style) || 'normal') as ParagraphStyle
  if (!PARAGRAPH_STYLES.includes(style)) {
    return { ok: false, error: `add_paragraph: bad style "${style}" (expected one of: ${PARAGRAPH_STYLES.join(', ')}).` }
  }
  // Two shapes: a plain "text" string (styled by `style`), or a "runs" array for
  // mixed formatting inside one paragraph. They are separate params because
  // validateArgs types each field strictly — a string-or-array field is not
  // expressible in this schema dialect.
  const hasRuns = args.runs !== undefined && args.runs !== null
  if (!hasRuns && (args.text === undefined || args.text === null || args.text === '')) {
    return { ok: false, error: 'add_paragraph: provide "text" (a string), or "runs" for mixed formatting.' }
  }
  const runs = coerceRuns(hasRuns ? args.runs : args.text, style)
  if (typeof runs === 'string') return { ok: false, error: `add_paragraph: ${runs}` }

  spec.blocks.push({ kind: 'paragraph', runs })
  try {
    await renderDoc(file, spec)
    await saveSpec(file, spec)
    const chars = runs.reduce((n, r) => n + r.text.length, 0)
    return {
      ok: true,
      output: `Added a ${chars}-char paragraph${runs.length > 1 ? ` (${runs.length} formatting runs)` : ` (style "${style}")`} to ${file}.`
    }
  } catch (e) {
    return { ok: false, error: `add_paragraph failed: ${errText(e)}` }
  }
}

// ── add_doc_table ────────────────────────────────────────────────────────────

/**
 * Named add_doc_table rather than add_table because presentation.ts owns the
 * slide-scoped add_slide_table — one flat tool namespace, so the names must not
 * collide (see the note in presentation.ts).
 */
async function add_doc_table(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDoc(args.path, 'add_doc_table')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  const rows = coerceTableRows(args.rows)
  if (typeof rows === 'string') return { ok: false, error: `add_doc_table: ${rows}` }

  spec.blocks.push({ kind: 'table', rows })
  try {
    await renderDoc(file, spec)
    await saveSpec(file, spec)
    return { ok: true, output: `Added a ${rows.length}×${rows[0].length} table to ${file}.` }
  } catch (e) {
    return { ok: false, error: `add_doc_table failed: ${errText(e)}` }
  }
}

// ── add_image ────────────────────────────────────────────────────────────────

async function add_image(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDoc(args.path, 'add_image')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  // The image itself is READ-ONLY — resolved through the same gate as read_file.
  let img: string
  try {
    img = resolveSafePath(args.image_path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `add_image: image_path: ${errText(e)}` }
  }
  const type = IMAGE_TYPES[extname(img).toLowerCase()]
  if (!type) {
    return {
      ok: false,
      error: `add_image: unsupported image type "${extname(img) || '(none)'}" (use ${Object.keys(IMAGE_TYPES).join(', ')}).`
    }
  }

  const width = Number(args.width ?? 400)
  const height = Number(args.height ?? 300)
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (!Number.isFinite(v) || v <= 0 || v > MAX_IMAGE_DIM) {
      return { ok: false, error: `add_image: "${name}" must be between 1 and ${MAX_IMAGE_DIM} pixels (got ${String(v)}).` }
    }
  }

  let data: string
  try {
    const buf = await readFile(img)
    if (buf.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `add_image: ${img} is ${(buf.length / 1024 / 1024).toFixed(1)} MB (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`
      }
    }
    data = buf.toString('base64')
  } catch (e) {
    return { ok: false, error: `add_image: cannot read ${img} — ${errText(e)}` }
  }

  spec.blocks.push({ kind: 'image', data, type, width: Math.round(width), height: Math.round(height) })
  try {
    await renderDoc(file, spec)
    await saveSpec(file, spec)
    return { ok: true, output: `Added ${basename(img)} (${Math.round(width)}×${Math.round(height)} px) to ${file}.` }
  } catch (e) {
    return { ok: false, error: `add_image failed: ${errText(e)}` }
  }
}

// ── add_page_break ───────────────────────────────────────────────────────────

async function add_page_break(args: Record<string, unknown>): Promise<ToolResult> {
  const opened = await openDoc(args.path, 'add_page_break')
  if (!('spec' in opened)) return opened
  const { file, spec } = opened

  spec.blocks.push({ kind: 'pagebreak' })
  try {
    await renderDoc(file, spec)
    await saveSpec(file, spec)
    return { ok: true, output: `Added a page break to ${file}.` }
  } catch (e) {
    return { ok: false, error: `add_page_break failed: ${errText(e)}` }
  }
}

// ── list_document_structure ──────────────────────────────────────────────────

async function list_document_structure(args: Record<string, unknown>): Promise<ToolResult> {
  const file = resolveDocPath(args.path, 'list_document_structure', false)
  if (typeof file !== 'string') return file

  const spec = await loadSpec(file)
  if (!spec) return noSpecError('list_document_structure', file)

  const counts = { heading: 0, paragraph: 0, table: 0, image: 0, pagebreak: 0 }
  for (const b of spec.blocks) counts[b.kind]++

  if (spec.blocks.length === 0) {
    return { ok: true, output: `${file} is empty (created by OpenUI; add content with add_heading / add_paragraph).` }
  }

  const lines = [
    `${file}${spec.title ? ` — "${spec.title}"` : ''}: ${spec.blocks.length} block(s) — ` +
      `${counts.heading} heading(s), ${counts.paragraph} paragraph(s), ${counts.table} table(s), ` +
      `${counts.image} image(s), ${counts.pagebreak} page break(s).`
  ]
  if (counts.heading > 0) {
    lines.push('Outline:')
    for (const b of spec.blocks) {
      if (b.kind !== 'heading') continue
      lines.push(`${'  '.repeat(b.level - 1)}${'#'.repeat(b.level)} ${b.text}`)
      if (lines.join('\n').length > MAX_OUTPUT_CHARS) {
        lines.push(`… output truncated at ${MAX_OUTPUT_CHARS} chars.`)
        break
      }
    }
  } else {
    lines.push('(No headings yet — add_heading builds the outline.)')
  }
  return { ok: true, output: lines.join('\n') }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const worddocToolSchemas: ToolSchema[] = [
  {
    name: 'create_document',
    description:
      'Create a new Word .docx document natively (no Word app needed), optionally with a title heading. ' +
      'ALWAYS use this instead of computer_use when generating a document from scratch. ' +
      'Follow up with add_heading / add_paragraph / add_doc_table / add_image. Note: these tools can only edit ' +
      'documents they created — they cannot open a .docx made in Word or one already open in a running Word window.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination .docx path inside your home folder (e.g. "~/Documents/report.docx").' },
        title: { type: 'string', description: 'Optional document title; when given it becomes the level-1 heading.' }
      },
      required: ['path']
    }
  },
  {
    name: 'add_heading',
    description: 'Append a heading to a document created by create_document. Levels 1-4 build the outline.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .docx created by create_document.' },
        text: { type: 'string', description: 'The heading text.' },
        level: { type: 'number', description: 'Heading level, 1-4 (1 is the largest).' }
      },
      required: ['path', 'text', 'level']
    }
  },
  {
    name: 'add_paragraph',
    description:
      'Append a paragraph to a document created by create_document. Pass "text" for a plain paragraph with an ' +
      'optional "style" (normal/bold/italic), OR "runs" to mix formatting inside one paragraph, e.g. ' +
      '[{"text":"Warning: ","bold":true},{"text":"disk almost full"}]. Provide one or the other.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .docx created by create_document.' },
        text: { type: 'string', description: 'The paragraph text (use this for a normal single-format paragraph).' },
        runs: {
          // 'array' (not 'object') — validateArgs rejects arrays for 'object'.
          type: 'array',
          description:
            'Alternative to "text" for mixed formatting: an array of { text, bold, italic, underline } runs. ' +
            'When given, "style" is ignored.'
        },
        style: { type: 'string', description: 'Optional "normal" (default), "bold", or "italic". Applies to "text" only.' }
      },
      required: ['path']
    }
  },
  {
    name: 'add_doc_table',
    description:
      'Append a table to a WORD DOCUMENT from a 2-D array of rows — the same "rows" convention as ' +
      'write_spreadsheet. The first row is rendered as a bold header. (For a slide, use add_slide_table.)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .docx created by create_document.' },
        rows: {
          // 'array' (not 'object') — validateArgs rejects arrays for 'object'.
          type: 'array',
          description: 'Array of arrays, e.g. [["Item","Qty"],["Widgets",12],["Gadgets",4]].'
        }
      },
      required: ['path', 'rows']
    }
  },
  {
    name: 'add_image',
    description: 'Append an image (png/jpg/gif/bmp) to a document created by create_document.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .docx created by create_document.' },
        image_path: { type: 'string', description: 'Path to the image file to embed (read-only).' },
        width: { type: 'number', description: 'Optional display width in pixels (default 400, max 2000).' },
        height: { type: 'number', description: 'Optional display height in pixels (default 300, max 2000).' }
      },
      required: ['path', 'image_path']
    }
  },
  {
    name: 'add_page_break',
    description: 'Append a page break to a document created by create_document.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .docx created by create_document.' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_document_structure',
    description:
      'Show the outline of a document created by these tools — block counts plus the heading hierarchy. ' +
      'Use this to read the document before appending more content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .docx file.' }
      },
      required: ['path']
    }
  }
]

export const worddocRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  create_document,
  add_heading,
  add_paragraph,
  add_doc_table,
  add_image,
  add_page_break,
  list_document_structure
}
