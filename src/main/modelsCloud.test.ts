import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Cloud-tier routing tests. These predicates decide whether a turn leaves the
 * machine, so they're a privacy boundary worth testing directly. Everything runs
 * in-process: `./database` and the Anthropic SDK are mocked, so no settings file
 * is touched and no network call is made.
 */
// vi.mock factories are hoisted above every top-level declaration, so anything
// they reference must be created in a vi.hoisted() block (which runs first) —
// otherwise the class/fn is in its temporal dead zone when the factory runs.
const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  list: vi.fn(),
  // Captures what the fake SDK was constructed and called with.
  sdk: {
    lastApiKey: undefined as string | undefined,
    lastParams: undefined as Record<string, unknown> | undefined
  }
}))

vi.mock('./database', () => ({ database: { settings: { getSetting: mocks.getSetting } } }))
vi.mock('ollama', () => ({
  Ollama: class {
    list = mocks.list
  }
}))
// A minimal fake of the streaming SDK: on('text', cb) records the handler and
// finalMessage() fires two deltas then resolves, mirroring how the real stream
// emits text_delta events while finalMessage() is awaited.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(opts: { apiKey?: string }) {
      mocks.sdk.lastApiKey = opts.apiKey
    }
    messages = {
      stream: (params: Record<string, unknown>) => {
        mocks.sdk.lastParams = params
        let onText: ((d: string) => void) | undefined
        return {
          on: (evt: string, cb: (d: string) => void) => {
            if (evt === 'text') onText = cb
          },
          finalMessage: async () => {
            onText?.('Hello ')
            onText?.('world')
            return { content: [{ type: 'text', text: 'Hello world' }] }
          }
        }
      }
    }
  }
}))

// The predicates read env / getSetting lazily at call time, so a single static
// import sees each test's mock state. getAvailableModels tests use load() below.
import {
  getAnthropicKey,
  resolveCloudModel,
  isCloudRoutingEnabled,
  shouldRouteToCloud,
  streamAnthropic,
  DEFAULT_CLOUD_MODEL
} from './models'

/**
 * Fresh copy of models.ts — dodges the 30s pool cache inside getAvailableModels.
 * Only used for the pool tests; vi.resetModules() detaches the lazily-required
 * ./database mock, so the predicate tests use the static import above instead.
 */
async function load(): Promise<typeof import('./models')> {
  vi.resetModules()
  return import('./models')
}

/** Drive getSetting from a plain key→value map. */
function setSettings(map: Record<string, unknown>): void {
  mocks.getSetting.mockImplementation((key: string) => (key in map ? map[key] : null))
}

beforeEach(() => {
  mocks.getSetting.mockReset().mockReturnValue(null)
  mocks.list.mockReset().mockResolvedValue({ models: [] })
  mocks.sdk.lastApiKey = undefined
  mocks.sdk.lastParams = undefined
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_MODEL
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_MODEL
})

describe('getAnthropicKey', () => {
  it('is null when neither env nor settings has a key', () => {
    expect(getAnthropicKey()).toBeNull()
  })

  it('prefers the env var over the settings value', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    setSettings({ anthropic_api_key: 'sk-settings' })
    expect(getAnthropicKey()).toBe('sk-env')
  })

  it('falls back to the settings value, trimmed', () => {
    setSettings({ anthropic_api_key: '  sk-settings  ' })
    expect(getAnthropicKey()).toBe('sk-settings')
  })

  it('treats a blank settings value as no key', () => {
    setSettings({ anthropic_api_key: '   ' })
    expect(getAnthropicKey()).toBeNull()
  })
})

describe('resolveCloudModel', () => {
  it('defaults to the flagship when nothing overrides it', () => {
    expect(resolveCloudModel()).toBe(DEFAULT_CLOUD_MODEL)
    expect(DEFAULT_CLOUD_MODEL).toBe('claude-opus-4-8')
  })

  it('honours the env override above the setting', () => {
    process.env.ANTHROPIC_MODEL = 'claude-from-env'
    setSettings({ cloud_model: 'claude-from-settings' })
    expect(resolveCloudModel()).toBe('claude-from-env')
  })

  it('honours the setting when no env override', () => {
    setSettings({ cloud_model: 'claude-sonnet-5' })
    expect(resolveCloudModel()).toBe('claude-sonnet-5')
  })
})

describe('isCloudRoutingEnabled', () => {
  it('is off by default (privacy-first)', () => {
    expect(isCloudRoutingEnabled()).toBe(false)
  })

  it('is on only for a real boolean true, not a truthy string', () => {
    setSettings({ cloud_routing_enabled: true })
    expect(isCloudRoutingEnabled()).toBe(true)
    setSettings({ cloud_routing_enabled: 'true' })
    expect(isCloudRoutingEnabled()).toBe(false)
    setSettings({ cloud_routing_enabled: false })
    expect(isCloudRoutingEnabled()).toBe(false)
  })
})

describe('shouldRouteToCloud — the gate that lets a turn leave the machine', () => {
  it('stays local when routing is off, even with a key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    expect(shouldRouteToCloud()).toBe(false)
  })

  it('stays local when routing is on but no key is configured', () => {
    setSettings({ cloud_routing_enabled: true })
    expect(shouldRouteToCloud()).toBe(false)
  })

  it('routes to cloud only when BOTH the toggle is on and a key exists', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    setSettings({ cloud_routing_enabled: true })
    expect(shouldRouteToCloud()).toBe(true)
  })
})

describe('getAvailableModels — the pool must only advertise callable models', () => {
  it('omits the cloud model when no key is configured', async () => {
    const { getAvailableModels } = await load()
    const models = await getAvailableModels()
    expect(models.some((m) => m.provider === 'anthropic')).toBe(false)
  })

  it('advertises the resolved cloud model, prettified, when a key exists', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    const { getAvailableModels } = await load()
    const cloud = (await getAvailableModels()).find((m) => m.provider === 'anthropic')
    expect(cloud).toEqual({ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' })
  })

  it('tracks a model override so the UI tag never lies about what will run', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5'
    const { getAvailableModels } = await load()
    const cloud = (await getAvailableModels()).find((m) => m.provider === 'anthropic')
    expect(cloud).toEqual({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' })
  })
})

describe('streamAnthropic', () => {
  it('refuses to call the API without a key', async () => {
    await expect(streamAnthropic([{ role: 'user', content: 'hi' }], 'sys', () => {})).rejects.toThrow(
      /No Anthropic API key/
    )
  })

  it('forwards every delta and returns the full text', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env'
    const deltas: string[] = []
    const full = await streamAnthropic(
      [{ role: 'user', content: 'hi' }],
      'you are a bot',
      (d) => deltas.push(d),
      'claude-opus-4-8'
    )
    expect(deltas).toEqual(['Hello ', 'world'])
    expect(full).toBe('Hello world')
    // The system prompt and model are passed through to the SDK, not dropped.
    expect(mocks.sdk.lastParams).toMatchObject({ model: 'claude-opus-4-8', system: 'you are a bot' })
    expect(mocks.sdk.lastApiKey).toBe('sk-env')
  })
})
