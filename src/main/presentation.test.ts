import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { presentationRegistry, presentationToolSchemas } from './presentation'

// resolveSafePath confines mutating writes to the home tree and rejects
// sensitive dirs (AppData, .ssh, …), so the scratch dir must live directly
// under $HOME with a non-sensitive name.
const dir = mkdtempSync(join(homedir(), '.openui-pptx-test-'))
const deck = join(dir, 'deck.pptx')

// Every mutating call re-renders and rewrites a real .pptx, so these are I/O
// tests. Raised above vitest's 5s default because test files run in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/** Read a part out of the generated .pptx (it is a normal OOXML zip). */
async function readPart(file: string, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const entry = zip.file(name)
  return entry ? entry.async('string') : ''
}

async function partNames(file: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  return Object.keys(zip.files)
}

/**
 * Concatenate every part whose name matches. Two reasons not to address parts
 * by a fixed name: pptxgenjs numbers chart parts from a counter that is global
 * to the process (so it is not necessarily "chart1.xml" once several decks have
 * been rendered in one run), and it emits a notesSlide part for EVERY slide, so
 * the notes we set live in whichever one belongs to that slide.
 */
async function findPart(file: string, re: RegExp): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const names = Object.keys(zip.files).filter((n) => re.test(n))
  const parts = await Promise.all(names.map((n) => zip.file(n)!.async('string')))
  return parts.join('\n')
}

beforeAll(async () => {
  const r = await presentationRegistry.create_presentation({ path: deck, title: 'Quarterly Review' })
  expect(r.ok).toBe(true)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('presentation tools — validation', () => {
  it('rejects a write outside the home tree', async () => {
    const outside = join(homedir(), '..', 'openui-should-not-write.pptx')
    const r = await presentationRegistry.create_presentation({ path: outside })
    expect(r.ok).toBe(false)
  })

  it('rejects a missing path and a non-.pptx extension', async () => {
    expect((await presentationRegistry.create_presentation({})).ok).toBe(false)
    const wrongExt = await presentationRegistry.create_presentation({ path: join(dir, 'notes.txt') })
    expect(wrongExt.ok).toBe(false)
    expect(wrongExt.error).toContain('.pptx')
  })

  it('refuses to edit a .pptx it did not create, and names computer_use as the fallback', async () => {
    // A deck "authored in PowerPoint" — real file, no OpenUI sidecar spec.
    const foreign = join(dir, 'from-powerpoint.pptx')
    writeFileSync(foreign, 'PK not really a deck')
    const r = await presentationRegistry.add_slide({
      path: foreign,
      layout: 'title+content',
      content: { heading: 'Hi' }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('computer_use')
  })

  it('rejects an unknown layout', async () => {
    const r = await presentationRegistry.add_slide({
      path: deck,
      layout: 'carousel',
      content: { heading: 'Hi' }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('carousel')
  })

  it('rejects an empty slide with nothing to show', async () => {
    const r = await presentationRegistry.add_slide({ path: deck, layout: 'title+content', content: {} })
    expect(r.ok).toBe(false)
  })

  it('rejects oversized bullet input', async () => {
    const r = await presentationRegistry.add_slide({
      path: deck,
      layout: 'title+content',
      content: { heading: 'Too much', bullets: Array.from({ length: 500 }, (_, i) => `b${i}`) }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('too many bullets')
  })

  it('rejects a bullet nesting level outside 0-4', async () => {
    const r = await presentationRegistry.add_slide({
      path: deck,
      layout: 'title+content',
      content: { heading: 'Deep', bullets: [{ text: 'x', level: 9 }] }
    })
    expect(r.ok).toBe(false)
  })

  it('rejects an out-of-range and a non-integer slide_index', async () => {
    const high = await presentationRegistry.set_slide_notes({ path: deck, slide_index: 99, notes: 'x' })
    expect(high.ok).toBe(false)
    expect(high.error).toContain('out of range')
    const frac = await presentationRegistry.set_slide_notes({ path: deck, slide_index: 1.5, notes: 'x' })
    expect(frac.ok).toBe(false)
  })

  it('rejects a bad chart type and mismatched series lengths', async () => {
    const badType = await presentationRegistry.add_chart({
      path: deck,
      slide_index: 1,
      chart_type: 'sankey',
      data: { labels: ['a'], series: [{ name: 's', values: [1] }] }
    })
    expect(badType.ok).toBe(false)
    expect(badType.error).toContain('sankey')

    const mismatched = await presentationRegistry.add_chart({
      path: deck,
      slide_index: 1,
      chart_type: 'bar',
      data: { labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Rev', values: [1, 2] }] }
    })
    expect(mismatched.ok).toBe(false)
    expect(mismatched.error).toContain('must match')
  })

  it('rejects a non-numeric chart value', async () => {
    const r = await presentationRegistry.add_chart({
      path: deck,
      slide_index: 1,
      chart_type: 'line',
      data: { labels: ['Q1'], series: [{ name: 'Rev', values: ['lots'] }] }
    })
    expect(r.ok).toBe(false)
  })

  it('rejects an oversized table', async () => {
    const r = await presentationRegistry.add_slide_table({
      path: deck,
      slide_index: 1,
      rows: Array.from({ length: 400 }, () => ['x'])
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('too many rows')
  })

  it('rejects an off-limits image path without touching the deck', async () => {
    const r = await presentationRegistry.add_slide({
      path: deck,
      layout: 'blank',
      content: { image: join(homedir(), '.ssh', 'id_rsa.png') }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('off-limits')
  })

  it('rejects an unsupported image type', async () => {
    const r = await presentationRegistry.add_slide({
      path: deck,
      layout: 'blank',
      content: { image: join(dir, 'diagram.tiff') }
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('unsupported')
  })

  it('rejects empty notes', async () => {
    const r = await presentationRegistry.set_slide_notes({ path: deck, slide_index: 1, notes: '   ' })
    expect(r.ok).toBe(false)
  })

  it('exposes exactly the six presentation schemas', () => {
    const names = presentationToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(
      ['add_chart', 'add_slide', 'add_slide_table', 'create_presentation', 'list_slides', 'set_slide_notes'].sort()
    )
  })

  it('declares array-typed params as "array" so validateArgs does not reject them', () => {
    const rows = presentationToolSchemas.find((s) => s.name === 'add_slide_table')?.parameters.properties.rows
    expect(rows?.type).toBe('array')
  })
})

describe('presentation tools — round-trip', () => {
  it('builds a real .pptx whose parts contain the content that was added', async () => {
    const file = join(dir, 'roundtrip.pptx')
    expect((await presentationRegistry.create_presentation({ path: file, title: 'Annual Report' })).ok).toBe(true)

    const slide = await presentationRegistry.add_slide({
      path: file,
      layout: 'title+content',
      content: {
        heading: 'Highlights',
        bullets: ['Revenue up 20%', { text: 'EMEA led growth', level: 1 }],
        notes: 'Mention the EMEA hiring push'
      }
    })
    expect(slide.ok).toBe(true)

    const chart = await presentationRegistry.add_chart({
      path: file,
      slide_index: 2,
      chart_type: 'bar',
      data: { labels: ['Q1', 'Q2'], series: [{ name: 'Revenue', values: [10, 20] }] },
      options: { title: 'Revenue by quarter' }
    })
    expect(chart.ok).toBe(true)

    const table = await presentationRegistry.add_slide_table({
      path: file,
      slide_index: 2,
      rows: [
        ['Region', 'Revenue'],
        ['EMEA', 1200]
      ]
    })
    expect(table.ok).toBe(true)

    // Re-read the generated file as the OOXML zip it really is.
    const names = await partNames(file)
    expect(names).toContain('ppt/presentation.xml')
    expect(names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toBe(true)

    const slide2 = await readPart(file, 'ppt/slides/slide2.xml')
    expect(slide2).toContain('Highlights')
    expect(slide2).toContain('Revenue up 20%')
    expect(slide2).toContain('EMEA led growth')
    expect(slide2).toContain('1200') // the table cell

    // A NATIVE chart part, not a picture of a chart.
    expect(names.some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true)
    const chartXml = await findPart(file, /^ppt\/charts\/chart\d+\.xml$/)
    expect(chartXml).toContain('barChart')
    expect(chartXml).toContain('Revenue')

    // Speaker notes survive as a real notesSlide part.
    expect(names.some((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))).toBe(true)
    const notes = await findPart(file, /^ppt\/notesSlides\/notesSlide\d+\.xml$/)
    expect(notes).toContain('EMEA hiring push')
  })

  it('nests sub-bullets at the requested indent level', async () => {
    const file = join(dir, 'nesting.pptx')
    await presentationRegistry.create_presentation({ path: file, title: 'Nesting' })
    await presentationRegistry.add_slide({
      path: file,
      layout: 'title+content',
      content: { heading: 'Outline', bullets: [{ text: 'parent', level: 0 }, { text: 'child', level: 2 }] }
    })
    const xml = await readPart(file, 'ppt/slides/slide2.xml')
    // pptxgenjs emits indent as the paragraph's lvl attribute.
    expect(xml).toMatch(/lvl="2"/)
  })

  it('list_slides summarises the deck and drives slide_index', async () => {
    const r = await presentationRegistry.list_slides({ path: join(dir, 'roundtrip.pptx') })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('2 slide(s)')
    expect(r.output).toContain('Annual Report')
    expect(r.output).toContain('Highlights')
    expect(r.output).toContain('bar chart')
    expect(r.output).toContain('notes')
  })

  it('list_slides refuses a deck it did not create', async () => {
    const r = await presentationRegistry.list_slides({ path: join(dir, 'from-powerpoint.pptx') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('computer_use')
  })

  it('keeps only the first series for a pie chart and says so', async () => {
    const file = join(dir, 'pie.pptx')
    await presentationRegistry.create_presentation({ path: file, title: 'Share' })
    const r = await presentationRegistry.add_chart({
      path: file,
      slide_index: 1,
      chart_type: 'pie',
      data: {
        labels: ['A', 'B'],
        series: [
          { name: 'This year', values: [60, 40] },
          { name: 'Last year', values: [55, 45] }
        ]
      }
    })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('only "This year" is plotted')
    const chartXml = await findPart(file, /^ppt\/charts\/chart\d+\.xml$/)
    expect(chartXml).toContain('pieChart')
  })

  // Regression: create_presentation used to ENOENT when the destination folder
  // did not exist, while create_pdf created it. renderDeck now mkdir -p's first.
  it('creates missing parent folders before writing (no pre-existing dir)', async () => {
    const nested = join(dir, 'fresh-pptx-dir', 'sub', 'deck.pptx')
    const c = await presentationRegistry.create_presentation({ path: nested, title: 'Nested Deck' })
    expect(c.ok).toBe(true)
    const names = await partNames(nested)
    expect(names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toBe(true)
    const r = await presentationRegistry.list_slides({ path: nested })
    expect(r.ok).toBe(true)
  })
})
