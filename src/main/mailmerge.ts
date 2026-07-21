/**
 * mailmerge.ts — batch document generation for the OpenUI agent.
 *
 * The classic mail merge: one template document + one row of data per output
 * file. Self-contained tool module (schemas + registry) mirroring the other
 * Office modules. It lives in its own file rather than inside worddoc.ts
 * because it composes worddoc (the template spec) with pdf (optional PDF
 * output), and putting it in either would create an import cycle.
 *
 * HOW IT WORKS:
 *   The template is a .docx created by create_document containing {{Placeholder}}
 *   tokens anywhere in its headings, paragraph runs or table cells. mail_merge
 *   loads that document's sidecar spec (see worddoc.ts), and for each data row
 *   deep-clones the spec, substitutes every token, and writes one output file.
 *   Because it works on the spec rather than the .docx bytes, substitution is
 *   exact and never corrupts the document.
 *
 * DATA SOURCES:
 *   - data_path: an .xlsx/.csv whose FIRST ROW is the header (column names
 *     become the token names), read with exceljs.
 *   - rows: inline data — either an array of objects, or an array of arrays
 *     whose first row is the header.
 *
 * SECURITY / SAFETY:
 *   - Template and data paths are resolved READ-ONLY; the output directory is
 *     resolved as mutating (confined to the user's home tree).
 *   - Output filenames are derived from a template and then SANITISED: path
 *     separators, traversal segments and reserved Windows device names are
 *     stripped, so a hostile data row cannot write outside the output folder.
 *   - Row counts, token counts and field lengths are capped.
 *   - mail_merge is registered in STATE_CHANGING_TOOLS (tools.ts) so it is
 *     HITL-gated — it writes many files at once, so it always asks first.
 */

import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import ExcelJS from 'exceljs'
import { resolveSafePath } from './fs/pathSafety'
import { loadDocSpec, writeDocFromSpec, type BlockSpec, type DocSpec } from './worddoc'
import { renderDocSpec, savePdf } from './pdf'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// Caps — a merge fans out into many files, so the ceilings matter more here.
const MAX_ROWS = 500
const MAX_COLUMNS = 60
const MAX_FIELD_CHARS = 5_000
const MAX_NAME_CHARS = 120
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Windows reserved device names — never usable as a filename, even with a suffix. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Reduce a rendered filename to a single safe path segment. Data rows are
 * untrusted input, so anything that could escape the output directory —
 * separators, "..", drive letters, control characters — is removed rather than
 * escaped, and a reserved device name is prefixed out of the way.
 */
function safeFileName(raw: string, fallback: string): string {
  let name = raw
    .replace(/[\\/]+/g, '-')
    .replace(/\.{2,}/g, '.')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
  if (name.length > MAX_NAME_CHARS) name = name.slice(0, MAX_NAME_CHARS)
  if (!name) name = fallback
  if (RESERVED_NAMES.test(name)) name = `_${name}`
  return name
}

/** Substitute every {{token}} in a string from the row, leaving unknowns visible. */
function fill(text: string, row: Record<string, string>, missing: Set<string>): string {
  return text.replace(TOKEN_RE, (whole, key: string) => {
    const k = key.trim()
    // Case-insensitive match so {{name}} finds a "Name" column.
    const hit = Object.keys(row).find((c) => c.toLowerCase() === k.toLowerCase())
    if (hit === undefined) {
      missing.add(k)
      return whole
    }
    return row[hit]
  })
}

/** Deep-clone a document spec with every token substituted from one row. */
function fillSpec(spec: DocSpec, row: Record<string, string>, missing: Set<string>): DocSpec {
  const blocks: BlockSpec[] = spec.blocks.map((b) => {
    if (b.kind === 'heading') return { ...b, text: fill(b.text, row, missing) }
    if (b.kind === 'paragraph') {
      return { ...b, runs: b.runs.map((r) => ({ ...r, text: fill(r.text, row, missing) })) }
    }
    if (b.kind === 'table') {
      return { ...b, rows: b.rows.map((r) => r.map((c) => fill(c, row, missing))) }
    }
    // Images and page breaks carry no text to substitute.
    return { ...b }
  })
  return {
    version: 1,
    title: spec.title ? fill(spec.title, row, missing) : undefined,
    blocks
  }
}

/** Collect the distinct {{tokens}} a template uses, for reporting and validation. */
function templateTokens(spec: DocSpec): string[] {
  const found = new Set<string>()
  const scan = (text: string): void => {
    for (const m of text.matchAll(TOKEN_RE)) found.add(m[1].trim())
  }
  for (const b of spec.blocks) {
    if (b.kind === 'heading') scan(b.text)
    else if (b.kind === 'paragraph') b.runs.forEach((r) => scan(r.text))
    else if (b.kind === 'table') b.rows.forEach((r) => r.forEach(scan))
  }
  if (spec.title) scan(spec.title)
  return [...found]
}

/** Render one exceljs cell to the plain string a merge field needs. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>
    if ('result' in v) return String(v.result ?? '')
    if ('text' in v) return String(v.text)
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((r) => (r as { text?: string }).text ?? '').join('')
    }
  }
  return String(value)
}

/** Read merge rows from an .xlsx/.csv whose first row is the header. */
async function rowsFromWorkbook(file: string): Promise<Record<string, string>[] | string> {
  const wb = new ExcelJS.Workbook()
  if (/\.csv$/i.test(file)) await wb.csv.readFile(file)
  else await wb.xlsx.readFile(file)
  const ws = wb.worksheets[0]
  if (!ws) return 'the data file has no sheets.'

  const headerRow = ws.getRow(1)
  const headers: string[] = []
  const width = Math.min(ws.columnCount || 0, MAX_COLUMNS)
  for (let c = 1; c <= width; c++) {
    const name = cellText(headerRow.getCell(c).value).trim()
    headers.push(name)
  }
  if (headers.every((h) => !h)) return 'the first row of the data file must be a header row of column names.'

  const out: Record<string, string>[] = []
  const height = Math.min(ws.rowCount || 0, MAX_ROWS + 1)
  for (let r = 2; r <= height; r++) {
    const row = ws.getRow(r)
    const record: Record<string, string> = {}
    let any = false
    headers.forEach((h, i) => {
      if (!h) return
      const text = cellText(row.getCell(i + 1).value)
      if (text) any = true
      record[h] = text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) : text
    })
    if (any) out.push(record)
  }
  return out
}

/** Normalise inline `rows` into records: objects, or arrays with a header row. */
function rowsFromInline(raw: unknown): Record<string, string>[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return '"rows" must be a non-empty array of objects, or an array of arrays whose first row is the header.'
  }
  if (raw.length > MAX_ROWS + 1) return `too many rows (limit ${MAX_ROWS}).`

  if (Array.isArray(raw[0])) {
    const [header, ...body] = raw as unknown[][]
    const headers = header.map((h) => String(h ?? '').trim())
    if (headers.every((h) => !h)) return 'the first row must be a header row of column names.'
    return body.map((r) => {
      const record: Record<string, string> = {}
      headers.forEach((h, i) => {
        if (h) record[h] = String((r as unknown[])[i] ?? '').slice(0, MAX_FIELD_CHARS)
      })
      return record
    })
  }

  const out: Record<string, string>[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return 'each "rows" entry must be an object of column → value.'
    }
    const record: Record<string, string> = {}
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      record[k] = String(v ?? '').slice(0, MAX_FIELD_CHARS)
    }
    out.push(record)
  }
  return out
}

// ── mail_merge ───────────────────────────────────────────────────────────────

async function mail_merge(args: Record<string, unknown>): Promise<ToolResult> {
  // Template: read-only — the merge never modifies it.
  let template: string
  try {
    template = resolveSafePath(args.template_path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `mail_merge: template_path: ${errText(e)}` }
  }
  if (!/\.docx$/i.test(template)) {
    return { ok: false, error: `mail_merge: template must be a .docx (got "${basename(template)}").` }
  }

  const spec = await loadDocSpec(template)
  if (!spec) {
    return {
      ok: false,
      error:
        `mail_merge: ${template} has no OpenUI document spec. The template must be built with ` +
        `create_document + add_heading/add_paragraph, using {{Placeholder}} tokens where the data goes. ` +
        `A .docx authored in Word cannot be used as a template here.`
    }
  }

  const tokens = templateTokens(spec)
  if (tokens.length === 0) {
    return {
      ok: false,
      error:
        `mail_merge: ${basename(template)} contains no {{tokens}}, so every output would be identical. ` +
        `Add placeholders like {{Name}} to the template first.`
    }
  }

  const format = (typeof args.format === 'string' ? args.format.trim().toLowerCase() : 'docx')
  if (!['docx', 'pdf'].includes(format)) {
    return { ok: false, error: `mail_merge: "format" must be "docx" or "pdf" (got "${format}").` }
  }

  // Data: either a spreadsheet path or inline rows.
  let rows: Record<string, string>[]
  if (args.data_path !== undefined && args.data_path !== null && args.data_path !== '') {
    let dataFile: string
    try {
      dataFile = resolveSafePath(args.data_path, { mutating: false })
    } catch (e) {
      return { ok: false, error: `mail_merge: data_path: ${errText(e)}` }
    }
    if (!/\.(xlsx|csv)$/i.test(dataFile)) {
      return { ok: false, error: `mail_merge: data_path must be an .xlsx or .csv (got "${basename(dataFile)}").` }
    }
    try {
      const got = await rowsFromWorkbook(dataFile)
      if (typeof got === 'string') return { ok: false, error: `mail_merge: ${got}` }
      rows = got
    } catch (e) {
      return { ok: false, error: `mail_merge: cannot read ${dataFile} — ${errText(e)}` }
    }
  } else {
    const got = rowsFromInline(args.rows)
    if (typeof got === 'string') return { ok: false, error: `mail_merge: ${got}` }
    rows = got
  }

  if (rows.length === 0) return { ok: false, error: 'mail_merge: the data source has no rows.' }
  if (rows.length > MAX_ROWS) return { ok: false, error: `mail_merge: too many rows (limit ${MAX_ROWS}).` }

  // Output directory — mutating, so confined to the home tree.
  let outDir: string
  try {
    outDir = resolveSafePath(args.output_dir, { mutating: true })
  } catch (e) {
    return { ok: false, error: `mail_merge: output_dir: ${errText(e)}` }
  }

  const nameTemplate =
    typeof args.filename_template === 'string' && args.filename_template.trim()
      ? args.filename_template.trim()
      : `${basename(template, '.docx')}-{{${tokens[0]}}}`

  // Warn (don't fail) when the template asks for a column the data lacks: the
  // merge still runs and the unresolved token stays visible in the output.
  const dataColumns = new Set(Object.keys(rows[0]).map((c) => c.toLowerCase()))
  const unmatched = tokens.filter((t) => !dataColumns.has(t.toLowerCase()))

  try {
    await mkdir(outDir, { recursive: true })
    const missing = new Set<string>()
    const written: string[] = []
    const usedNames = new Set<string>()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const filled = fillSpec(spec, row, missing)
      const rendered = fill(nameTemplate, row, new Set())
      let name = safeFileName(rendered, `merge-${i + 1}`).replace(/\.(docx|pdf)$/i, '')
      // Two rows can legitimately share a name (two people called Alex) —
      // suffix rather than silently overwriting one of them.
      if (usedNames.has(name.toLowerCase())) name = `${name}-${i + 1}`
      usedNames.add(name.toLowerCase())

      const outFile = join(outDir, `${name}.${format}`)
      if (format === 'pdf') {
        const pdf = await renderDocSpec(filled)
        await savePdf(pdf, outFile)
      } else {
        await writeDocFromSpec(outFile, filled)
      }
      written.push(basename(outFile))
    }

    const preview = written.slice(0, 5).join(', ')
    return {
      ok: true,
      output:
        `Mail merge complete — wrote ${written.length} ${format.toUpperCase()} file(s) to ${outDir}: ` +
        `${preview}${written.length > 5 ? `, … (+${written.length - 5} more)` : ''}. ` +
        `Merged fields: ${tokens.join(', ')}.` +
        (unmatched.length
          ? ` WARNING: the template uses {{${unmatched.join('}}, {{')}}} but the data has no such column — ` +
            `those placeholders were left as-is in the output.`
          : '')
    }
  } catch (e) {
    return { ok: false, error: `mail_merge failed: ${errText(e)}` }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const mailMergeToolSchemas: ToolSchema[] = [
  {
    name: 'mail_merge',
    description:
      'Generate one document per data row from a template — the classic mail merge (letters, certificates, ' +
      'invoices, offer letters). The template is a .docx built with create_document containing {{Placeholder}} ' +
      'tokens; the data is a spreadsheet or inline rows. Outputs .docx or .pdf. Use this instead of calling ' +
      'create_document in a loop yourself.',
    parameters: {
      type: 'object',
      properties: {
        template_path: {
          type: 'string',
          description:
            'Path to the template .docx (must have been created by create_document) containing {{Token}} placeholders.'
        },
        data_path: {
          type: 'string',
          description:
            'Path to an .xlsx/.csv whose FIRST ROW is the header — column names become the token names. ' +
            'Provide this or "rows".'
        },
        rows: {
          type: 'array',
          description:
            'Inline data instead of data_path: [{"Name":"Ada","Role":"Engineer"}], or an array of arrays ' +
            'whose first row is the header.'
        },
        output_dir: { type: 'string', description: 'Folder to write the generated files into (created if needed).' },
        filename_template: {
          type: 'string',
          description:
            'Optional output filename pattern, e.g. "offer-{{Name}}". Tokens are substituted per row and the ' +
            'result is sanitised. Defaults to the template name plus the first token.'
        },
        format: { type: 'string', description: 'Output format: "docx" (default) or "pdf".' }
      },
      required: ['template_path', 'output_dir']
    }
  }
]

export const mailMergeRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  mail_merge
}
