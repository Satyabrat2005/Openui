import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { worddocRegistry, worddocToolSchemas } from './worddoc'

// resolveSafePath confines mutating writes to the home tree and rejects
// sensitive dirs (AppData, .ssh, …), so the scratch dir must live directly
// under $HOME with a non-sensitive name.
const dir = mkdtempSync(join(homedir(), '.openui-docx-test-'))
const doc = join(dir, 'report.docx')

// Every mutating call re-renders and rewrites a real .docx, so these are I/O
// tests. Raised above vitest's 5s default because test files run in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/** A 1×1 PNG — the smallest real image to prove embedding works. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** Read the main document body out of the generated .docx (an OOXML zip). */
async function readDocumentXml(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const entry = zip.file('word/document.xml')
  return entry ? entry.async('string') : ''
}

async function partNames(file: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  return Object.keys(zip.files)
}

beforeAll(async () => {
  const r = await worddocRegistry.create_document({ path: doc, title: 'Status Report' })
  expect(r.ok).toBe(true)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('worddoc tools — validation', () => {
  it('rejects a write outside the home tree', async () => {
    const outside = join(homedir(), '..', 'openui-should-not-write.docx')
    const r = await worddocRegistry.create_document({ path: outside })
    expect(r.ok).toBe(false)
  })

  it('rejects a missing path and a non-.docx extension', async () => {
    expect((await worddocRegistry.create_document({})).ok).toBe(false)
    const wrongExt = await worddocRegistry.create_document({ path: join(dir, 'notes.txt') })
    expect(wrongExt.ok).toBe(false)
    expect(wrongExt.error).toContain('.docx')
  })

  it('refuses to edit a .docx it did not create, and names computer_use as the fallback', async () => {
    // A document "authored in Word" — real file, no OpenUI sidecar spec.
    const foreign = join(dir, 'from-word.docx')
    writeFileSync(foreign, 'PK not really a document')
    const r = await worddocRegistry.add_paragraph({ path: foreign, text: 'Hello' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('computer_use')
  })

  it('rejects a heading level outside 1-4', async () => {
    for (const level of [0, 5, 1.5, 'two']) {
      const r = await worddocRegistry.add_heading({ path: doc, text: 'Nope', level })
      expect(r.ok).toBe(false)
    }
  })

  it('rejects an empty heading', async () => {
    const r = await worddocRegistry.add_heading({ path: doc, text: '   ', level: 1 })
    expect(r.ok).toBe(false)
  })

  it('rejects a paragraph with neither text nor runs', async () => {
    const r = await worddocRegistry.add_paragraph({ path: doc })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('runs')
  })

  it('rejects an unknown paragraph style', async () => {
    const r = await worddocRegistry.add_paragraph({ path: doc, text: 'hi', style: 'shouty' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('shouty')
  })

  it('rejects an oversized paragraph', async () => {
    const r = await worddocRegistry.add_paragraph({ path: doc, text: 'x'.repeat(20_001) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('exceeds')
  })

  it('rejects a malformed run array', async () => {
    const r = await worddocRegistry.add_paragraph({ path: doc, runs: [{ bold: true }] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('text')
  })

  it('rejects an oversized table', async () => {
    const tooManyRows = await worddocRegistry.add_doc_table({
      path: doc,
      rows: Array.from({ length: 600 }, () => ['x'])
    })
    expect(tooManyRows.ok).toBe(false)
    expect(tooManyRows.error).toContain('too many rows')

    const tooManyCols = await worddocRegistry.add_doc_table({
      path: doc,
      rows: [Array.from({ length: 30 }, (_, i) => `c${i}`)]
    })
    expect(tooManyCols.ok).toBe(false)
    expect(tooManyCols.error).toContain('too many columns')
  })

  it('rejects an empty table', async () => {
    const r = await worddocRegistry.add_doc_table({ path: doc, rows: [] })
    expect(r.ok).toBe(false)
  })

  it('rejects an off-limits image path', async () => {
    const r = await worddocRegistry.add_image({ path: doc, image_path: join(homedir(), '.ssh', 'key.png') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('off-limits')
  })

  it('rejects an unsupported image type and an out-of-range size', async () => {
    const badType = await worddocRegistry.add_image({ path: doc, image_path: join(dir, 'logo.tiff') })
    expect(badType.ok).toBe(false)
    expect(badType.error).toContain('unsupported')

    const png = join(dir, 'dot.png')
    writeFileSync(png, PNG_1PX)
    const badSize = await worddocRegistry.add_image({ path: doc, image_path: png, width: 99_999 })
    expect(badSize.ok).toBe(false)
    expect(badSize.error).toContain('width')
  })

  it('exposes exactly the seven worddoc schemas', () => {
    const names = worddocToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(
      [
        'add_doc_table',
        'add_heading',
        'add_image',
        'add_page_break',
        'add_paragraph',
        'create_document',
        'list_document_structure'
      ].sort()
    )
  })

  it('declares array-typed params as "array" so validateArgs does not reject them', () => {
    const props = Object.fromEntries(worddocToolSchemas.map((s) => [s.name, s.parameters.properties]))
    expect(props.add_doc_table.rows.type).toBe('array')
    expect(props.add_paragraph.runs.type).toBe('array')
  })

  it('does not share a tool name with the presentation module', async () => {
    const { presentationToolSchemas } = await import('./presentation')
    const overlap = worddocToolSchemas
      .map((s) => s.name)
      .filter((n) => presentationToolSchemas.some((p) => p.name === n))
    expect(overlap).toEqual([])
  })
})

describe('worddoc tools — round-trip', () => {
  it('builds a real .docx whose document.xml contains the content that was added', async () => {
    const file = join(dir, 'roundtrip.docx')
    expect((await worddocRegistry.create_document({ path: file, title: 'Annual Report' })).ok).toBe(true)

    expect((await worddocRegistry.add_heading({ path: file, text: 'Introduction', level: 2 })).ok).toBe(true)
    expect((await worddocRegistry.add_paragraph({ path: file, text: 'Revenue grew steadily.' })).ok).toBe(true)
    expect(
      (
        await worddocRegistry.add_paragraph({
          path: file,
          runs: [
            { text: 'Warning: ', bold: true },
            { text: 'margins narrowed.', italic: true }
          ]
        })
      ).ok
    ).toBe(true)
    expect(
      (
        await worddocRegistry.add_doc_table({
          path: file,
          rows: [
            ['Region', 'Revenue'],
            ['EMEA', 1200]
          ]
        })
      ).ok
    ).toBe(true)
    expect((await worddocRegistry.add_page_break({ path: file })).ok).toBe(true)

    const xml = await readDocumentXml(file)
    expect(xml).toContain('Annual Report') // the title heading
    expect(xml).toContain('Introduction')
    expect(xml).toContain('Revenue grew steadily.')
    expect(xml).toContain('Warning: ')
    expect(xml).toContain('margins narrowed.')
    expect(xml).toContain('EMEA')
    expect(xml).toContain('1200')

    // Real Word constructs, not just text: heading styles, a table, a page break.
    expect(xml).toMatch(/Heading1/)
    expect(xml).toMatch(/Heading2/)
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('w:type="page"')
    // The bold run really is bold.
    expect(xml).toMatch(/<w:b\b/)
  })

  it('embeds an image as a real media part', async () => {
    const file = join(dir, 'withimage.docx')
    await worddocRegistry.create_document({ path: file, title: 'Visuals' })
    const png = join(dir, 'dot.png')
    writeFileSync(png, PNG_1PX)

    const r = await worddocRegistry.add_image({ path: file, image_path: png, width: 120, height: 90 })
    expect(r.ok).toBe(true)

    const names = await partNames(file)
    expect(names.some((n) => /^word\/media\//.test(n))).toBe(true)
    const xml = await readDocumentXml(file)
    expect(xml).toContain('<w:drawing>')
  })

  it('pads ragged rows so the Word table stays rectangular', async () => {
    const file = join(dir, 'ragged.docx')
    await worddocRegistry.create_document({ path: file })
    const r = await worddocRegistry.add_doc_table({
      path: file,
      rows: [['a', 'b', 'c'], ['d']]
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('2×3')
  })

  it('accepts the { rows: [...] } shape, like write_spreadsheet', async () => {
    const file = join(dir, 'rowsshape.docx')
    await worddocRegistry.create_document({ path: file })
    const r = await worddocRegistry.add_doc_table({ path: file, rows: { rows: [['x', 'y']] } })
    expect(r.ok).toBe(true)
    const xml = await readDocumentXml(file)
    expect(xml).toContain('<w:tbl>')
  })

  it('list_document_structure reports the outline', async () => {
    const r = await worddocRegistry.list_document_structure({ path: join(dir, 'roundtrip.docx') })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('# Annual Report')
    expect(r.output).toContain('## Introduction')
    expect(r.output).toContain('1 table(s)')
  })

  it('list_document_structure refuses a document it did not create', async () => {
    const r = await worddocRegistry.list_document_structure({ path: join(dir, 'from-word.docx') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('computer_use')
  })
})
