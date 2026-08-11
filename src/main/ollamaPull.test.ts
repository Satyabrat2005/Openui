/**
 * ollamaPull.test.ts — the first-run model download.
 *
 * The download itself is a network stream, so the parts worth testing are the
 * ones that decide what the user SEES: the percentage math (a wrong 0% reads as a
 * frozen bar, which is precisely the "app looks hung" complaint this feature
 * exists to fix), the NDJSON framing (Ollama's stream splits mid-line), and the
 * de-duplication that stops three callers starting three copies of the same
 * multi-gigabyte download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./models', () => ({ invalidateModelPoolCache: vi.fn() }))

import {
  toPullProgress,
  splitNdjson,
  formatBytes,
  pullModel,
  clearInFlightPullsForTests
} from './ollamaPull'

describe('toPullProgress', () => {
  it('computes a percentage from the layer byte counts', () => {
    const p = toPullProgress('qwen2.5-coder:7b', {
      status: 'pulling 8eeb52dfb3bb',
      digest: 'sha256:8eeb52dfb3bb1234567890abcdef',
      total: 1000,
      completed: 250
    })
    expect(p.percent).toBe(25)
    expect(p.completed).toBe(250)
    expect(p.total).toBe(1000)
    expect(p.layer).toBe('8eeb52dfb3bb')
    expect(p.done).toBe(false)
  })

  // The bug this guards: "pulling manifest" and the verify phase carry NO byte
  // counts. Dividing by a missing total yields NaN or a bogus 0%, and a 0%-width
  // bar is exactly what users read as a hang. null means "show the status text".
  it('reports null (not 0) for phases with no byte counts', () => {
    expect(toPullProgress('m', { status: 'pulling manifest' }).percent).toBeNull()
    expect(toPullProgress('m', { status: 'verifying sha256 digest' }).percent).toBeNull()
    expect(toPullProgress('m', { status: 'pulling x', total: 0, completed: 0 }).percent).toBeNull()
  })

  it('never reports more than 100%', () => {
    // Observed from Ollama when a layer is resumed: completed can exceed total.
    expect(toPullProgress('m', { status: 's', total: 100, completed: 140 }).percent).toBe(100)
  })

  it('marks success as done', () => {
    expect(toPullProgress('m', { status: 'success' }).done).toBe(true)
  })

  it('passes an error through', () => {
    expect(toPullProgress('m', { status: '', error: 'no such model' }).error).toBe('no such model')
  })
})

describe('splitNdjson', () => {
  it('parses whole lines and carries the partial one forward', () => {
    const { lines, rest } = splitNdjson('{"status":"a"}\n{"status":"b"}\n{"stat')
    expect(lines.map((l) => l.status)).toEqual(['a', 'b'])
    expect(rest).toBe('{"stat')
  })

  it('reassembles a record split across two chunks', () => {
    const first = splitNdjson('{"status":"pulling","tot')
    expect(first.lines).toEqual([])
    const second = splitNdjson(first.rest + 'al":10,"completed":5}\n')
    expect(second.lines[0]).toEqual({ status: 'pulling', total: 10, completed: 5 })
    expect(second.rest).toBe('')
  })

  it('skips a malformed line rather than aborting the download', () => {
    const { lines } = splitNdjson('{"status":"a"}\nNOT JSON\n{"status":"b"}\n')
    expect(lines.map((l) => l.status)).toEqual(['a', 'b'])
  })
})

describe('formatBytes', () => {
  it('formats readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(4_700_000_000)).toBe('4.4 GB')
    expect(formatBytes(null)).toBe('')
  })
})

/** A fake /api/pull response body streaming the given chunks. */
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined }
      })
    }
  } as unknown as Response
}

describe('pullModel', () => {
  const sends: Array<{ channel: string; payload: unknown }> = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sends.push({ channel, payload }) }
  } as never

  beforeEach(() => {
    sends.length = 0
    clearInFlightPullsForTests()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('streams progress to the renderer and resolves on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamOf([
          '{"status":"pulling manifest"}\n',
          '{"status":"pulling abc","digest":"sha256:abc123456789ff","total":100,"completed":50}\n',
          '{"status":"success"}\n'
        ])
      )
    )

    await pullModel(win, 'qwen2.5-coder:7b')

    const payloads = sends.filter((s) => s.channel === 'openui:model:pull').map((s) => s.payload)
    expect(payloads.length).toBeGreaterThanOrEqual(4)
    const percents = payloads.map((p) => (p as { percent: number | null }).percent)
    expect(percents).toContain(50)
    expect((payloads[payloads.length - 1] as { done: boolean }).done).toBe(true)
  })

  it('rejects with an actionable message when Ollama refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, body: null }) as unknown as Response)
    )
    await expect(pullModel(win, 'nope:1b')).rejects.toThrow(/ollama pull nope:1b/)
  })

  // A stream that stops early must not be reported as a usable model — that would
  // send the turn straight back into the 404 this feature exists to prevent.
  it('rejects when the stream ends without success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamOf(['{"status":"pulling abc","total":100,"completed":10}\n']))
    )
    await expect(pullModel(win, 'half:7b')).rejects.toThrow(/ended before completing/)
  })

  it('surfaces an error reported inside the stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamOf(['{"error":"file does not exist"}\n'])))
    await expect(pullModel(win, 'bad:7b')).rejects.toThrow(/file does not exist/)
  })

  // Three turns can discover the same missing model at once (chat, planner,
  // refiner). Without sharing, that is three copies of a multi-gigabyte blob.
  it('de-duplicates concurrent pulls of the same model', async () => {
    const fetchMock = vi.fn(async () => streamOf(['{"status":"success"}\n']))
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([
      pullModel(win, 'same:7b'),
      pullModel(win, 'same:7b'),
      pullModel(win, 'same:7b')
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh attempt after a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({ ok: false, status: 500, body: null }) as unknown as Response)
      .mockImplementationOnce(async () => streamOf(['{"status":"success"}\n']))
    vi.stubGlobal('fetch', fetchMock)

    await expect(pullModel(win, 'retry:7b')).rejects.toThrow()
    await expect(pullModel(win, 'retry:7b')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
