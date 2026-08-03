import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { spreadsheetRegistry, spreadsheetToolSchemas } from './spreadsheet'

// resolveSafePath confines mutating writes to the home tree and rejects
// sensitive dirs (AppData, .ssh, …), so the scratch dir must live directly
// under $HOME with a non-sensitive name.
const dir = mkdtempSync(join(homedir(), '.openui-sheet-test-'))
const xlsx = join(dir, 'book.xlsx')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('spreadsheet tools', () => {
  it('writes then reads a workbook round-trip', async () => {
    const w = await spreadsheetRegistry.write_spreadsheet({
      path: xlsx,
      data: [
        ['Name', 'Score'],
        ['Ada', 95],
        ['Grace', 88]
      ]
    })
    expect(w.ok).toBe(true)

    const r = await spreadsheetRegistry.read_spreadsheet({ path: xlsx })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('Ada')
    expect(r.output).toContain('95')
    expect(r.output).toContain('Grace')
  })

  it('accepts the { rows: [...] } shape', async () => {
    const p = join(dir, 'rows.csv')
    const w = await spreadsheetRegistry.write_spreadsheet({ path: p, data: { rows: [['a', 'b']] } })
    expect(w.ok).toBe(true)
    const r = await spreadsheetRegistry.read_spreadsheet({ path: p })
    expect(r.output).toContain('a')
    expect(r.output).toContain('b')
  })

  it('sets a formula cell (leading = optional)', async () => {
    const f = await spreadsheetRegistry.add_formula({ path: xlsx, cell: 'C2', formula: 'A2&B2' })
    expect(f.ok).toBe(true)
    const r = await spreadsheetRegistry.read_spreadsheet({ path: xlsx, range: 'C2:C2' })
    // exceljs does not evaluate formulas, so the cell renders as its formula text.
    expect(r.output).toContain('=A2&B2')
  })

  it('update_cells preserves other content', async () => {
    const u = await spreadsheetRegistry.update_cells({
      path: xlsx,
      updates: { A1: 'Person', D1: '=SUM(B2:B3)' }
    })
    expect(u.ok).toBe(true)
    const r = await spreadsheetRegistry.read_spreadsheet({ path: xlsx })
    expect(r.output).toContain('Person') // overwritten header
    expect(r.output).toContain('Ada') // untouched row survives
  })

  it('rejects a write outside the home tree', async () => {
    const outside = join(homedir(), '..', 'openui-should-not-write.xlsx')
    const w = await spreadsheetRegistry.write_spreadsheet({ path: outside, data: [['x']] })
    expect(w.ok).toBe(false)
  })

  it('rejects a malformed range and cell address', async () => {
    const badRange = await spreadsheetRegistry.read_spreadsheet({ path: xlsx, range: 'not-a-range' })
    expect(badRange.ok).toBe(false)
    const badCell = await spreadsheetRegistry.add_formula({ path: xlsx, cell: 'ZZ', formula: 'A1' })
    expect(badCell.ok).toBe(false)
  })

  it('applies cell styling, merges and column widths, and they survive a re-read', async () => {
    const p = join(dir, 'styled.xlsx')
    const w = await spreadsheetRegistry.write_spreadsheet({
      path: p,
      data: [
        [{ value: 'Q4 Report', style: { bold: true, fill: 'DDEBF7', align: 'center', size: 14 } }],
        [
          { value: 'Item', style: { bold: true, border: 'thin' } },
          { value: 'Cost', style: { bold: true, border: 'thin' } }
        ],
        ['Widgets', { value: 1234.5, style: { numFmt: '$#,##0.00' } }]
      ],
      merge: ['A1:B1'],
      column_widths: { A: 22, B: 14 }
    })
    expect(w.ok).toBe(true)
    expect(w.output).toContain('1 merged range')

    // Re-open with exceljs directly and assert the real formatting landed.
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(p)
    const ws = wb.worksheets[0]
    expect(ws.getCell('A1').font?.bold).toBe(true)
    expect(ws.getCell('A1').font?.size).toBe(14)
    expect(ws.getCell('A1').alignment?.horizontal).toBe('center')
    expect((ws.getCell('A1').fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FFDDEBF7')
    expect(ws.getCell('A2').border?.top?.style).toBe('thin')
    expect(ws.getCell('B3').numFmt).toBe('$#,##0.00')
    expect(ws.getColumn(1).width).toBe(22)
    // A1:B1 is merged, so B1 reports A1 as its master cell.
    expect(ws.getCell('B1').isMerged).toBe(true)
  })

  it('update_cells can style an existing cell without losing its value', async () => {
    const u = await spreadsheetRegistry.update_cells({
      path: xlsx,
      updates: { A1: { value: 'Person', style: { bold: true, fill: 'FFFF00' } } }
    })
    expect(u.ok).toBe(true)
    expect(u.output).toContain('1 styled')

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsx)
    const cell = wb.worksheets[0].getCell('A1')
    expect(cell.value).toBe('Person')
    expect(cell.font?.bold).toBe(true)
  })

  it('rejects a malformed merge range and an out-of-range column width', async () => {
    const badMerge = await spreadsheetRegistry.write_spreadsheet({
      path: join(dir, 'bad.xlsx'),
      data: [['x']],
      merge: ['A1-B1']
    })
    expect(badMerge.ok).toBe(false)
    expect(badMerge.error).toContain('merge range')

    const badWidth = await spreadsheetRegistry.write_spreadsheet({
      path: join(dir, 'bad.xlsx'),
      data: [['x']],
      column_widths: { A: 9999 }
    })
    expect(badWidth.ok).toBe(false)
    expect(badWidth.error).toContain('out of range')
  })

  it('warns that .csv cannot hold styling', async () => {
    const p = join(dir, 'styled.csv')
    const w = await spreadsheetRegistry.write_spreadsheet({
      path: p,
      data: [[{ value: 'Bold', style: { bold: true } }]]
    })
    expect(w.ok).toBe(true)
    expect(w.output).toContain('.csv stores values only')
  })

  it('declares "data" as an array so validateArgs accepts the documented shape', () => {
    const data = spreadsheetToolSchemas.find((s) => s.name === 'write_spreadsheet')?.parameters.properties.data
    expect(data?.type).toBe('array')
  })

  it('exposes exactly the five spreadsheet schemas', () => {
    const names = spreadsheetToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(
      ['add_formula', 'list_sheets', 'read_spreadsheet', 'update_cells', 'write_spreadsheet'].sort()
    )
  })

  // Regression: write_spreadsheet used to ENOENT when the destination folder did
  // not exist, while create_pdf created it. saveWorkbook now mkdir -p's first.
  it('creates missing parent folders before writing (no pre-existing dir)', async () => {
    const nested = join(dir, 'fresh-sheet-dir', 'sub', 'book.xlsx')
    const w = await spreadsheetRegistry.write_spreadsheet({
      path: nested,
      data: [
        ['Name', 'Score'],
        ['Ada', 95]
      ]
    })
    expect(w.ok).toBe(true)
    const r = await spreadsheetRegistry.read_spreadsheet({ path: nested })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('Ada')
    expect(r.output).toContain('95')
  })
})
