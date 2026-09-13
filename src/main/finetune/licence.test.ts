import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyLicence, isCommercialLicence, fetchOllamaLicence } from './licence'

// The same fixtures scripts/finetune/test_licence_guard.py reads. If the Python
// guard and this port ever disagree on one of these, one of them is wrong and
// a model could be refused on the command line but trained in the app, or the
// other way round.
const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, '../../../scripts/finetune/licence-fixtures.json'), 'utf-8')
) as { cases: Array<{ text: string; verdict: string }> }

describe('classifyLicence — shared fixtures with licence_guard.py', () => {
  it('has fixtures to check (not vacuously green)', () => {
    expect(FIXTURES.cases.length).toBeGreaterThanOrEqual(8)
    expect(new Set(FIXTURES.cases.map((c) => c.verdict))).toEqual(
      new Set(['unknown', 'apache', 'mit', 'research'])
    )
  })

  for (const c of FIXTURES.cases) {
    it(`${JSON.stringify(c.text.slice(0, 50))} → ${c.verdict}`, () => {
      expect(classifyLicence(c.text)).toBe(c.verdict)
    })
  }

  it('only apache and mit are commercial', () => {
    expect(isCommercialLicence('apache')).toBe(true)
    expect(isCommercialLicence('mit')).toBe(true)
    expect(isCommercialLicence('research')).toBe(false)
    expect(isCommercialLicence('unknown')).toBe(false)
  })
})

describe('fetchOllamaLicence', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the license field Ollama attaches to a model', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ license: 'Apache License' }) }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchOllamaLicence('http://h', 'qwen3.5:latest')).toBe('Apache License')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toBe('http://h/api/show')
    expect(JSON.parse(init.body)).toEqual({ model: 'qwen3.5:latest' })
  })

  it('joins a multi-layer licence array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ license: ['A', 'B'] }) })))
    expect(await fetchOllamaLicence('http://h', 'm')).toBe('A\nB')
  })

  it('returns null — never "allowed" — when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await fetchOllamaLicence('http://h', 'm')).toBeNull()
    expect(classifyLicence(null)).toBe('unknown')
  })
})
