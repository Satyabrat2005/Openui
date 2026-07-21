import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  clearFigmaFileCache,
  collectFrames,
  collectIconNodes,
  create_figma_comment,
  describeNodeTree,
  export_figma_frames,
  export_figma_tokens,
  figmaToolSchemas,
  figmaRegistry,
  figma_frame_to_code,
  get_figma_components,
  get_figma_design_system,
  get_figma_file,
  get_figma_node_details,
  list_figma_comments,
  parseRetryAfterMs
} from './figma'
import type { FigmaNode } from './figmaTypes'

// node:https is mocked so the retry tests can drive real response sequences
// (429 → 200, socket error → 200) without touching the network. Every other
// test in this file fails validation or the token gate before reaching it.
const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }))
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => httpsRequestMock(...args)
}))

// These tests exercise the pure validation that runs BEFORE any network call,
// plus the node-spec renderer. FIGMA_TOKEN is cleared so nothing can reach the
// real API even if a validation guard were to regress.
const savedToken = process.env.FIGMA_TOKEN

beforeEach(() => {
  delete process.env.FIGMA_TOKEN
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.FIGMA_TOKEN
  else process.env.FIGMA_TOKEN = savedToken
})

describe('file_key validation', () => {
  // Every tool takes a file_key and must reject a bad one identically.
  const tools: [string, (a: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>][] = [
    ['get_figma_file', get_figma_file],
    ['get_figma_components', get_figma_components],
    ['get_figma_design_system', get_figma_design_system],
    ['export_figma_tokens', export_figma_tokens],
    ['export_figma_frames', export_figma_frames],
    ['list_figma_comments', list_figma_comments]
  ]

  for (const [name, fn] of tools) {
    it(`${name} rejects a missing file_key`, async () => {
      const r = await fn({})
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/requires a string "file_key"/)
    })

    it(`${name} rejects a malformed file_key`, async () => {
      const r = await fn({ file_key: 'has spaces/and slashes' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/invalid file_key/)
    })
  }

  it('rejects a file_key that is too short to be real', async () => {
    const r = await get_figma_file({ file_key: 'ab' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid file_key/)
  })

  it('rejects a path-traversal attempt in the file_key', async () => {
    const r = await get_figma_file({ file_key: '../../v1/me' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid file_key/)
  })
})

describe('node_id validation', () => {
  it('get_figma_node_details requires node_ids', async () => {
    const r = await get_figma_node_details({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires "node_ids"/)
  })

  it('get_figma_node_details rejects a malformed node id', async () => {
    const r = await get_figma_node_details({ file_key: 'ABC123abc', node_ids: 'not-an-id' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid node_id/)
  })

  it('export_figma_frames rejects a malformed node id', async () => {
    const r = await export_figma_frames({ file_key: 'ABC123abc', node_ids: '1:2,bogus' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid node_id "bogus"/)
  })

  it('figma_frame_to_code requires a valid node_id', async () => {
    const r = await figma_frame_to_code({ file_key: 'ABC123abc', node_id: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a valid "node_id"/)
  })

  it('create_figma_comment rejects a malformed node_id', async () => {
    const r = await create_figma_comment({
      file_key: 'ABC123abc',
      message: 'hi',
      node_id: 'bad'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid node_id/)
  })
})

describe('export_figma_tokens format validation', () => {
  it('rejects an unsupported format before making any request', async () => {
    const r = await export_figma_tokens({ file_key: 'ABC123abc', format: 'stylus' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid format "stylus"/)
  })

  it('lists the supported formats in the error', async () => {
    const r = await export_figma_tokens({ file_key: 'ABC123abc', format: 'xml' })
    expect(r.error).toMatch(/css, scss, json, tailwind, ts/)
  })
})

describe('figma_frame_to_code framework validation', () => {
  it('rejects an unsupported framework', async () => {
    const r = await figma_frame_to_code({
      file_key: 'ABC123abc',
      node_id: '1:2',
      framework: 'svelte'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid framework "svelte"/)
  })
})

describe('create_figma_comment message validation', () => {
  it('requires a non-empty message', async () => {
    const r = await create_figma_comment({ file_key: 'ABC123abc', message: '   ' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/non-empty string "message"/)
  })

  it('rejects a message past the character cap', async () => {
    const r = await create_figma_comment({ file_key: 'ABC123abc', message: 'x'.repeat(10_001) })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exceeds the .* limit/)
  })
})

describe('token gate', () => {
  // With no token configured, anything that reaches the network must fail with
  // the actionable Settings message rather than a raw HTTP error.
  it('tells the user where to configure a token', async () => {
    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Settings → Figma/)
  })
})

describe('describeNodeTree', () => {
  it('reports exact dimensions', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'FRAME',
      name: 'Card',
      absoluteBoundingBox: { x: 0, y: 0, width: 344, height: 210 }
    })
    expect(spec).toContain('FRAME "Card"')
    expect(spec).toContain('344×210')
  })

  it('reports auto-layout as direction, gap and padding', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'FRAME',
      name: 'Stack',
      layoutMode: 'HORIZONTAL',
      itemSpacing: 12,
      paddingTop: 16,
      paddingRight: 24,
      paddingBottom: 16,
      paddingLeft: 24,
      primaryAxisAlignItems: 'SPACE_BETWEEN'
    })
    expect(spec).toContain('autolayout:row')
    expect(spec).toContain('gap:12')
    expect(spec).toContain('padding:16/24/16/24')
    expect(spec).toContain('justify:SPACE_BETWEEN')
  })

  it('reports a wrapping auto-layout frame, including the cross-axis gap', () => {
    // Without this the generator emits a single non-wrapping row that looks
    // correct at the frame's own width and breaks at every other one.
    const spec = describeNodeTree({
      id: '1:1',
      type: 'FRAME',
      name: 'Tag Cloud',
      layoutMode: 'HORIZONTAL',
      layoutWrap: 'WRAP',
      itemSpacing: 8,
      counterAxisSpacing: 12
    })
    expect(spec).toContain('autolayout:row')
    expect(spec).toContain('wrap')
    expect(spec).toContain('row-gap:12')
  })

  it('does not claim wrap on a non-wrapping auto-layout frame', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'FRAME',
      name: 'Row',
      layoutMode: 'HORIZONTAL',
      layoutWrap: 'NO_WRAP',
      itemSpacing: 8
    })
    expect(spec).toContain('autolayout:row')
    expect(spec).not.toContain('wrap')
  })

  it('reports a child that opts out of auto-layout flow', () => {
    // Badges/overlays carry layoutPositioning ABSOLUTE. Missing it makes the
    // generator lay the badge out inline, shifting every sibling.
    const spec = describeNodeTree({
      id: '1:1',
      type: 'FRAME',
      name: 'Avatar',
      layoutMode: 'VERTICAL',
      itemSpacing: 4,
      children: [
        { id: '1:2', type: 'RECTANGLE', name: 'Photo' },
        { id: '1:3', type: 'ELLIPSE', name: 'Status Badge', layoutPositioning: 'ABSOLUTE' }
      ]
    })
    const badgeLine = spec.split('\n').find((l) => l.includes('Status Badge')) ?? ''
    const photoLine = spec.split('\n').find((l) => l.includes('Photo')) ?? ''
    expect(badgeLine).toContain('position:absolute')
    expect(photoLine).not.toContain('position:absolute')
  })

  it('reports the literal text content so generated copy is not invented', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'TEXT',
      name: 'Headline',
      characters: 'Ship your design system',
      style: { fontFamily: 'Inter', fontSize: 32, fontWeight: 700, lineHeightPx: 40 }
    })
    expect(spec).toContain('font:Inter 32px/700')
    expect(spec).toContain('lh:40')
    expect(spec).toContain('"Ship your design system"')
  })

  it('collapses whitespace in text content', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'TEXT',
      characters: 'line one\n\n  line two',
      style: { fontSize: 16 }
    })
    expect(spec).toContain('"line one line two"')
  })

  it('reports fills as hex', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'RECTANGLE',
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]
    })
    expect(spec).toContain('fill:#FF0000')
  })

  it('reports radius, border and opacity', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'RECTANGLE',
      cornerRadius: 8,
      opacity: 0.5,
      strokeWeight: 2,
      strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]
    })
    expect(spec).toContain('radius:8')
    expect(spec).toContain('border:2px #000000')
    expect(spec).toContain('opacity:0.50')
  })

  it('indents children to show the hierarchy', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'FRAME',
      name: 'Parent',
      children: [{ id: '1:2', type: 'RECTANGLE', name: 'Child' }]
    })
    const lines = spec.split('\n')
    expect(lines[0]).toMatch(/^- FRAME "Parent"/)
    expect(lines[1]).toMatch(/^ {2}- RECTANGLE "Child"/)
  })

  it('omits hidden layers — they do not render, so they must not reach the generator', () => {
    const spec = describeNodeTree({
      id: '1:1',
      type: 'FRAME',
      name: 'Parent',
      children: [
        { id: '1:2', type: 'RECTANGLE', name: 'Hidden', visible: false },
        { id: '1:3', type: 'RECTANGLE', name: 'Shown' }
      ]
    })
    expect(spec).toContain('Shown')
    expect(spec).not.toContain('Hidden')
  })

  it('respects the depth cap', () => {
    let node: FigmaNode = { id: 'leaf', type: 'RECTANGLE', name: 'Leaf' }
    for (let i = 0; i < 30; i += 1) {
      node = { id: `n${i}`, type: 'FRAME', name: `L${i}`, children: [node] }
    }
    const spec = describeNodeTree(node, 3)
    expect(spec).not.toContain('Leaf')
    expect(spec.split('\n').length).toBeLessThanOrEqual(5)
  })
})

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3_000)
    expect(parseRetryAfterMs('0')).toBe(0)
  })

  it('reads an HTTP-date', () => {
    const ms = parseRetryAfterMs(new Date(Date.now() + 5_000).toUTCString())
    expect(ms).toBeGreaterThan(3_000)
    expect(ms).toBeLessThanOrEqual(5_000)
  })

  it('never returns a negative wait for a date in the past', () => {
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0)
  })

  it('returns null when absent or unparseable, so the caller can default', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull()
    expect(parseRetryAfterMs('')).toBeNull()
    expect(parseRetryAfterMs('soon')).toBeNull()
  })
})

describe('figmaFetch retry behaviour', () => {
  /** A minimal FigmaFileResponse body, enough for get_figma_file to succeed. */
  const FILE_BODY = JSON.stringify({
    name: 'Retry Fixture',
    lastModified: '2026-01-01T00:00:00Z',
    document: {
      id: '0:0',
      type: 'DOCUMENT',
      children: [{ id: '0:1', type: 'CANVAS', name: 'Page 1', children: [] }]
    }
  })

  type ResponseSpec = { status: number; body: string; headers?: Record<string, string> } | 'network-error'

  /**
   * Queue a sequence of responses. Each call to https.request consumes the next;
   * the last one repeats if the code under test asks for more.
   */
  function queue(responses: ResponseSpec[]): void {
    let i = 0
    httpsRequestMock.mockImplementation((_opts: unknown, cb: (res: EventEmitter) => void) => {
      const spec = responses[Math.min(i, responses.length - 1)]
      i += 1

      const req = Object.assign(new EventEmitter(), {
        write: (): void => {},
        destroy: (): void => {},
        end: (): void => {
          setImmediate(() => {
            if (spec === 'network-error') {
              req.emit('error', new Error('socket hang up'))
              return
            }
            const res = Object.assign(new EventEmitter(), {
              statusCode: spec.status,
              headers: spec.headers ?? {}
            })
            cb(res)
            setImmediate(() => {
              res.emit('data', Buffer.from(spec.body))
              res.emit('end')
            })
          })
        }
      })
      return req
    })
  }

  beforeEach(() => {
    httpsRequestMock.mockReset()
    process.env.FIGMA_TOKEN = 'test-token'
  })

  it('retries once after a 429 and succeeds on the second attempt', async () => {
    queue([
      { status: 429, body: '{"err":"rate limited"}', headers: { 'retry-after': '0' } },
      { status: 200, body: FILE_BODY }
    ])

    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('Retry Fixture')
    expect(httpsRequestMock).toHaveBeenCalledTimes(2)
  })

  it('honours the Retry-After header before retrying', async () => {
    queue([
      { status: 429, body: '{}', headers: { 'retry-after': '0.2' } },
      { status: 200, body: FILE_BODY }
    ])

    const started = Date.now()
    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('surfaces an actionable error when the retry is also rate limited', async () => {
    queue([{ status: 429, body: '{}', headers: { 'retry-after': '0' } }])

    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/429/)
    expect(r.error).toMatch(/rate limited/i)
    // Retried exactly once — not an unbounded loop against a rate-limited API.
    expect(httpsRequestMock).toHaveBeenCalledTimes(2)
  })

  it('retries a network-level error and succeeds on the second attempt', async () => {
    queue(['network-error', { status: 200, body: FILE_BODY }])

    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(true)
    expect(httpsRequestMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after the network retry budget, with the underlying cause', async () => {
    queue(['network-error'])

    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/socket hang up/)
    expect(httpsRequestMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 404 — it would fail identically', async () => {
    queue([{ status: 404, body: '{"err":"Not found"}' }])

    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/404/)
    expect(r.error).toMatch(/Not found/)
    expect(httpsRequestMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 403 — the token lacks access either way', async () => {
    queue([{ status: 403, body: '{"err":"Invalid token"}' }])

    const r = await get_figma_file({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(false)
    expect(httpsRequestMock).toHaveBeenCalledTimes(1)
  })
})

describe('whole-file cache', () => {
  const FILE_BODY = JSON.stringify({
    name: 'Cached File',
    document: {
      id: '0:0',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          type: 'CANVAS',
          name: 'Page 1',
          children: [
            { id: '1:1', type: 'FRAME', name: 'Card', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }
          ]
        }
      ]
    }
  })

  /** Record every requested path, always answering 200 with FILE_BODY. */
  const paths: string[] = []
  function alwaysOk(): void {
    httpsRequestMock.mockImplementation(
      (opts: { path?: string }, cb: (res: EventEmitter) => void) => {
        paths.push(opts?.path ?? '')
        const req = Object.assign(new EventEmitter(), {
          write: (): void => {},
          destroy: (): void => {},
          end: (): void => {
            setImmediate(() => {
              const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
              cb(res)
              setImmediate(() => {
                res.emit('data', Buffer.from(FILE_BODY))
                res.emit('end')
              })
            })
          }
        })
        return req
      }
    )
  }

  beforeEach(() => {
    httpsRequestMock.mockReset()
    paths.length = 0
    process.env.FIGMA_TOKEN = 'test-token'
    clearFigmaFileCache()
    alwaysOk()
  })

  afterEach(() => {
    clearFigmaFileCache()
  })

  /** Whole-document fetches only — /variables/local rides along separately. */
  const fileFetches = (): string[] => paths.filter((p) => !p.includes('/variables/'))
  const variableFetches = (): string[] => paths.filter((p) => p.includes('/variables/'))

  it('serves a second call for the same file from memory', async () => {
    const first = await get_figma_design_system({ file_key: 'ABC123abc' })
    const second = await get_figma_design_system({ file_key: 'ABC123abc' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.output).toBe(first.output)
    expect(fileFetches()).toHaveLength(1)
  })

  it('caches the variables lookup too', async () => {
    await get_figma_design_system({ file_key: 'ABC123abc' })
    await get_figma_design_system({ file_key: 'ABC123abc' })
    expect(variableFetches()).toHaveLength(1)
  })

  it('fetches the full document, so a cached entry can satisfy shallower callers', async () => {
    await get_figma_design_system({ file_key: 'ABC123abc' })
    expect(fileFetches()[0]).not.toMatch(/depth=/)
  })

  it('does not share an entry between different files', async () => {
    await get_figma_design_system({ file_key: 'ABC123abc' })
    await get_figma_design_system({ file_key: 'XYZ789xyz' })
    expect(fileFetches()).toHaveLength(2)
  })

  it('re-fetches once the cache is cleared', async () => {
    await get_figma_design_system({ file_key: 'ABC123abc' })
    clearFigmaFileCache()
    await get_figma_design_system({ file_key: 'ABC123abc' })
    expect(fileFetches()).toHaveLength(2)
  })
})

describe('Figma Variables permission handling', () => {
  const FILE_BODY = JSON.stringify({
    name: 'Variables File',
    document: {
      id: '0:0',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          type: 'CANVAS',
          name: 'Page 1',
          children: [
            { id: '1:1', type: 'FRAME', name: 'Card', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }
          ]
        }
      ]
    }
  })

  /** 200 for the document, a chosen status for /variables/local. */
  function respond(variablesStatus: number, variablesBody: string): void {
    httpsRequestMock.mockImplementation(
      (opts: { path?: string }, cb: (res: EventEmitter) => void) => {
        const isVariables = (opts?.path ?? '').includes('/variables/')
        const req = Object.assign(new EventEmitter(), {
          write: (): void => {},
          destroy: (): void => {},
          end: (): void => {
            setImmediate(() => {
              const res = Object.assign(new EventEmitter(), {
                statusCode: isVariables ? variablesStatus : 200,
                headers: {}
              })
              cb(res)
              setImmediate(() => {
                res.emit('data', Buffer.from(isVariables ? variablesBody : FILE_BODY))
                res.emit('end')
              })
            })
          }
        })
        return req
      }
    )
  }

  beforeEach(() => {
    httpsRequestMock.mockReset()
    process.env.FIGMA_TOKEN = 'test-token'
    clearFigmaFileCache()
  })
  afterEach(() => clearFigmaFileCache())

  it('still returns a design system when the variables endpoint is forbidden', async () => {
    // /variables/local needs the file_variables:read scope on an Enterprise
    // file. Most tokens get a 403, which must not sink the whole tool call.
    respond(403, '{"err":"Invalid scope"}')

    const r = await get_figma_design_system({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('COLOURS')
  })

  it('explains that the 403 is a scope/plan problem, not an empty design system', async () => {
    respond(403, '{"err":"Invalid scope"}')

    const r = await get_figma_design_system({ file_key: 'ABC123abc' })
    expect(r.output).toMatch(/file_variables:read/)
    expect(r.output).toMatch(/Enterprise/)
  })

  it('applies variable names to the extracted tokens when the endpoint works', async () => {
    respond(
      200,
      JSON.stringify({
        meta: {
          variableCollections: { c1: { id: 'c1', name: 'Primitives', defaultModeId: 'm1' } },
          variables: {
            v1: {
              id: 'v1',
              name: 'ink/black',
              variableCollectionId: 'c1',
              resolvedType: 'COLOR',
              valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 } }
            }
          }
        }
      })
    )

    const r = await get_figma_design_system({ file_key: 'ABC123abc' })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('ink/black')
  })
})

describe('collectFrames', () => {
  /** Document → Page wrapper matching the API's shape. */
  const pageWith = (children: FigmaNode[]): FigmaNode => ({
    id: '0:0',
    type: 'DOCUMENT',
    children: [{ id: '0:1', type: 'CANVAS', name: 'Page 1', children }]
  })

  it('finds frames nested inside a Section as well as loose ones', () => {
    // Sections are how modern Figma files group frames on a canvas. Before this
    // was handled, a sectioned page reported only the loose frame — or nothing.
    const frames = collectFrames(
      pageWith([
        {
          id: '1:1',
          type: 'SECTION',
          name: 'Marketing',
          children: [
            { id: '1:2', type: 'FRAME', name: 'Landing' },
            { id: '1:3', type: 'FRAME', name: 'Pricing' }
          ]
        },
        { id: '1:4', type: 'FRAME', name: 'Loose Frame' }
      ])
    )

    expect(frames.map((f) => f.name)).toEqual(['Landing', 'Pricing', 'Loose Frame'])
    expect(frames.map((f) => f.id)).toEqual(['1:2', '1:3', '1:4'])
    expect(frames.every((f) => f.page === 'Page 1')).toBe(true)
  })

  it('tags section-nested frames with their section, and loose frames with none', () => {
    const frames = collectFrames(
      pageWith([
        { id: '1:1', type: 'SECTION', name: 'Marketing', children: [{ id: '1:2', type: 'FRAME', name: 'Landing' }] },
        { id: '1:3', type: 'FRAME', name: 'Loose Frame' }
      ])
    )
    expect(frames[0].section).toBe('Marketing')
    expect(frames[1].section).toBeUndefined()
  })

  it('descends through nested sections', () => {
    const frames = collectFrames(
      pageWith([
        {
          id: '1:1',
          type: 'SECTION',
          name: 'Outer',
          children: [
            { id: '1:2', type: 'SECTION', name: 'Inner', children: [{ id: '1:3', type: 'FRAME', name: 'Deep' }] }
          ]
        }
      ])
    )
    expect(frames).toHaveLength(1)
    expect(frames[0].name).toBe('Deep')
    expect(frames[0].section).toBe('Outer / Inner')
  })

  it('collects COMPONENT and COMPONENT_SET inside sections too', () => {
    const frames = collectFrames(
      pageWith([
        {
          id: '1:1',
          type: 'SECTION',
          name: 'Library',
          children: [
            { id: '1:2', type: 'COMPONENT', name: 'Button' },
            { id: '1:3', type: 'COMPONENT_SET', name: 'Button Set' },
            { id: '1:4', type: 'RECTANGLE', name: 'Not A Frame' }
          ]
        }
      ])
    )
    expect(frames.map((f) => f.name)).toEqual(['Button', 'Button Set'])
  })

  it('does not recurse past the section depth cap', () => {
    // Guards against an unbounded walk turning this into a whole-document scan.
    let node: FigmaNode = { id: 'leaf', type: 'FRAME', name: 'Buried' }
    for (let i = 0; i < 6; i += 1) {
      node = { id: `s${i}`, type: 'SECTION', name: `S${i}`, children: [node] }
    }
    expect(collectFrames(pageWith([node]))).toHaveLength(0)
  })
})

describe('collectIconNodes', () => {
  it('picks the icon container, not each path inside it', () => {
    // Designers leave a 24×24 frame named "icon/search" holding a few paths.
    // Exporting each path separately yields fragments that lost their layout.
    const icons = collectIconNodes({
      id: '1:1',
      type: 'FRAME',
      name: 'Toolbar',
      absoluteBoundingBox: { width: 400, height: 48 },
      children: [
        {
          id: '1:2',
          type: 'FRAME',
          name: 'icon/search',
          absoluteBoundingBox: { width: 24, height: 24 },
          children: [
            { id: '1:3', type: 'VECTOR', name: 'path-a' },
            { id: '1:4', type: 'VECTOR', name: 'path-b' }
          ]
        }
      ]
    })

    expect(icons).toHaveLength(1)
    expect(icons[0].name).toBe('icon/search')
  })

  it('finds bare VECTOR and BOOLEAN_OPERATION nodes', () => {
    const icons = collectIconNodes({
      id: '1:1',
      type: 'FRAME',
      name: 'Root',
      absoluteBoundingBox: { width: 400, height: 400 },
      children: [
        { id: '1:2', type: 'VECTOR', name: 'Arrow', absoluteBoundingBox: { width: 16, height: 16 } },
        { id: '1:3', type: 'BOOLEAN_OPERATION', name: 'Union', absoluteBoundingBox: { width: 20, height: 20 } }
      ]
    })
    expect(icons.map((i) => i.name)).toEqual(['Arrow', 'Union'])
  })

  it('does not mistake a large box of shapes for an icon', () => {
    // A card built from rectangles is a layout; rasterising it as an "icon"
    // would drop it out of the generated markup as one opaque blob.
    const icons = collectIconNodes({
      id: '1:1',
      type: 'FRAME',
      name: 'Root',
      absoluteBoundingBox: { width: 800, height: 600 },
      children: [
        {
          id: '1:2',
          type: 'FRAME',
          name: 'Card',
          absoluteBoundingBox: { width: 344, height: 210 },
          children: [{ id: '1:3', type: 'RECTANGLE', name: 'BG', absoluteBoundingBox: { width: 344, height: 210 } }]
        }
      ]
    })
    expect(icons).toHaveLength(0)
  })

  it('descends through a text-bearing container to the vector inside it', () => {
    // The chip itself must NOT be exported as one icon — it contains real text,
    // and flattening it to SVG would bake the copy into an image. The vector
    // inside it is still a genuine icon, so it is exported on its own.
    const icons = collectIconNodes({
      id: '1:1',
      type: 'FRAME',
      name: 'Root',
      absoluteBoundingBox: { width: 400, height: 400 },
      children: [
        {
          id: '1:2',
          type: 'FRAME',
          name: 'Chip',
          absoluteBoundingBox: { width: 80, height: 24 },
          children: [
            { id: '1:3', type: 'VECTOR', name: 'dot', absoluteBoundingBox: { width: 8, height: 8 } },
            { id: '1:4', type: 'TEXT', name: 'Label', characters: 'New' }
          ]
        }
      ]
    })
    expect(icons.map((i) => i.name)).toEqual(['dot'])
  })

  it('skips hidden icons — they do not render', () => {
    const icons = collectIconNodes({
      id: '1:1',
      type: 'FRAME',
      name: 'Root',
      absoluteBoundingBox: { width: 400, height: 400 },
      children: [
        { id: '1:2', type: 'VECTOR', name: 'Hidden', visible: false, absoluteBoundingBox: { width: 16, height: 16 } },
        { id: '1:3', type: 'VECTOR', name: 'Shown', absoluteBoundingBox: { width: 16, height: 16 } }
      ]
    })
    expect(icons.map((i) => i.name)).toEqual(['Shown'])
  })

  it('never returns the frame it was asked about', () => {
    const icons = collectIconNodes({
      id: '1:1',
      type: 'VECTOR',
      name: 'Self',
      absoluteBoundingBox: { width: 24, height: 24 }
    })
    expect(icons).toHaveLength(0)
  })

  it('honours the cap so an icon-heavy frame cannot flood the prompt', () => {
    const children: FigmaNode[] = Array.from({ length: 20 }, (_, i) => ({
      id: `1:${i + 2}`,
      type: 'VECTOR',
      name: `icon-${i}`,
      absoluteBoundingBox: { width: 16, height: 16 }
    }))
    expect(collectIconNodes({ id: '1:1', type: 'FRAME', name: 'Root', children }, 5)).toHaveLength(5)
  })
})

describe('tool surface', () => {
  it('registers an executor for every advertised schema', () => {
    for (const schema of figmaToolSchemas) {
      expect(figmaRegistry[schema.name], `${schema.name} has no executor`).toBeTypeOf('function')
    }
  })

  it('advertises a schema for every registered executor', () => {
    const names = new Set(figmaToolSchemas.map((s) => s.name))
    for (const name of Object.keys(figmaRegistry)) {
      expect(names.has(name), `${name} is registered but has no schema`).toBe(true)
    }
  })

  it('requires file_key on every tool', () => {
    for (const schema of figmaToolSchemas) {
      expect(schema.parameters.required).toContain('file_key')
      expect(schema.parameters.properties.file_key).toBeDefined()
    }
  })

  it('declares every required parameter as a property', () => {
    for (const schema of figmaToolSchemas) {
      for (const req of schema.parameters.required) {
        expect(
          schema.parameters.properties[req],
          `${schema.name}.${req} is required but not declared`
        ).toBeDefined()
      }
    }
  })

  it('does not claim it can create or edit Figma designs', () => {
    // The REST API is read-only for file content; a schema that promised
    // authoring would make the agent attempt something impossible.
    for (const schema of figmaToolSchemas) {
      expect(schema.description).not.toMatch(/\bcreate a (?:new )?(?:figma )?(?:design|frame|layer)/i)
    }
  })
})
