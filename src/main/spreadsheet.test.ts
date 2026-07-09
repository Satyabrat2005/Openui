import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

  it('exposes exactly the five spreadsheet schemas', () => {
    const names = spreadsheetToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(
      ['add_formula', 'list_sheets', 'read_spreadsheet', 'update_cells', 'write_spreadsheet'].sort()
    )
  })
})
