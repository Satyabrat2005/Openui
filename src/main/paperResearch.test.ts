import { describe, it, expect } from 'vitest'
import {
  slugify,
  unescapeXml,
  buildArxivQueryPath,
  parseArxivAtom,
  buildSemanticScholarPath,
  parseSemanticScholarJson,
  mergePapers,
  buildSummaryPrompt,
  extractTakeaway,
  buildIndexMarkdown,
  paperResearchToolSchemas,
  paperResearchRegistry,
  type PaperResult
} from './paperResearch'

describe('slugify', () => {
  it('lowercases, hyphenates, and strips edges', () => {
    expect(slugify('Attention Is All You Need!')).toBe('attention-is-all-you-need')
  })
  it('falls back to "paper" for empty input', () => {
    expect(slugify('  ***  ')).toBe('paper')
  })
  it('caps length', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

describe('unescapeXml', () => {
  it('decodes named + numeric entities, amp last', () => {
    expect(unescapeXml('a &lt;b&gt; &amp; c &#65; &#x42;')).toBe('a <b> & c A B')
    // &amp;lt; must become &lt;, not <
    expect(unescapeXml('&amp;lt;')).toBe('&lt;')
  })
})

describe('buildArxivQueryPath', () => {
  it('encodes the query and clamps max_results', () => {
    const p = buildArxivQueryPath('graph neural networks', 5)
    expect(p).toContain('search_query=all%3Agraph%20neural%20networks')
    expect(p).toContain('max_results=5')
  })
  it('clamps above the cap and defaults junk to a sane number', () => {
    expect(buildArxivQueryPath('x', 999)).toContain('max_results=10')
    expect(buildArxivQueryPath('x', 0)).toContain('max_results=10')
  })
})

const SAMPLE_ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>The dominant sequence transduction models are based on
      complex recurrent networks &amp; attention.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <link href="http://arxiv.org/abs/1706.03762v5" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v5" rel="related" type="application/pdf"/>
  </entry>
</feed>`

describe('parseArxivAtom', () => {
  it('extracts title, authors, abstract, date, id and an https PDF url', () => {
    const [p] = parseArxivAtom(SAMPLE_ATOM)
    expect(p.title).toBe('Attention Is All You Need')
    expect(p.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer'])
    expect(p.abstract).toContain('recurrent networks & attention')
    expect(p.published).toBe('2017-06-12T17:57:34Z')
    expect(p.id).toBe('1706.03762v5')
    expect(p.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762v5')
    expect(p.source).toBe('arxiv')
  })
  it('derives a PDF url from the id when no pdf link is present', () => {
    const xml = SAMPLE_ATOM.replace(/<link title="pdf"[^>]*\/>/, '')
    expect(parseArxivAtom(xml)[0].pdfUrl).toBe('https://arxiv.org/pdf/1706.03762v5')
  })
  it('returns [] for feeds with no entries', () => {
    expect(parseArxivAtom('<feed></feed>')).toEqual([])
  })
})

describe('buildSemanticScholarPath', () => {
  it('encodes query, sets limit and requests the needed fields', () => {
    const p = buildSemanticScholarPath('deep learning', 3)
    expect(p).toContain('query=deep%20learning')
    expect(p).toContain('limit=3')
    expect(p).toContain('openAccessPdf')
  })
})

describe('parseSemanticScholarJson', () => {
  it('maps fields and only keeps https open-access PDFs', () => {
    const body = {
      data: [
        {
          paperId: 'abc123',
          title: 'A Paper',
          abstract: 'An abstract.',
          publicationDate: '2020-01-01',
          authors: [{ name: 'Jane Doe' }, { name: 'John Roe' }],
          openAccessPdf: { url: 'https://example.org/a.pdf' }
        },
        {
          paperId: 'def456',
          title: 'Closed Paper',
          authors: [{ name: 'Nobody' }],
          openAccessPdf: { url: 'http://insecure.example/b.pdf' } // http → dropped
        },
        { paperId: 'ghi789', title: '', authors: [] } // no title → skipped
      ]
    }
    const out = parseSemanticScholarJson(body)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      id: 'abc123',
      title: 'A Paper',
      authors: ['Jane Doe', 'John Roe'],
      pdfUrl: 'https://example.org/a.pdf',
      source: 'semanticscholar'
    })
    expect(out[1].pdfUrl).toBe('') // insecure PDF url stripped
  })
  it('tolerates a missing/!array data field', () => {
    expect(parseSemanticScholarJson({})).toEqual([])
    expect(parseSemanticScholarJson(null)).toEqual([])
  })
})

function paper(title: string, source: PaperResult['source'] = 'arxiv'): PaperResult {
  return { title, authors: [], abstract: '', published: '', pdfUrl: 'https://x/y.pdf', source, id: title, url: '' }
}

describe('mergePapers', () => {
  it('keeps primary first, dedupes by normalised title, and caps', () => {
    const primary = [paper('Attention Is All You Need')]
    const secondary = [paper('attention is all you need!', 'semanticscholar'), paper('Another', 'semanticscholar')]
    const merged = mergePapers(primary, secondary, 10)
    expect(merged.map((p) => p.title)).toEqual(['Attention Is All You Need', 'Another'])
  })
  it('respects the cap', () => {
    expect(mergePapers([paper('a'), paper('b'), paper('c')], [], 2)).toHaveLength(2)
  })
})

describe('buildSummaryPrompt', () => {
  it('includes the title, the required Takeaway instruction, and truncates text', () => {
    const prompt = buildSummaryPrompt('My Title', 'x'.repeat(50_000))
    expect(prompt).toContain('My Title')
    expect(prompt).toContain('Takeaway:')
    expect(prompt.length).toBeLessThan(50_000) // text was clipped
  })
})

describe('extractTakeaway', () => {
  it('reads the leading Takeaway line, ignoring markdown markers', () => {
    expect(extractTakeaway('Takeaway: It works.\n\n## Method')).toBe('It works.')
    expect(extractTakeaway('> Takeaway: Blockquoted.')).toBe('Blockquoted.')
  })
  it('falls back to the first non-heading line', () => {
    expect(extractTakeaway('# Heading\nActual first line.')).toBe('Actual first line.')
  })
  it('handles empty input', () => {
    expect(extractTakeaway('')).toBe('(no summary)')
  })
})

describe('buildIndexMarkdown', () => {
  it('links each summarised paper and flags failures', () => {
    const md = buildIndexMarkdown('topic', [
      { paper: paper('Good Paper'), takeaway: 'Great.', mdFile: '01-good-paper.md' },
      { paper: paper('Bad Paper'), takeaway: '', error: 'no text' }
    ])
    expect(md).toContain('# Research: topic')
    expect(md).toContain('[01-good-paper.md](./01-good-paper.md)')
    expect(md).toContain('> Great.')
    expect(md).toContain('⚠ Not summarised: no text')
  })
})

describe('tool registration', () => {
  it('exposes exactly the four tools in both schemas and registry', () => {
    const names = paperResearchToolSchemas.map((s) => s.name).sort()
    expect(names).toEqual(['download_paper', 'research_papers', 'search_papers', 'summarize_paper'])
    for (const n of names) expect(typeof paperResearchRegistry[n]).toBe('function')
  })
  it('every schema required field is a declared property', () => {
    for (const s of paperResearchToolSchemas) {
      for (const req of s.parameters.required) {
        expect(Object.keys(s.parameters.properties)).toContain(req)
      }
    }
  })

  it('search/research descriptions steer paper-finding to the API, not a browser', () => {
    // The "opened a blank browser, nothing happened" failure is the model driving
    // a Pro-gated vision/browser tool to hunt for papers instead of calling these
    // free, deterministic API tools. The descriptions must explicitly rule that out.
    const search = paperResearchToolSchemas.find((s) => s.name === 'search_papers')!
    const research = paperResearchToolSchemas.find((s) => s.name === 'research_papers')!
    for (const desc of [search.description, research.description]) {
      expect(desc).toMatch(/do not open a browser|never open a browser/i)
      expect(desc).toMatch(/computer_use|browser_vision_act/)
    }
    expect(search.description).toMatch(/first and only tool/i)
  })
})

describe('input validation (no network)', () => {
  it('search_papers rejects an empty query', async () => {
    expect((await paperResearchRegistry.search_papers({})).ok).toBe(false)
  })
  it('download_paper rejects a non-https url', async () => {
    const r = await paperResearchRegistry.download_paper({ pdf_url: 'http://x/y.pdf' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/https/i)
  })
  it('summarize_paper rejects a non-pdf path', async () => {
    const r = await paperResearchRegistry.summarize_paper({ pdf_path: '~/notes.txt' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/\.pdf/i)
  })
  it('research_papers rejects an empty query', async () => {
    expect((await paperResearchRegistry.research_papers({})).ok).toBe(false)
  })
})
