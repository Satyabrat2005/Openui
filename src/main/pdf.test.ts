import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import { pdfRegistry, pdfToolSchemas } from './pdf'
import { worddocRegistry } from './worddoc'
import { presentationRegistry } from './presentation'
import { spreadsheetRegistry } from './spreadsheet'

// resolveSafePath confines mutating writes to the home tree and rejects
// sensitive dirs (AppData, .ssh, …), so the scratch dir must live directly
// under $HOME with a non-sensitive name.
const dir = mkdtempSync(join(homedir(), '.openui-pdf-test-'))
const basic = join(dir, 'basic.pdf')

// These are real I/O tests, not pure-logic ones: each read_pdf spins up a
// pdf.js worker and every round-trip renders a document to disk. That fits in
// ~1-2s alone, but vitest runs test FILES in parallel, and under that CPU
// contention the default 5s timeout is not enough. Raised per-file rather than
// globally so the rest of the suite keeps its tight default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

async function pageCount(file: string): Promise<number> {
  return (await PDFDocument.load(await readFile(file))).getPageCount()
}

beforeAll(async () => {
  const r = await pdfRegistry.create_pdf({
    path: basic,
    title: 'Quarterly Report',
    content: [
      { heading: 'Introduction', level: 2 },
      { paragraph: 'Revenue grew twenty percent across all regions.' },
      { bullets: ['EMEA led growth', 'APAC steady'] },
      { rows: [['Region', 'Revenue'], ['EMEA', '1200']] },
      { page_break: true },
      { heading: 'Appendix', level: 2 },
      'A plain string becomes a paragraph.'
    ]
  })
  expect(r.ok).toBe(true)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('pdf tools — validation', () => {
  it('rejects a write outside the home tree', async () => {
    const outside = join(homedir(), '..', 'openui-should-not-write.pdf')
    const r = await pdfRegistry.create_pdf({ path: outside, content: ['hi'] })
    expect(r.ok).toBe(false)
  })

  it('rejects a non-.pdf output and missing content', async () => {
    const wrongExt = await pdfRegistry.create_pdf({ path: join(dir, 'x.docx'), content: ['hi'] })
    expect(wrongExt.ok).toBe(false)
    expect(wrongExt.error).toContain('.pdf')

    expect((await pdfRegistry.create_pdf({ path: join(dir, 'y.pdf') })).ok).toBe(false)
    expect((await pdfRegistry.create_pdf({ path: join(dir, 'y.pdf'), content: [] })).ok).toBe(false)
  })

  it('rejects an unknown content block and a bad heading level', async () => {
    const unknown = await pdfRegistry.create_pdf({ path: join(dir, 'z.pdf'), content: [{ nope: 1 }] })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('unknown block')

    const badLevel = await pdfRegistry.create_pdf({
      path: join(dir, 'z.pdf'),
      content: [{ heading: 'H', level: 9 }]
    })
    expect(badLevel.ok).toBe(false)
  })

  it('rejects reading a file that is not a PDF', async () => {
    const notPdf = join(dir, 'notes.txt')
    writeFileSync(notPdf, 'hello')
    const r = await pdfRegistry.read_pdf({ path: notPdf })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not a .pdf')
  })

  it('rejects a corrupt PDF with a readable message', async () => {
    const corrupt = join(dir, 'corrupt.pdf')
    writeFileSync(corrupt, 'this is definitely not a pdf')
    const r = await pdfRegistry.split_pdf({ path: corrupt, pages: '1', output: join(dir, 'out.pdf') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not a readable PDF')
  })

  it('rejects an off-limits source path', async () => {
    const r = await pdfRegistry.read_pdf({ path: join(homedir(), '.ssh', 'secret.pdf') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('off-limits')
  })

  it('rejects merging fewer than two inputs', async () => {
    const r = await pdfRegistry.merge_pdfs({ paths: [basic], output: join(dir, 'merged.pdf') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('at least two')
  })

  it('rejects malformed and out-of-range page ranges', async () => {
    const bad = await pdfRegistry.split_pdf({ path: basic, pages: 'one-three', output: join(dir, 's.pdf') })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('bad page range')

    const tooHigh = await pdfRegistry.split_pdf({ path: basic, pages: '1-999', output: join(dir, 's.pdf') })
    expect(tooHigh.ok).toBe(false)
    expect(tooHigh.error).toContain('out of range')

    const missing = await pdfRegistry.split_pdf({ path: basic, output: join(dir, 's.pdf') })
    expect(missing.ok).toBe(false)
  })

  it('rejects empty watermark text and a bad opacity', async () => {
    expect((await pdfRegistry.watermark_pdf({ path: basic, text: '  ' })).ok).toBe(false)
    const badOpacity = await pdfRegistry.watermark_pdf({ path: basic, text: 'DRAFT', opacity: 5 })
    expect(badOpacity.ok).toBe(false)
    expect(badOpacity.error).toContain('opacity')
  })

  it('rejects an unsupported export source', async () => {
    const r = await pdfRegistry.export_to_pdf({ path: join(dir, 'notes.txt') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('unsupported source')
  })

  it('refuses to export an Office-authored file and points at the real converter', async () => {
    const foreign = join(dir, 'from-word.docx')
    writeFileSync(foreign, 'PK not really a document')
    const r = await pdfRegistry.export_to_pdf({ path: foreign })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('soffice')
  })

  it('exposes exactly the six pdf schemas', () => {
    const names = pdfToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(
      ['create_pdf', 'export_to_pdf', 'merge_pdfs', 'read_pdf', 'split_pdf', 'watermark_pdf'].sort()
    )
  })
})

describe('pdf tools — round-trip', () => {
  it('creates a PDF whose text reads back with read_pdf', async () => {
    expect(existsSync(basic)).toBe(true)
    // The explicit page_break must have produced a second page.
    expect(await pageCount(basic)).toBe(2)

    const r = await pdfRegistry.read_pdf({ path: basic })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('Quarterly Report')
    expect(r.output).toContain('Introduction')
    expect(r.output).toContain('Revenue grew twenty percent')
    expect(r.output).toContain('EMEA led growth')
    expect(r.output).toContain('Appendix')
    expect(r.output).toContain('2 page(s)')
  })

  it('merges two PDFs and the page counts add up', async () => {
    const second = join(dir, 'second.pdf')
    await pdfRegistry.create_pdf({ path: second, content: [{ paragraph: 'Second document body.' }] })
    const merged = join(dir, 'merged.pdf')

    const r = await pdfRegistry.merge_pdfs({ paths: [basic, second], output: merged })
    expect(r.ok).toBe(true)
    expect(await pageCount(merged)).toBe((await pageCount(basic)) + (await pageCount(second)))

    const text = await pdfRegistry.read_pdf({ path: merged })
    expect(text.output).toContain('Quarterly Report')
    expect(text.output).toContain('Second document body.')
  })

  it('splits out a page range into a new file', async () => {
    const out = join(dir, 'page2.pdf')
    const r = await pdfRegistry.split_pdf({ path: basic, pages: '2', output: out })
    expect(r.ok).toBe(true)
    expect(await pageCount(out)).toBe(1)

    const text = await pdfRegistry.read_pdf({ path: out })
    expect(text.output).toContain('Appendix')
    // Page 1's content must NOT have come along.
    expect(text.output).not.toContain('Revenue grew twenty percent')
  })

  it('watermarks every page and leaves the original text intact', async () => {
    const out = join(dir, 'stamped.pdf')
    const r = await pdfRegistry.watermark_pdf({ path: basic, text: 'DRAFT', output: out })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('2 page(s)')

    const text = await pdfRegistry.read_pdf({ path: out })
    expect(text.output).toContain('DRAFT')
    expect(text.output).toContain('Introduction')
  })

  it('exports a generated .docx to PDF with its content intact', async () => {
    const docx = join(dir, 'report.docx')
    await worddocRegistry.create_document({ path: docx, title: 'Annual Summary' })
    await worddocRegistry.add_heading({ path: docx, text: 'Findings', level: 2 })
    await worddocRegistry.add_paragraph({ path: docx, text: 'Margins improved in the second half.' })
    await worddocRegistry.add_doc_table({ path: docx, rows: [['Metric', 'Value'], ['Margin', '18%']] })

    const r = await pdfRegistry.export_to_pdf({ path: docx })
    expect(r.ok).toBe(true)
    const out = join(dir, 'report.pdf')
    expect(existsSync(out)).toBe(true)

    const text = await pdfRegistry.read_pdf({ path: out })
    expect(text.output).toContain('Annual Summary')
    expect(text.output).toContain('Findings')
    expect(text.output).toContain('Margins improved')
    expect(text.output).toContain('Margin')
    expect(text.output).toContain('18%')
  })

  it('exports a generated .pptx to PDF as one page per slide, charts included', async () => {
    const pptx = join(dir, 'deck.pptx')
    await presentationRegistry.create_presentation({ path: pptx, title: 'Board Deck' })
    await presentationRegistry.add_slide({
      path: pptx,
      layout: 'title+content',
      content: { heading: 'Growth', bullets: ['Up 20% YoY', { text: 'EMEA strongest', level: 1 }] }
    })
    await presentationRegistry.add_chart({
      path: pptx,
      slide_index: 2,
      chart_type: 'bar',
      data: { labels: ['Q1', 'Q2'], series: [{ name: 'Revenue', values: [10, 20] }] }
    })

    const out = join(dir, 'deck.pdf')
    const r = await pdfRegistry.export_to_pdf({ path: pptx, output: out })
    expect(r.ok).toBe(true)
    // One PDF page per slide (title slide + content slide).
    expect(await pageCount(out)).toBe(2)

    const text = await pdfRegistry.read_pdf({ path: out })
    expect(text.output).toContain('Board Deck')
    expect(text.output).toContain('Growth')
    expect(text.output).toContain('Up 20% YoY')
    // The chart's axis/legend labels prove it was drawn, not dropped.
    expect(text.output).toContain('Revenue')
  })

  it('exports a pie-chart deck without throwing on wedge geometry', async () => {
    const pptx = join(dir, 'pie.pptx')
    await presentationRegistry.create_presentation({ path: pptx, title: 'Share' })
    await presentationRegistry.add_chart({
      path: pptx,
      slide_index: 1,
      chart_type: 'doughnut',
      data: { labels: ['A', 'B', 'C'], series: [{ name: 'Split', values: [50, 30, 20] }] }
    })
    const out = join(dir, 'pie.pdf')
    const r = await pdfRegistry.export_to_pdf({ path: pptx, output: out })
    expect(r.ok).toBe(true)
    expect(statSync(out).size).toBeGreaterThan(500)
  })

  it('exports a workbook directly — no sidecar needed', async () => {
    const xlsx = join(dir, 'data.xlsx')
    await spreadsheetRegistry.write_spreadsheet({
      path: xlsx,
      data: { rows: [['Name', 'Score'], ['Ada', 95], ['Grace', 88]] }
    })
    const out = join(dir, 'data.pdf')
    const r = await pdfRegistry.export_to_pdf({ path: xlsx, output: out })
    expect(r.ok).toBe(true)

    const text = await pdfRegistry.read_pdf({ path: out })
    expect(text.output).toContain('Ada')
    expect(text.output).toContain('95')
    expect(text.output).toContain('Grace')
  })

  it('survives text the PDF standard fonts cannot encode', async () => {
    // Emoji and CJK would throw inside pdf-lib's WinAnsi encoder if not sanitised.
    const out = join(dir, 'unicode.pdf')
    const r = await pdfRegistry.create_pdf({
      path: out,
      content: [{ paragraph: 'Status: 完了 ✅ — “quoted” … done' }]
    })
    expect(r.ok).toBe(true)
    const text = await pdfRegistry.read_pdf({ path: out })
    // The ASCII-foldable parts survive; the rest degrades to "?" rather than crashing.
    expect(text.output).toContain('Status:')
    expect(text.output).toContain('"quoted"')
  })
})
