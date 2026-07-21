import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Electron and the sandbox are mocked at the boundary: these tests exercise the
// bridge protocol and the job lifecycle, not the desktop shell.
const { openExternalMock, showItemMock, writtenFiles } = vi.hoisted(() => ({
  openExternalMock: vi.fn(async () => undefined),
  showItemMock: vi.fn(),
  writtenFiles: new Map<string, string>()
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: openExternalMock,
    showItemInFolder: showItemMock,
    openPath: vi.fn(async () => '')
  },
  app: { getPath: () => process.cwd() }
}))

vi.mock('./sandbox', () => ({
  writeSandboxFile: async (relPath: string, content: string): Promise<string> => {
    writtenFiles.set(relPath, content)
    return relPath
  },
  getWorkspaceDir: (): string => '/workspace'
}))

import {
  BRIDGE_PORTS,
  build_figma_design,
  bridgePort,
  ensureBridge,
  figma_builder_status,
  getBridgeToken,
  isPluginConnected,
  setup_figma_builder,
  __resetBridgeForTest
} from './figmaBuild'

/** Stand-in for the Figma plugin's UI thread: poll, build, report. */
class FakePlugin {
  private stopped = false
  public built: { id: string; name: string; nodeCount: number }[] = []

  constructor(
    private port: number,
    private token: string,
    /** Lets a test simulate a plugin that fails mid-build. */
    private behaviour: 'ok' | 'fail' = 'ok'
  ) {}

  private base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * One poll cycle. Returns true if it picked up and reported a job.
   *
   * A transient fetch failure is swallowed the way the real plugin's own
   * .catch does — OpenUI may have restarted between polls, and a pooled socket
   * to a closed server surfaces as ECONNRESET rather than a clean refusal.
   */
  async tick(): Promise<boolean> {
    let res: Response
    try {
      res = await fetch(`${this.base()}/pending?token=${encodeURIComponent(this.token)}`)
    } catch {
      return false
    }
    if (!res.ok) return false
    const data = (await res.json()) as { job: { id: string; spec: { name: string; frames: unknown[] } } | null }
    if (!data.job) return false

    const countNodes = (nodes: unknown[]): number =>
      nodes.reduce<number>((sum, n) => {
        const node = n as { children?: unknown[] }
        return sum + 1 + countNodes(node.children ?? [])
      }, 0)

    const created = countNodes(data.job.spec.frames)
    this.built.push({ id: data.job.id, name: data.job.spec.name, nodeCount: created })

    const body =
      this.behaviour === 'ok'
        ? {
            type: 'result',
            jobId: data.job.id,
            ok: true,
            created,
            page: 'Page 1',
            rootIds: ['1:2'],
            rootNames: [data.job.spec.name]
          }
        : { type: 'result', jobId: data.job.id, ok: false, created: 3, error: 'font unavailable' }

    try {
      await fetch(`${this.base()}/result?token=${encodeURIComponent(this.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch {
      return false
    }
    return true
  }

  /** Poll continuously, like the real plugin window does while it is open. */
  start(intervalMs = 10): void {
    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        try {
          await this.tick()
        } catch {
          // Bridge went away — the real plugin retries too.
        }
        await new Promise((r) => setTimeout(r, intervalMs))
      }
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
  }
}

const SPEC = {
  name: 'Landing',
  frames: [
    {
      type: 'FRAME',
      name: 'Hero',
      width: 1440,
      height: 600,
      layout: { mode: 'VERTICAL', gap: 24 },
      children: [{ type: 'TEXT', text: 'Ship faster', font: { size: 48 } }]
    }
  ]
}

let plugin: FakePlugin | null = null

beforeEach(() => {
  openExternalMock.mockClear()
  showItemMock.mockClear()
  writtenFiles.clear()
  __resetBridgeForTest()
})

afterEach(() => {
  plugin?.stop()
  plugin = null
  __resetBridgeForTest()
})

describe('bridge server', () => {
  it('binds to a declared port on loopback only', async () => {
    const port = await ensureBridge()
    expect(BRIDGE_PORTS).toContain(port)
    expect(bridgePort()).toBe(port)
  })

  it('is idempotent — a second ensure reuses the same port', async () => {
    const first = await ensureBridge()
    const second = await ensureBridge()
    expect(second).toBe(first)
  })

  it('answers /health without a token so the plugin can discover the port', async () => {
    const port = await ensureBridge()
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, service: 'openui-figma-bridge' })
  })

  it('rejects a job poll with no token', async () => {
    const port = await ensureBridge()
    const res = await fetch(`http://127.0.0.1:${port}/pending`)
    expect(res.status).toBe(403)
  })

  it('rejects a job poll with the wrong token', async () => {
    const port = await ensureBridge()
    const res = await fetch(`http://127.0.0.1:${port}/pending?token=guessed`)
    expect(res.status).toBe(403)
  })

  it('reports no plugin connected before any poll', async () => {
    await ensureBridge()
    expect(isPluginConnected()).toBe(false)
  })

  it('reports the plugin connected once it polls', async () => {
    const port = await ensureBridge()
    await fetch(`http://127.0.0.1:${port}/pending?token=${encodeURIComponent(getBridgeToken())}`)
    expect(isPluginConnected()).toBe(true)
  })
})

describe('build_figma_design', () => {
  it('builds end to end and reports what the plugin actually created', async () => {
    const port = await ensureBridge()
    plugin = new FakePlugin(port, getBridgeToken())
    plugin.start()

    const r = await build_figma_design({ spec: SPEC, timeout_seconds: 10 })

    expect(r.ok).toBe(true)
    // The layer count comes from the plugin's report, not from the request —
    // that is the difference between "we asked" and "it happened".
    expect(r.output).toContain('2 layers')
    expect(r.output).toContain('page "Page 1"')
    expect(r.output).toContain('"Landing"')
    expect(plugin.built).toHaveLength(1)
    expect(plugin.built[0].name).toBe('Landing')
  })

  it('accepts a stringified spec, which is what models usually send', async () => {
    const port = await ensureBridge()
    plugin = new FakePlugin(port, getBridgeToken())
    plugin.start()

    const r = await build_figma_design({ spec: JSON.stringify(SPEC), timeout_seconds: 10 })
    expect(r.ok).toBe(true)
    expect(plugin.built).toHaveLength(1)
  })

  it('brings Figma to the front, preferring the desktop deep link', async () => {
    const port = await ensureBridge()
    plugin = new FakePlugin(port, getBridgeToken())
    plugin.start()

    await build_figma_design({ spec: SPEC, file_key: 'ABC123abc', timeout_seconds: 10 })
    expect(openExternalMock).toHaveBeenCalledWith('figma://file/ABC123abc')
  })

  it('surfaces a plugin-side failure with the layer count it got to', async () => {
    const port = await ensureBridge()
    plugin = new FakePlugin(port, getBridgeToken(), 'fail')
    plugin.start()

    const r = await build_figma_design({ spec: SPEC, timeout_seconds: 10 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('font unavailable')
    expect(r.error).toContain('3 layers')
  })

  // These two wait out the real 5s minimum build timeout, so they need more
  // than vitest's 5s default.
  it(
    'explains the plugin is not running when nothing ever polls',
    async () => {
      // No FakePlugin started. This is the single most likely failure in real
      // use, so the message has to say what to do rather than just time out.
      const r = await build_figma_design({ spec: SPEC, timeout_seconds: 5 })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/not running/)
      expect(r.error).toMatch(/setup_figma_builder/)
      expect(r.error).toMatch(/stays queued/)
    },
    15_000
  )

  it(
    'keeps a job queued so it runs when the plugin reconnects',
    async () => {
      const port = await ensureBridge()

      // Plugin shows up late, after the caller already gave up waiting — the
      // work must not have been discarded along with the wait.
      await build_figma_design({ spec: SPEC, timeout_seconds: 5 })
      plugin = new FakePlugin(port, getBridgeToken())
      const picked = await plugin.tick()

      expect(picked).toBe(true)
      expect(plugin.built[0].name).toBe('Landing')
    },
    15_000
  )

  it('rejects an invalid spec before starting anything', async () => {
    const r = await build_figma_design({ spec: { name: 'x', frames: [{ type: 'FRAME', fill: 'red' }] } })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid spec/)
    expect(r.error).toMatch(/hex colour/)
    // Nothing was opened — a bad spec must not yank the user into Figma.
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('requires a spec', async () => {
    const r = await build_figma_design({})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires "spec"/)
  })

  it('rejects a malformed file_key', async () => {
    const r = await build_figma_design({ spec: SPEC, file_key: '../../etc' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid file_key/)
  })

  it('rejects a spec string that is not JSON', async () => {
    const r = await build_figma_design({ spec: 'not json at all' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not valid JSON/)
  })
})

describe('setup_figma_builder', () => {
  it('writes all three plugin files', async () => {
    const r = await setup_figma_builder()
    expect(r.ok).toBe(true)
    expect([...writtenFiles.keys()].sort()).toEqual([
      'openui-figma-builder/code.js',
      'openui-figma-builder/manifest.json',
      'openui-figma-builder/ui.html'
    ])
  })

  it('declares every candidate port in the manifest', async () => {
    // Figma refuses a fetch to an origin not named in allowedDomains, and the
    // manifest cannot be rewritten after import — so all of them must be listed.
    await setup_figma_builder()
    const manifest = JSON.parse(writtenFiles.get('openui-figma-builder/manifest.json') ?? '{}')
    expect(manifest.networkAccess.allowedDomains).toEqual(
      BRIDGE_PORTS.map((p) => `http://127.0.0.1:${p}`)
    )
  })

  it('bakes the bridge token into the UI, not the manifest', async () => {
    await setup_figma_builder()
    const token = getBridgeToken()
    expect(writtenFiles.get('openui-figma-builder/ui.html')).toContain(token)
    expect(writtenFiles.get('openui-figma-builder/manifest.json')).not.toContain(token)
  })

  it('points the plugin at localhost only', async () => {
    await setup_figma_builder()
    const ui = writtenFiles.get('openui-figma-builder/ui.html') ?? ''
    expect(ui).toContain('127.0.0.1')
    expect(ui).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z]/i)
  })

  it('reveals the manifest so the import dialog has a target', async () => {
    await setup_figma_builder()
    expect(showItemMock).toHaveBeenCalledTimes(1)
    expect(String(showItemMock.mock.calls[0][0])).toContain('manifest.json')
  })

  it('gives the user the one-time import steps', async () => {
    const r = await setup_figma_builder()
    expect(r.output).toMatch(/Import plugin from manifest/)
    expect(r.output).toMatch(/DESKTOP/)
  })
})

describe('build ordering and queue safety', () => {
  it(
    'opens the file BEFORE queueing, so the build cannot land in the previous document',
    async () => {
      // The plugin builds into whatever document is active when it picks a job
      // up. Queueing first races the file switch.
      const port = await ensureBridge()
      let openedAt = 0
      let firstPollSawJobAt = 0
      let done = false

      openExternalMock.mockImplementation(async () => {
        if (!openedAt) openedAt = Date.now()
        return undefined
      })

      plugin = new FakePlugin(port, getBridgeToken())
      // Poll until the job appears or the build settles — a fixed iteration
      // budget makes this flaky when the suite is under load.
      const poller = async (): Promise<void> => {
        while (!done && !firstPollSawJobAt) {
          if (await plugin!.tick()) {
            firstPollSawJobAt = Date.now()
            return
          }
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      const polling = poller()

      await build_figma_design({ spec: SPEC, file_key: 'ABC123abc', timeout_seconds: 20 })
      done = true
      await polling

      expect(openedAt).toBeGreaterThan(0)
      expect(firstPollSawJobAt).toBeGreaterThan(openedAt)
      // And not merely one tick later — there is a real settle window.
      expect(firstPollSawJobAt - openedAt).toBeGreaterThan(1_000)
    },
    30_000
  )

  it('passes the file key to the plugin so it can refuse a mismatched document', async () => {
    const port = await ensureBridge()
    let seenJob: { fileKey?: string } | null = null
    let done = false

    const spy = async (): Promise<void> => {
      while (!done && !seenJob) {
        try {
          const res = await fetch(
            `http://127.0.0.1:${port}/pending?token=${encodeURIComponent(getBridgeToken())}`
          )
          const data = (await res.json()) as { job: { fileKey?: string } | null }
          if (data.job) {
            seenJob = data.job
            return
          }
        } catch {
          // Bridge restarting between tests — keep polling, like the plugin does.
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    const spying = spy()
    await build_figma_design({ spec: SPEC, file_key: 'ABC123abc', timeout_seconds: 6 })
    done = true
    await spying

    expect(seenJob).not.toBeNull()
    expect(seenJob!.fileKey).toBe('ABC123abc')
  }, 30_000)

  it('omits the file key when building into whatever file is already open', async () => {
    const port = await ensureBridge()
    plugin = new FakePlugin(port, getBridgeToken())
    plugin.start()

    await build_figma_design({ spec: SPEC, timeout_seconds: 10 })
    // No file_key means no constraint — the plugin must not refuse the job.
    expect(plugin.built).toHaveLength(1)
  })

  it(
    'caps the queue so abandoned builds do not all dump in at once',
    async () => {
      // Plugin closed: every call times out and leaves its job queued. Without
      // a cap, reconnecting would replay all of them into the document.
      await ensureBridge()
      const attempts = Array.from({ length: 14 }, (_, i) =>
        build_figma_design({ spec: { ...SPEC, name: `Build ${i}` }, timeout_seconds: 5 })
      )
      await Promise.all(attempts)

      const status = await figma_builder_status()
      expect(status.output).toMatch(/Queued builds: 10/)
    },
    30_000
  )
})

describe('generated plugin source', () => {
  // The plugin runs inside Figma and can never execute here, so a syntax error
  // would otherwise only surface as "Import plugin" failing on the user's
  // machine. Parsing it is the one automated guard available.
  it('emits code.js as syntactically valid JavaScript', async () => {
    await setup_figma_builder()
    const code = writtenFiles.get('openui-figma-builder/code.js') ?? ''
    expect(code.length).toBeGreaterThan(100)
    expect(() => new Function(code)).not.toThrow()
  })

  it('emits a ui.html script block that parses', async () => {
    await setup_figma_builder()
    const html = writtenFiles.get('openui-figma-builder/ui.html') ?? ''
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(script.length).toBeGreaterThan(100)
    expect(() => new Function(script)).not.toThrow()
  })

  it('emits a manifest Figma will accept', async () => {
    await setup_figma_builder()
    const manifest = JSON.parse(writtenFiles.get('openui-figma-builder/manifest.json') ?? '{}')
    expect(manifest.api).toBe('1.0.0')
    expect(manifest.main).toBe('code.js')
    expect(manifest.ui).toBe('ui.html')
    expect(manifest.editorType).toContain('figma')
  })

  it('loads fonts before writing characters — Figma throws otherwise', async () => {
    await setup_figma_builder()
    const code = writtenFiles.get('openui-figma-builder/code.js') ?? ''
    expect(code).toContain('loadFontAsync')
    expect(code.indexOf('loadFontAsync')).toBeLessThan(code.indexOf('.characters ='))
  })

  it('keeps network calls out of the scene-graph thread', async () => {
    // code.js has no fetch in Figma's main thread — a plugin written that way
    // silently fails at runtime. All networking belongs to ui.html.
    await setup_figma_builder()
    expect(writtenFiles.get('openui-figma-builder/code.js')).not.toContain('fetch(')
    expect(writtenFiles.get('openui-figma-builder/ui.html')).toContain('fetch(')
  })
})

describe('figma_builder_status', () => {
  it('says the plugin has never connected before any poll', async () => {
    await ensureBridge()
    const r = await figma_builder_status()
    expect(r.output).toMatch(/never connected/)
  })

  it('reports a completed build in the history', async () => {
    const port = await ensureBridge()
    plugin = new FakePlugin(port, getBridgeToken())
    plugin.start()
    await build_figma_design({ spec: SPEC, timeout_seconds: 10 })

    const r = await figma_builder_status()
    expect(r.output).toMatch(/connected/)
    expect(r.output).toMatch(/\[done\] "Landing"/)
    expect(r.output).toMatch(/2 layers/)
  })
})
