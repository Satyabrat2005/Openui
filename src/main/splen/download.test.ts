import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const callEdgeFunction = vi.fn()
vi.mock('../edgeFunctions', () => ({
  callEdgeFunction: (...a: unknown[]) => callEdgeFunction(...a),
  EdgeFunctionError: class EdgeFunctionError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
    }
  }
}))

import { readSplenInstall, setSplenDirForTests, SPLEN_WEIGHTS_FILE, writeSplenInstall } from './install'
import {
  clearSplenOfferCacheForTests,
  downloadSplen,
  getSplenOffer,
  requestSplenGrant,
  SPLEN_DOWNLOAD_ID,
  type SplenGrant
} from './download'
import { EdgeFunctionError } from '../edgeFunctions'

const WEIGHTS = Buffer.from('GGUF' + 'x'.repeat(1000))
const SHA = createHash('sha256').update(WEIGHTS).digest('hex')
const GRANT: SplenGrant = { url: 'https://r2.example/splen.gguf?sig=1', version: '4b-run4', sha256: SHA, bytes: WEIGHTS.length }

let dir: string

function bodyOf(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(buf))
      c.close()
    }
  })
}

/** Storage that honours Range, optionally cutting the first response short. */
function storage(opts: { cutAt?: number; ignoreRange?: boolean; payload?: Buffer } = {}) {
  const payload = opts.payload ?? WEIGHTS
  const requests: { range?: string }[] = []
  let cut = opts.cutAt
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range
    requests.push({ range })
    const start = !opts.ignoreRange && range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    let slice = payload.subarray(start)
    if (cut !== undefined) {
      slice = slice.subarray(0, cut)
      cut = undefined
    }
    return new Response(bodyOf(slice), { status: start > 0 ? 206 : 200 })
  })
  return { fetch: f as unknown as typeof fetch, requests }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splen-dl-'))
  setSplenDirForTests(dir)
  callEdgeFunction.mockReset()
})

afterEach(() => {
  setSplenDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('downloadSplen', () => {
  it('downloads, verifies and records the install', async () => {
    const s = storage()
    const res = await downloadSplen(null, { requestGrant: async () => GRANT, fetch: s.fetch })
    expect(res).toEqual({ ok: true, model: SPLEN_DOWNLOAD_ID })
    expect(readFileSync(join(dir, SPLEN_WEIGHTS_FILE)).equals(WEIGHTS)).toBe(true)
    expect(readSplenInstall()).toEqual({ version: '4b-run4', sha256: SHA, bytes: WEIGHTS.length })
    expect(existsSync(join(dir, `${SPLEN_WEIGHTS_FILE}.part`))).toBe(false)
  })

  it('resumes a cut-off download with a Range request and a fresh signed URL', async () => {
    const s = storage({ cutAt: 300 })
    const requestGrant = vi.fn(async () => GRANT)
    const res = await downloadSplen(null, { requestGrant, fetch: s.fetch })
    expect(res.ok).toBe(true)
    expect(s.requests).toEqual([{ range: undefined }, { range: 'bytes=300-' }])
    expect(requestGrant).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(dir, SPLEN_WEIGHTS_FILE)).equals(WEIGHTS)).toBe(true)
  })

  it('starts over when storage ignores Range instead of appending a second copy', async () => {
    writeFileSync(join(dir, `${SPLEN_WEIGHTS_FILE}.part`), WEIGHTS.subarray(0, 300))
    const s = storage({ ignoreRange: true })
    const res = await downloadSplen(null, { requestGrant: async () => GRANT, fetch: s.fetch })
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, SPLEN_WEIGHTS_FILE)).equals(WEIGHTS)).toBe(true)
  })

  it('discards a complete file whose sha256 does not match, and installs nothing', async () => {
    const tampered = Buffer.from(WEIGHTS)
    tampered[10] = 0x41
    const s = storage({ payload: tampered })
    const res = await downloadSplen(null, { requestGrant: async () => GRANT, fetch: s.fetch })
    expect(res).toMatchObject({ ok: false, code: 'failed' })
    expect(readSplenInstall()).toBeNull()
    expect(existsSync(join(dir, SPLEN_WEIGHTS_FILE))).toBe(false)
    expect(existsSync(join(dir, `${SPLEN_WEIGHTS_FILE}.part`))).toBe(false)
  })

  it('gives up after repeated drops but keeps what arrived', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    writeFileSync(join(dir, `${SPLEN_WEIGHTS_FILE}.part`), WEIGHTS.subarray(0, 100))
    const res = await downloadSplen(null, { requestGrant: async () => GRANT, fetch: f })
    expect(res).toMatchObject({ ok: false, code: 'network' })
    expect(readFileSync(join(dir, `${SPLEN_WEIGHTS_FILE}.part`)).length).toBe(100)
  })

  it('does not download again when this exact file is already installed', async () => {
    writeFileSync(join(dir, SPLEN_WEIGHTS_FILE), WEIGHTS)
    writeSplenInstall({ version: '4b-run4', sha256: SHA, bytes: WEIGHTS.length })
    const s = storage()
    const res = await downloadSplen(null, { requestGrant: async () => GRANT, fetch: s.fetch })
    expect(res.ok).toBe(true)
    expect(s.requests).toHaveLength(0)
  })

  it('replaces an older Splen with a newer one', async () => {
    writeFileSync(join(dir, SPLEN_WEIGHTS_FILE), Buffer.from('old weights'))
    writeSplenInstall({ version: '4b-ckpt40', sha256: 'b'.repeat(64), bytes: 11 })
    const s = storage()
    const res = await downloadSplen(null, { requestGrant: async () => GRANT, fetch: s.fetch })
    expect(res.ok).toBe(true)
    expect(readSplenInstall()?.version).toBe('4b-run4')
  })

  it('refuses early when the disk cannot hold the file', async () => {
    const huge = { ...GRANT, bytes: Number.MAX_SAFE_INTEGER }
    const s = storage()
    const res = await downloadSplen(null, { requestGrant: async () => huge, fetch: s.fetch })
    expect(res).toMatchObject({ ok: false, code: 'disk_space' })
    expect(s.requests).toHaveLength(0)
  })

  it('shares one download between concurrent callers', async () => {
    const s = storage()
    const deps = { requestGrant: async () => GRANT, fetch: s.fetch }
    const [a, b] = await Promise.all([downloadSplen(null, deps), downloadSplen(null, deps)])
    expect(a).toEqual(b)
    expect(s.requests).toHaveLength(1)
  })
})

describe('requestSplenGrant', () => {
  it('returns a well-formed grant', async () => {
    callEdgeFunction.mockResolvedValue(new Response(JSON.stringify(GRANT), { status: 200 }))
    await expect(requestSplenGrant()).resolves.toEqual(GRANT)
    expect(callEdgeFunction).toHaveBeenCalledWith('splen-download', {})
  })

  it('maps a signed-out caller to unauthenticated', async () => {
    callEdgeFunction.mockRejectedValue(new EdgeFunctionError('no session', 401, 'session_expired'))
    await expect(requestSplenGrant()).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
    callEdgeFunction.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(requestSplenGrant()).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
  })

  it('maps no network to network', async () => {
    callEdgeFunction.mockRejectedValue(new EdgeFunctionError('offline', 0, 'network_error'))
    await expect(requestSplenGrant()).rejects.toMatchObject({ failure: { code: 'network' } })
  })

  it('rejects a grant that is not https or has no real hash', async () => {
    callEdgeFunction.mockResolvedValue(new Response(JSON.stringify({ ...GRANT, url: 'http://x/y' }), { status: 200 }))
    await expect(requestSplenGrant()).rejects.toMatchObject({ failure: { code: 'model_not_found' } })
    callEdgeFunction.mockResolvedValue(new Response(JSON.stringify({ ...GRANT, sha256: 'abc' }), { status: 200 }))
    await expect(requestSplenGrant()).rejects.toMatchObject({ failure: { code: 'model_not_found' } })
  })

  it('reports the daily cap plainly', async () => {
    callEdgeFunction.mockResolvedValue(new Response('{"error":"rate_limited"}', { status: 429 }))
    await expect(requestSplenGrant()).rejects.toMatchObject({ failure: { code: 'failed' } })
  })

  it('tells a signed-in account Splen is not offered to it yet — not to sign in', async () => {
    callEdgeFunction.mockResolvedValue(new Response('{"error":"not_offered"}', { status: 403 }))
    await expect(requestSplenGrant()).rejects.toMatchObject({
      failure: { code: 'model_not_found', message: expect.stringContaining('isn’t available for your account') }
    })
  })
})

describe('getSplenOffer', () => {
  beforeEach(() => clearSplenOfferCacheForTests())

  it('returns the offer when the server says Splen is available', async () => {
    callEdgeFunction.mockResolvedValue(
      new Response(JSON.stringify({ available: true, version: '4b-run4', bytes: 2_790_000_288 }), { status: 200 })
    )
    await expect(getSplenOffer()).resolves.toEqual({ version: '4b-run4', bytes: 2_790_000_288 })
    expect(callEdgeFunction).toHaveBeenCalledWith('splen-download', { action: 'status' })
  })

  it('is null when not offered, signed out, offline or not deployed', async () => {
    callEdgeFunction.mockResolvedValue(new Response('{"available":false}', { status: 200 }))
    await expect(getSplenOffer()).resolves.toBeNull()
    clearSplenOfferCacheForTests()
    callEdgeFunction.mockRejectedValue(new EdgeFunctionError('no session', 0, 'not_configured'))
    await expect(getSplenOffer()).resolves.toBeNull()
    clearSplenOfferCacheForTests()
    callEdgeFunction.mockResolvedValue(new Response('not found', { status: 404 }))
    await expect(getSplenOffer()).resolves.toBeNull()
  })

  it('asks the server at most once per cache window', async () => {
    callEdgeFunction.mockResolvedValue(new Response('{"available":false}', { status: 200 }))
    await getSplenOffer()
    await getSplenOffer()
    expect(callEdgeFunction).toHaveBeenCalledTimes(1)
  })
})
