import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * resolveOllamaModel exists because a hardcoded default ("qwen3.5:9b") that the
 * user never pulled took every chat turn down with `model not found`. These tests
 * pin the resolution order against model sets that do NOT contain the preference.
 *
 * The pool is cached for 30s inside models.ts, so each test re-imports the module
 * with a fresh mock rather than fighting the cache.
 */
/**
 * Nothing here touches the network — the Ollama SDK is mocked below — but each
 * case calls vi.resetModules() and re-imports models.ts to defeat its 30 s pool
 * cache, so every test pays a fresh module-graph transform. Under a full
 * parallel suite run that legitimately exceeds Vitest's 5 s default and the
 * tests failed as timeouts rather than on any assertion. The work is genuinely
 * slow, not hung, so give this file (and only this file) a wider budget.
 */
vi.setConfig({ testTimeout: 30_000 })

const list = vi.fn()
vi.mock('ollama', () => ({
  Ollama: class {
    list = list
  }
}))

/** Load a fresh copy of models.ts whose Ollama.list() returns `names`. */
async function withInstalled(names: string[]): Promise<typeof import('./models')> {
  vi.resetModules()
  list.mockResolvedValue({ models: names.map((name) => ({ name })) })
  return import('./models')
}

beforeEach(() => {
  list.mockReset()
  // The resolver warns whenever it substitutes; keep the test output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.OLLAMA_MODEL
})

describe('resolveOllamaModel', () => {
  it('keeps the preference when it is installed verbatim', async () => {
    const { resolveOllamaModel } = await withInstalled(['qwen3.5:latest', 'llama3:8b'])
    expect(await resolveOllamaModel('llama3:8b')).toBe('llama3:8b')
  })

  it('falls back to another tag in the same family — the qwen3.5:9b crash', async () => {
    const { resolveOllamaModel } = await withInstalled(['qwen3.5:latest'])
    expect(await resolveOllamaModel('qwen3.5:9b')).toBe('qwen3.5:latest')
  })

  it('prefers a code-tuned model when the preference is a coder tag', async () => {
    const { resolveOllamaModel } = await withInstalled(['qwen3.5:latest', 'deepseek-coder:6.7b'])
    expect(await resolveOllamaModel('qwen2.5-coder:7b')).toBe('deepseek-coder:6.7b')
  })

  it('falls back to the only installed model when nothing else matches', async () => {
    const { resolveOllamaModel } = await withInstalled(['qwen3.5:latest'])
    expect(await resolveOllamaModel('qwen2.5-coder:7b')).toBe('qwen3.5:latest')
  })

  it('returns the preference untouched when Ollama has no models', async () => {
    // Callers rely on this to keep their own "is Ollama running?" error path.
    const { resolveOllamaModel } = await withInstalled([])
    expect(await resolveOllamaModel('qwen3.5:9b')).toBe('qwen3.5:9b')
  })

  it('returns the preference untouched when Ollama is unreachable', async () => {
    vi.resetModules()
    list.mockRejectedValue(new Error('ECONNREFUSED'))
    const { resolveOllamaModel } = await import('./models')
    expect(await resolveOllamaModel('qwen3.5:9b')).toBe('qwen3.5:9b')
  })

  it('warns when it substitutes so the swap is not silent', async () => {
    const { resolveOllamaModel } = await withInstalled(['qwen3.5:latest'])
    await resolveOllamaModel('qwen3.5:9b')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('qwen3.5:9b'))
  })
})

describe('resolveGeneralModel', () => {
  it('treats OLLAMA_MODEL as a preference, not a guarantee', async () => {
    // A stale .env pointing at an uninstalled model must not break every turn.
    process.env.OLLAMA_MODEL = 'llama3:8b'
    const { resolveGeneralModel } = await withInstalled(['qwen3.5:latest'])
    expect(await resolveGeneralModel()).toBe('qwen3.5:latest')
  })

  it('honours OLLAMA_MODEL when that model is installed', async () => {
    process.env.OLLAMA_MODEL = 'llama3:8b'
    const { resolveGeneralModel } = await withInstalled(['qwen3.5:latest', 'llama3:8b'])
    expect(await resolveGeneralModel()).toBe('llama3:8b')
  })
})

describe('assignModels', () => {
  it('never fabricates a model id when the pool is empty', async () => {
    const { assignModels, DEFAULT_GENERAL_MODEL } = await withInstalled([])
    const assigned = assignModels([], 3)
    expect(assigned).toHaveLength(3)
    expect(assigned.every((m) => m.id === DEFAULT_GENERAL_MODEL)).toBe(true)
  })

  it('round-robins the real pool across subagents', async () => {
    const { assignModels } = await withInstalled([])
    const pool = [
      { id: 'a:1', label: 'A', provider: 'ollama' as const },
      { id: 'b:1', label: 'B', provider: 'ollama' as const }
    ]
    expect(assignModels(pool, 3).map((m) => m.id)).toEqual(['a:1', 'b:1', 'a:1'])
  })
})
