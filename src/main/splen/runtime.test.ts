import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  readSplenInstall,
  setSplenDirForTests,
  writeSplenInstall,
  SPLEN_MANIFEST_FILE,
  SPLEN_WEIGHTS_FILE
} from './install'
import {
  fitContextSize,
  generateSplen,
  setSplenBackendFactoryForTests,
  SPLEN_MAX_CONTEXT,
  unloadSplen,
  SplenNotInstalledError,
  SPLEN_IDLE_UNLOAD_MS,
  type SplenBackend,
  type SplenGenerateRequest
} from './runtime'

const SHA = 'a'.repeat(64)
let dir: string

function install(bytes = 8): void {
  writeFileSync(join(dir, SPLEN_WEIGHTS_FILE), Buffer.alloc(bytes))
  writeSplenInstall({ version: '4b-test', sha256: SHA, bytes })
}

/** A fake engine that records what it was asked and replies on cue. */
function fakeBackend(reply = 'ok') {
  const calls: SplenGenerateRequest[] = []
  const state = { disposed: 0, active: 0, maxActive: 0 }
  const backend: SplenBackend = {
    async generate(req) {
      calls.push(req)
      state.active++
      state.maxActive = Math.max(state.maxActive, state.active)
      await new Promise((r) => setTimeout(r, 5))
      req.onText(reply)
      state.active--
      return reply
    },
    async dispose() {
      state.disposed++
    }
  }
  return { backend, calls, state }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splen-'))
  setSplenDirForTests(dir)
})

afterEach(async () => {
  await unloadSplen()
  vi.useRealTimers()
  setSplenDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('readSplenInstall', () => {
  it('is null until a verified download has written its manifest', () => {
    writeFileSync(join(dir, SPLEN_WEIGHTS_FILE), Buffer.alloc(8))
    expect(readSplenInstall()).toBeNull()
  })

  it('returns the record when the weights match it', () => {
    install(8)
    expect(readSplenInstall()).toEqual({ version: '4b-test', sha256: SHA, bytes: 8 })
  })

  it('is null when the weights file no longer matches the recorded size', () => {
    install(8)
    writeFileSync(join(dir, SPLEN_WEIGHTS_FILE), Buffer.alloc(7))
    expect(readSplenInstall()).toBeNull()
  })

  it('is null for a manifest that does not parse or is not a real record', () => {
    writeFileSync(join(dir, SPLEN_WEIGHTS_FILE), Buffer.alloc(8))
    writeFileSync(join(dir, SPLEN_MANIFEST_FILE), '{"version":')
    expect(readSplenInstall()).toBeNull()
    writeFileSync(join(dir, SPLEN_MANIFEST_FILE), JSON.stringify({ version: 'x', sha256: 'nothex', bytes: 8 }))
    expect(readSplenInstall()).toBeNull()
  })

  it('refuses to record an invalid install', () => {
    expect(() => writeSplenInstall({ version: '', sha256: SHA, bytes: 8 })).toThrow()
    expect(() => writeSplenInstall({ version: 'v', sha256: SHA, bytes: 0 })).toThrow()
  })
})

describe('fitContextSize', () => {
  it('keeps the requested window when the prompt and a reply fit', () => {
    expect(fitContextSize(6000, 8192)).toBe(8192)
  })

  it('grows an undercounted window to the next power of two with room to reply', () => {
    expect(fitContextSize(7000, 8192)).toBe(16384)
  })

  it('never grows past the ceiling, so an over-long prompt is refused, not silently cut', () => {
    expect(fitContextSize(40000, 8192)).toBe(SPLEN_MAX_CONTEXT)
  })
})

describe('generateSplen', () => {
  it('refuses before loading anything when Splen is not installed', async () => {
    const factory = vi.fn()
    setSplenBackendFactoryForTests(factory)
    await expect(
      generateSplen({ systemPrompt: 'S', turns: [{ role: 'user', content: 'hi' }], numCtx: 8192, onDelta: () => {} })
    ).rejects.toBeInstanceOf(SplenNotInstalledError)
    expect(factory).not.toHaveBeenCalled()
  })

  it('sends the rendered prompt at the caller’s window and streams the reply', async () => {
    install()
    const { backend, calls } = fakeBackend('hello')
    setSplenBackendFactoryForTests(async () => backend)
    const deltas: string[] = []
    const out = await generateSplen({
      systemPrompt: 'S',
      turns: [{ role: 'user', content: 'hi' }],
      numCtx: 16384,
      seed: 2,
      onDelta: (d) => deltas.push(d)
    })
    expect(out).toBe('hello')
    expect(deltas).toEqual(['hello'])
    expect(calls[0].prompt).toBe(
      '<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
    )
    expect(calls[0].contextSize).toBe(16384)
    expect(calls[0].seed).toBe(2)
  })

  it('never runs two generations at once', async () => {
    install()
    const { backend, state } = fakeBackend()
    setSplenBackendFactoryForTests(async () => backend)
    const req = { systemPrompt: 'S', turns: [{ role: 'user' as const, content: 'hi' }], numCtx: 8192, onDelta: () => {} }
    await Promise.all([generateSplen(req), generateSplen(req), generateSplen(req)])
    expect(state.maxActive).toBe(1)
  })

  it('loads the model once and reuses it across turns', async () => {
    install()
    const { backend } = fakeBackend()
    const factory = vi.fn(async () => backend)
    setSplenBackendFactoryForTests(factory)
    const req = { systemPrompt: 'S', turns: [{ role: 'user' as const, content: 'hi' }], numCtx: 8192, onDelta: () => {} }
    await generateSplen(req)
    await generateSplen(req)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed load — the next turn tries again', async () => {
    install()
    const { backend } = fakeBackend()
    const factory = vi
      .fn<() => Promise<SplenBackend>>()
      .mockRejectedValueOnce(new Error('no vulkan'))
      .mockResolvedValue(backend)
    setSplenBackendFactoryForTests(factory)
    const req = { systemPrompt: 'S', turns: [{ role: 'user' as const, content: 'hi' }], numCtx: 8192, onDelta: () => {} }
    await expect(generateSplen(req)).rejects.toThrow('no vulkan')
    await expect(generateSplen(req)).resolves.toBe('ok')
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('frees the model after the idle window and reloads on the next turn', async () => {
    install()
    const { backend, state } = fakeBackend()
    const factory = vi.fn(async () => backend)
    setSplenBackendFactoryForTests(factory)
    const req = { systemPrompt: 'S', turns: [{ role: 'user' as const, content: 'hi' }], numCtx: 8192, onDelta: () => {} }
    await generateSplen(req)

    vi.useFakeTimers()
    // Re-arm the idle timer under fake timers with a second turn.
    const second = generateSplen(req)
    await vi.advanceTimersByTimeAsync(10)
    await second
    await vi.advanceTimersByTimeAsync(SPLEN_IDLE_UNLOAD_MS - 1000)
    expect(state.disposed).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(state.disposed).toBe(1)
    vi.useRealTimers()

    await generateSplen(req)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
