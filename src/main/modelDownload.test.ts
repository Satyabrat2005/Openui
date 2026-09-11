import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The in-app download is the ONLY path a user is offered to get a model, so
// every branch it can land on needs its own covered outcome — "download failed"
// is not an answer someone can act on, and a message that sends them to a
// terminal would undo the whole feature.
//
// The download itself is an HTTP call to the Ollama daemon (/api/pull), not a
// shelled-out binary, so `fetch` is the boundary that gets mocked here rather
// than child_process. That is also why there is no console window to hide on
// Windows — there is no child process at all on this path.

const H = vi.hoisted(() => ({
  session: { authed: true },
  installed: [] as { id: string; provider: string; label: string }[]
}))

vi.mock('./auth/sessionManager', () => ({
  hasAccountSession: () => H.session.authed
}))
vi.mock('./models', async () => {
  const actual = await vi.importActual<typeof import('./models')>('./models')
  return {
    ...actual,
    getAvailableModels: async () => H.installed,
    invalidateModelPoolCache: () => {}
  }
})
vi.mock('electron', () => ({ BrowserWindow: class {} }))

import {
  approxSizeLabel,
  classifyPullFailure,
  downloadModel,
  engineUnavailable,
  isCatalogModel,
  listModelStatus,
  MODEL_CATALOG,
  MODEL_LAYER_BYTES,
  OLLAMA_INSTALL_URL
} from './modelDownload'
import { clearInFlightPullsForTests } from './ollamaPull'

const GENERAL = MODEL_CATALOG[0].id

/** A ReadableStream of NDJSON lines, matching what /api/pull streams back. */
function ndjsonBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l + '\n'))
      controller.close()
    }
  })
}

/**
 * Route fetch by URL: /api/tags answers the reachability probe, /api/pull the
 * download. `tags: false` is how "the engine isn't installed/running" is
 * simulated.
 */
function mockFetch(opts: { tags?: boolean; pull?: () => Response | Promise<Response> }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/api/tags')) {
        if (opts.tags === false) throw new Error('ECONNREFUSED')
        return new Response('{}', { status: 200 })
      }
      if (u.includes('/api/pull')) {
        if (!opts.pull) throw new Error('unexpected pull')
        return await opts.pull()
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
  )
}

beforeEach(() => {
  H.session.authed = true
  H.installed = []
  clearInFlightPullsForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyPullFailure — one code per real failure', () => {
  it('a full disk is reported as a disk-space problem', () => {
    const out = classifyPullFailure(new Error('write /blobs: no space left on device'))
    expect(out.code).toBe('disk_space')
    expect(out.message).toMatch(/disk space/i)
  })

  it('a dropped connection is reported as a network problem, and says it resumes', () => {
    const out = classifyPullFailure(new Error('read ECONNRESET'))
    expect(out.code).toBe('network')
    expect(out.message).toMatch(/connection/i)
    // A multi-gigabyte download that looks like it restarts from zero is why
    // people gave up and went to a terminal.
    expect(out.message).toMatch(/resumes|kept/i)
  })

  it('a truncated stream is a network problem, not a generic failure', () => {
    const out = classifyPullFailure(new Error('The download of "x" ended before completing.'))
    expect(out.code).toBe('network')
  })

  it('a missing model in the registry gets its own code', () => {
    expect(classifyPullFailure(new Error('pull model manifest: file does not exist')).code).toBe(
      'model_not_found'
    )
  })

  it('an unrecognised failure keeps its original text instead of being flattened', () => {
    const out = classifyPullFailure(new Error('something nobody predicted'))
    expect(out.code).toBe('failed')
    expect(out.message).toContain('something nobody predicted')
  })

  it('NO failure message ever mentions a terminal or a shell command', () => {
    const causes = [
      'no space left on device',
      'read ECONNRESET',
      'pull model manifest: file does not exist',
      'something nobody predicted'
    ]
    for (const c of causes) {
      const m = classifyPullFailure(new Error(c)).message
      expect(m).not.toMatch(/terminal|console|command line|ollama pull|ollama run|ollama serve/i)
    }
    expect(engineUnavailable().message).not.toMatch(
      /terminal|console|command line|ollama pull|ollama run|ollama serve/i
    )
  })
})

describe('downloadModel — the gate and the failure paths', () => {
  it('refuses without a session', async () => {
    H.session.authed = false
    const out = await downloadModel(null, GENERAL)
    expect(out).toMatchObject({ ok: false, code: 'unauthenticated' })
  })

  it('refuses a model that is not in the catalog', async () => {
    // An arbitrary string arriving over IPC must never reach the pull endpoint.
    const out = await downloadModel(null, 'evil/model:latest')
    expect(out).toMatchObject({ ok: false, code: 'unknown_model' })
    expect(isCatalogModel('evil/model:latest')).toBe(false)
  })

  it('refuses a non-string model id', async () => {
    expect(await downloadModel(null, { id: GENERAL })).toMatchObject({
      ok: false,
      code: 'unknown_model'
    })
  })

  it('reports the engine as unavailable — with an installer link, not a command', async () => {
    mockFetch({ tags: false })
    const out = await downloadModel(null, GENERAL)
    expect(out).toMatchObject({ ok: false, code: 'engine_unavailable', installUrl: OLLAMA_INSTALL_URL })
    // Explicitly NOT an automated install of Ollama — that is separate scope.
    expect(out.ok === false && out.message).toMatch(/install/i)
  })

  it('surfaces a second press as "already in progress" rather than silently joining', async () => {
    // pullModel deliberately JOINS concurrent callers onto one download. A user
    // pressing Download twice must instead be told it is already running — and
    // the join must not be what they silently get, because the UI cannot tell a
    // joined download from a fresh one.
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    // Resolves the moment the pull request is actually issued, which is exactly
    // when pullModel registers the download as in-flight.
    const pullStarted = new Promise<void>((r) => (entered = r))

    mockFetch({
      tags: true,
      pull: async () => {
        entered()
        await gate
        return new Response(ndjsonBody(['{"status":"success"}']), { status: 200 })
      }
    })

    const first = downloadModel(null, GENERAL)
    await pullStarted

    const second = await downloadModel(null, GENERAL)
    expect(second).toMatchObject({ ok: false, code: 'already_in_progress' })
    expect(second.ok === false && second.message).not.toMatch(/terminal|ollama pull/i)

    release()
    await expect(first).resolves.toMatchObject({ ok: true, model: GENERAL })
  })

  it('a mid-stream error from Ollama is classified, not passed through raw', async () => {
    mockFetch({
      tags: true,
      pull: async () =>
        new Response(
          ndjsonBody(['{"status":"pulling"}', '{"error":"no space left on device"}']),
          { status: 200 }
        )
    })
    const out = await downloadModel(null, GENERAL)
    expect(out).toMatchObject({ ok: false, code: 'disk_space' })
  })

  it('a stream that ends without success is a network failure, not a silent pass', async () => {
    mockFetch({
      tags: true,
      pull: async () => new Response(ndjsonBody(['{"status":"pulling"}']), { status: 200 })
    })
    const out = await downloadModel(null, GENERAL)
    expect(out).toMatchObject({ ok: false, code: 'network' })
  })

  it('a non-OK response from the pull endpoint fails with an actionable message', async () => {
    mockFetch({ tags: true, pull: async () => new Response('nope', { status: 500 }) })
    const out = await downloadModel(null, GENERAL)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.message).not.toMatch(/terminal|ollama pull/i)
  })

  it('a completed download resolves ok and emits progress to the renderer', async () => {
    const sent: { channel: string; payload: { percent: number | null; done: boolean } }[] = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: never) => sent.push({ channel, payload }) }
    } as never

    mockFetch({
      tags: true,
      pull: async () =>
        new Response(
          ndjsonBody([
            '{"status":"pulling manifest"}',
            '{"status":"pulling sha256:abc","digest":"sha256:abcdef012345","total":100,"completed":50}',
            '{"status":"success"}'
          ]),
          { status: 200 }
        )
    })

    await expect(downloadModel(win, GENERAL)).resolves.toMatchObject({ ok: true })

    const pulls = sent.filter((s) => s.channel === 'openui:model:pull')
    // Real byte-derived progress reached the renderer, not just start/finish.
    expect(pulls.some((p) => p.payload.percent === 50)).toBe(true)
    expect(pulls.at(-1)?.payload.done).toBe(true)
  })
})

describe('listModelStatus', () => {
  it('reports installed state per model from the real pool', async () => {
    H.installed = [{ id: GENERAL, provider: 'ollama', label: 'General' }]
    const list = await listModelStatus()
    expect(list).toHaveLength(MODEL_CATALOG.length)
    expect(list.find((m) => m.id === GENERAL)?.installed).toBe(true)
    expect(list.filter((m) => m.id !== GENERAL).every((m) => !m.installed)).toBe(true)
  })

  it('reports nothing installed when the engine is unreachable, rather than throwing', async () => {
    H.installed = []
    const list = await listModelStatus()
    expect(list.every((m) => !m.installed)).toBe(true)
  })

  it('every catalog entry carries a purpose and a size, so the UI never invents one', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.purpose.length).toBeGreaterThan(0)
      expect(m.approxSize).toMatch(/about/i)
    }
  })

  // The size shown before a download is the only figure a user can consent to:
  // once the pull starts, ollamaPull streams real byte counts. `about 2 GB`
  // shipped beside a 6.59 GB model because the string was written by hand next
  // to nothing that could contradict it. Deriving it from the manifest byte
  // count is what makes that drift impossible, so both halves are asserted.
  it('states a download size derived from the real manifest byte count', () => {
    for (const m of MODEL_CATALOG) {
      const bytes = MODEL_LAYER_BYTES[m.id]
      expect(bytes, `no manifest size recorded for ${m.id}`).toBeGreaterThan(0)
      expect(m.approxSize).toBe(approxSizeLabel(bytes))
    }
  })

  it('does not understate a multi-gigabyte download', () => {
    // Rounding to one decimal may shave at most 0.05 GB; anything beyond that
    // is a wrong number, not a rounded one.
    for (const m of MODEL_CATALOG) {
      const stated = Number(/([\d.]+)/.exec(m.approxSize)?.[1])
      const real = MODEL_LAYER_BYTES[m.id] / 1e9
      expect(real - stated).toBeLessThanOrEqual(0.05)
    }
  })
})
