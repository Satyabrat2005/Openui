/**
 * spreadsheet.ts — native Excel/CSV automation for the OpenUI agent (Part 4.1).
 *
 * Self-contained tool module (schemas + registry) mirroring figma.ts. It reads
 * and writes real .xlsx / .csv workbooks with exceljs instead of driving a
 * spreadsheet GUI through computer_use — deterministic, fast, and scriptable.
 *
 * SECURITY / SAFETY:
 *   - Every path passes through resolveSafePath(): reads are blocked from
 *     sensitive dirs (SENSITIVE_PATH_RE); writes are additionally confined to
 *     the user's home tree. Same trust boundary as the file_* tools.
 *   - Row/column/cell/output counts are capped to avoid context flooding and
 *     runaway memory on a hostile or accidental huge input.
 *   - The three mutating tools (write_spreadsheet, update_cells, add_formula)
 *     are registered in STATE_CHANGING_TOOLS (tools.ts) so they are HITL-gated.
 */

import ExcelJS from 'exceljs'
import { resolveSafePath } from './fs/pathSafety'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// Caps — keep a single accidental call from flooding context or exhausting RAM.
const MAX_READ_ROWS = 2_000
const MAX_READ_COLS = 100
const MAX_WRITE_CELLS = 500_000
const MAX_UPDATES = 10_000
const MAX_OUTPUT_CHARS = 60_000
const CELL_RE = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** "A" → 1, "B" → 2, "AA" → 27. Column letters are case-insensitive. */
function colToNum(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** Parse an "A1"-style address into 1-based { row, col }, or null if malformed. */
function parseCell(addr: string): { row: number; col: number } | null {
  const m = CELL_RE.exec(addr.trim())
  if (!m) return null
  return { col: colToNum(m[1]), row: Number(m[2]) }
}

/** True for the .csv extension (single-sheet, comma-separated) vs .xlsx. */
function isCsv(path: string): boolean {
  return /\.csv$/i.test(path)
}

/** Render one exceljs cell value to a flat string for text output. */
function renderCellValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>
    if ('formula' in v) return String(v.result ?? `=${v.formula}`)
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((r) => (r as { text?: string }).text ?? '').join('')
    }
    if ('text' in v) return String(v.text)
    if ('hyperlink' in v) return String(v.text ?? v.hyperlink)
    if ('error' in v) return String(v.error)
  }
  return String(value)
}

/** Coerce a model-supplied value into an exceljs cell value (supports formulas). */
function toCellValue(raw: unknown): ExcelJS.CellValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    // A leading "=" is the universal spreadsheet convention for a formula.
    return raw.startsWith('=') ? { formula: raw.slice(1) } : raw
  }
  if (typeof raw === 'object') {
    const v = raw as Record<string, unknown>
    if (typeof v.formula === 'string') return { formula: v.formula.replace(/^=/, '') }
    if ('value' in v) return toCellValue(v.value)
  }
  return String(raw)
}

/** Load an existing workbook (or throw a friendly error if it can't be read). */
async function loadWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  if (isCsv(path)) await wb.csv.readFile(path)
  else await wb.xlsx.readFile(path)
  return wb
}

/** Persist a workbook to disk in the format implied by its extension. */
async function saveWorkbook(wb: ExcelJS.Workbook, path: string): Promise<void> {
  if (isCsv(path)) await wb.csv.writeFile(path)
  else await wb.xlsx.writeFile(path)
}

/** Pick a worksheet by name, or the first sheet when no name is given. */
function pickSheet(wb: ExcelJS.Workbook, sheet?: unknown): ExcelJS.Worksheet | undefined {
  if (typeof sheet === 'string' && sheet.trim()) return wb.getWorksheet(sheet.trim())
  return wb.worksheets[0]
}

// ── read_spreadsheet ──────────────────────────────────────────────────────────

async function read_spreadsheet(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `read_spreadsheet: ${errText(e)}` }
  }
  let wb: ExcelJS.Workbook
  try {
    wb = await loadWorkbook(file)
  } catch (e) {
    return { ok: false, error: `read_spreadsheet failed: ${errText(e)}` }
  }
  const ws = pickSheet(wb, args.sheet)
  if (!ws) {
    const names = wb.worksheets.map((w) => w.name).join(', ')
    return { ok: false, error: `read_spreadsheet: sheet not found. Available: ${names || '(none)'}.` }
  }

  // Determine the rectangle to read: explicit range, else the used range (capped).
  let r1 = 1
  let c1 = 1
  let r2 = Math.min(ws.rowCount || 0, MAX_READ_ROWS)
  let c2 = Math.min(ws.columnCount || 0, MAX_READ_COLS)
  if (typeof args.range === 'string' && args.range.trim()) {
    const [a, b] = args.range.split(':')
    const start = parseCell(a ?? '')
    const end = parseCell(b ?? a ?? '')
    if (!start || !end) {
      return { ok: false, error: `read_spreadsheet: bad range "${args.range}" (expected e.g. "A1:C10").` }
    }
    r1 = Math.min(start.row, end.row)
    r2 = Math.min(Math.max(start.row, end.row), r1 + MAX_READ_ROWS - 1)
    c1 = Math.min(start.col, end.col)
    c2 = Math.min(Math.max(start.col, end.col), c1 + MAX_READ_COLS - 1)
  }

  if (r2 < r1 || c2 < c1) {
    return { ok: true, output: `Sheet "${ws.name}" is empty.` }
  }

  const lines: string[] = [`Sheet "${ws.name}" — rows ${r1}-${r2}, cols ${c1}-${c2} (tab-separated):`]
  for (let r = r1; r <= r2; r++) {
    const row = ws.getRow(r)
    const cells: string[] = []
    for (let c = c1; c <= c2; c++) cells.push(renderCellValue(row.getCell(c).value))
    lines.push(cells.join('\t'))
    if (lines.join('\n').length > MAX_OUTPUT_CHARS) {
      lines.push(`… output truncated at ${MAX_OUTPUT_CHARS} chars.`)
      break
    }
  }
  return { ok: true, output: lines.join('\n') }
}

// ── write_spreadsheet ─────────────────────────────────────────────────────────

/** Normalise the `data` param into a 2-D array of rows, or return an error string. */
function coerceRows(data: unknown): unknown[][] | string {
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { rows?: unknown }).rows)
      ? (data as { rows: unknown[] }).rows
      : null
  if (!rows) return 'expected an array of rows (or { rows: [...] }), each row an array of cell values.'
  let cells = 0
  const out: unknown[][] = []
  for (const row of rows) {
    const arr = Array.isArray(row) ? row : [row]
    cells += arr.length
    if (cells > MAX_WRITE_CELLS) return `too many cells (limit ${MAX_WRITE_CELLS}).`
    out.push(arr)
  }
  return out
}

async function write_spreadsheet(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `write_spreadsheet: ${errText(e)}` }
  }
  const rows = coerceRows(args.data)
  if (typeof rows === 'string') return { ok: false, error: `write_spreadsheet: ${rows}` }

  try {
    const wb = new ExcelJS.Workbook()
    const name = typeof args.sheet === 'string' && args.sheet.trim() ? args.sheet.trim() : 'Sheet1'
    const ws = wb.addWorksheet(name)
    for (const row of rows) ws.addRow(row.map(toCellValue))
    await saveWorkbook(wb, file)
    return { ok: true, output: `Wrote ${rows.length} row(s) to sheet "${name}" in ${file}.` }
  } catch (e) {
    return { ok: false, error: `write_spreadsheet failed: ${errText(e)}` }
  }
}

// ── update_cells ──────────────────────────────────────────────────────────────

async function update_cells(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `update_cells: ${errText(e)}` }
  }
  const updates = args.updates
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'update_cells: "updates" must be an object mapping cell addresses to values, e.g. {"A1":"Name","B2":42}.' }
  }
  const entries = Object.entries(updates as Record<string, unknown>)
  if (entries.length > MAX_UPDATES) {
    return { ok: false, error: `update_cells: too many updates (limit ${MAX_UPDATES}).` }
  }
  for (const [addr] of entries) {
    if (!parseCell(addr)) return { ok: false, error: `update_cells: bad cell address "${addr}".` }
  }

  try {
    const wb = await loadWorkbook(file)
    const ws = pickSheet(wb, args.sheet) ?? wb.addWorksheet(
      typeof args.sheet === 'string' && args.sheet.trim() ? args.sheet.trim() : 'Sheet1'
    )
    for (const [addr, value] of entries) ws.getCell(addr).value = toCellValue(value)
    await saveWorkbook(wb, file)
    return { ok: true, output: `Updated ${entries.length} cell(s) in sheet "${ws.name}" of ${file}.` }
  } catch (e) {
    return { ok: false, error: `update_cells failed: ${errText(e)}` }
  }
}

// ── add_formula ───────────────────────────────────────────────────────────────

async function add_formula(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.path, { mutating: true })
  } catch (e) {
    return { ok: false, error: `add_formula: ${errText(e)}` }
  }
  const cell = typeof args.cell === 'string' ? args.cell.trim() : ''
  const formula = typeof args.formula === 'string' ? args.formula.trim() : ''
  if (!parseCell(cell)) return { ok: false, error: `add_formula: bad cell address "${cell}".` }
  if (!formula) return { ok: false, error: 'add_formula: "formula" is required, e.g. "SUM(A1:A10)".' }

  try {
    const wb = await loadWorkbook(file)
    const ws = pickSheet(wb, args.sheet) ?? wb.addWorksheet(
      typeof args.sheet === 'string' && args.sheet.trim() ? args.sheet.trim() : 'Sheet1'
    )
    ws.getCell(cell).value = { formula: formula.replace(/^=/, '') }
    await saveWorkbook(wb, file)
    return { ok: true, output: `Set ${cell} = "=${formula.replace(/^=/, '')}" in sheet "${ws.name}" of ${file}.` }
  } catch (e) {
    return { ok: false, error: `add_formula failed: ${errText(e)}` }
  }
}

// ── list_sheets ───────────────────────────────────────────────────────────────

async function list_sheets(args: Record<string, unknown>): Promise<ToolResult> {
  let file: string
  try {
    file = resolveSafePath(args.path, { mutating: false })
  } catch (e) {
    return { ok: false, error: `list_sheets: ${errText(e)}` }
  }
  try {
    const wb = await loadWorkbook(file)
    const lines = wb.worksheets.map(
      (w) => `- ${w.name} (${w.rowCount || 0} rows × ${w.columnCount || 0} cols)`
    )
    return { ok: true, output: `${wb.worksheets.length} sheet(s) in ${file}:\n${lines.join('\n')}` }
  } catch (e) {
    return { ok: false, error: `list_sheets failed: ${errText(e)}` }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const spreadsheetToolSchemas: ToolSchema[] = [
  {
    name: 'read_spreadsheet',
    description:
      'Read cells from an .xlsx or .csv workbook and return them as tab-separated text. ' +
      'Use this to inspect a spreadsheet before editing it, instead of opening it with computer_use.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .xlsx/.csv file (e.g. "~/Documents/budget.xlsx").' },
        sheet: { type: 'string', description: 'Optional sheet name. Defaults to the first sheet.' },
        range: { type: 'string', description: 'Optional A1-style range, e.g. "A1:D20". Defaults to the used range.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_spreadsheet',
    description:
      'Create or overwrite an .xlsx/.csv workbook from a 2-D array of rows. ' +
      'Each row is an array of cell values; a string starting with "=" becomes a formula. ' +
      'Prefer this over computer_use for generating spreadsheets.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination .xlsx/.csv path inside your home folder.' },
        sheet: { type: 'string', description: 'Optional sheet name (default "Sheet1").' },
        data: {
          type: 'object',
          description:
            'The rows to write: an array of arrays (or { "rows": [...] }). ' +
            'Example: [["Name","Score"],["Ada",95],["Grace",88]].'
        }
      },
      required: ['path', 'data']
    }
  },
  {
    name: 'update_cells',
    description:
      'Set specific cells in an existing workbook, preserving all other content. ' +
      'Pass "updates" as a map of A1 addresses to values (a string starting with "=" is a formula).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the existing .xlsx/.csv file.' },
        sheet: { type: 'string', description: 'Optional sheet name. Defaults to the first sheet.' },
        updates: {
          type: 'object',
          description: 'Map of cell address → value, e.g. {"A1":"Total","B1":"=SUM(B2:B10)"}.'
        }
      },
      required: ['path', 'updates']
    }
  },
  {
    name: 'add_formula',
    description: 'Set a single formula cell in an existing workbook, e.g. put "=SUM(A1:A10)" in B1.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the existing .xlsx/.csv file.' },
        sheet: { type: 'string', description: 'Optional sheet name. Defaults to the first sheet.' },
        cell: { type: 'string', description: 'A1-style target cell, e.g. "B1".' },
        formula: { type: 'string', description: 'The formula, with or without a leading "=", e.g. "SUM(A1:A10)".' }
      },
      required: ['path', 'cell', 'formula']
    }
  },
  {
    name: 'list_sheets',
    description: 'List the worksheet names and dimensions in an .xlsx/.csv workbook.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .xlsx/.csv file.' }
      },
      required: ['path']
    }
  }
]

export const spreadsheetRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  read_spreadsheet,
  write_spreadsheet,
  update_cells,
  add_formula,
  list_sheets
}
