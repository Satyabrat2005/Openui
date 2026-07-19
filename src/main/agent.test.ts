/**
 * agent.test.ts — the interactive agent loop (handleChat).
 *
 * The pure tool-call parser and StreamGate are unit-tested in
 * toolCallParser.test.ts. These tests exercise how agent.ts WIRES those pieces
 * together across a real turn, driving handleChat with a scripted model:
 *
 *   • a tool call embedded in model prose is extracted and executed, and its raw
 *     JSON never reaches the visible transcript (StreamGate integration);
 *   • a malformed / partial tool-call JSON fails gracefully — the turn finishes
 *     without executing a tool and without crashing;
 *   • the plan-approval state machine cannot execute any step before the user
 *     approves the plan, and cancelling it runs nothing.
 *
 * The model transport is mocked at the Ollama boundary (the `ollama` SDK plus
 * the isOllamaRunning fetch probe), so nothing hits the network or a real LLM.
 * Every other main-process dependency (Electron, tools, database, planner,
 * telemetry, training store) is stubbed so the loop logic runs deterministically
 * under plain Node.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const state = { responses: [] as string[] }
  return {
    state,
    sends: [] as Array<{ channel: string; args: unknown[] }>,
    ipc: new Map<string, (...a: unknown[]) => unknown>(),
    // Model transport: OpenUI streams from a local Ollama server. We stand in for
    // the `ollama` SDK — each ollama.chat() call yields the next scripted response
    // as a single streamed chunk, which callOllama forwards through the gate.
    ollamaChat: vi.fn(async () => {
      const text = state.responses.shift() ?? 'All done.'
      async function* stream(): AsyncGenerator<{ message: { content: string } }> {
        yield { message: { content: text } }
      }
      return stream()
    }),
    executeTool: vi.fn(async (..._args: unknown[]) => ({ ok: true, output: 'done' }) as unknown),
    looksLikeTask: vi.fn(() => false),
    generatePlan: vi.fn(async () => null as unknown),
    // Cloud routing is opt-in (flag + user setting + key). Tests flip this to
    // drive the OTHER branch of the router without touching env or Settings.
    route: { toCloud: false },
    streamAnthropic: vi.fn(async (..._args: unknown[]) => 'cloud reply')
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, cb: (...a: unknown[]) => unknown) => h.ipc.set(channel, cb),
    handle: (channel: string, cb: (...a: unknown[]) => unknown) => h.ipc.set(channel, cb)
  },
  BrowserWindow: class {}
}))

vi.mock('ollama', () => ({
  Ollama: class {
    chat = h.ollamaChat
  }
}))

vi.mock('./tools', () => ({
  executeTool: h.executeTool,
  toolSchemas: [
    {
      name: 'open_app',
      description: 'Open an app',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'app' } }, required: [] }
    }
  ],
  describeToolCall: (tool: string) => `Run ${tool}`,
  DESTRUCTIVE_TOOLS: new Set(['delete_file'])
}))

vi.mock('./subagents', () => ({
  SPAWN_SUBAGENTS_TOOL: 'spawn_subagents',
  runParallelSubagents: vi.fn(async () => 'sub-agents done'),
  parseSubTaskSpecs: vi.fn(() => [])
}))
vi.mock('./codingTools', () => ({
  codingToolSchemas: [],
  executeCodingTool: vi.fn(async () => ({ ok: true, output: 'done' })),
  describeCodingToolCall: (tool: string) => `Coding ${tool}`
}))
vi.mock('./ollamaLock', () => ({ withOllamaLock: (fn: () => unknown) => fn() }))
vi.mock('./runLog', () => ({
  startRun: vi.fn(() => ({ end: vi.fn(), toolCall: vi.fn(), step: vi.fn() }))
}))
vi.mock('./browser/consent', () => ({ grantOrigin: vi.fn() }))

vi.mock('./planner', () => ({
  generatePlan: h.generatePlan,
  looksLikeTask: h.looksLikeTask
}))

vi.mock('./mcp-client', () => ({
  getMcpToolSchemas: () => [],
  callMcpTool: vi.fn(async () => ({ ok: false, error: 'no mcp' }))
}))

vi.mock('./database', () => ({
  database: {
    conversations: { createConversation: vi.fn(() => 'conv-1') },
    messages: { addMessage: vi.fn(() => 'msg-1') },
    feedback: {
      applySignalToLast: vi.fn(),
      recordTurn: vi.fn(() => 'fb-1'),
      setExplicitRatingOnLast: vi.fn(() => 'fb-1')
    },
    settings: { getSetting: vi.fn(() => undefined) },
    training: { getStats: vi.fn(() => ({ total: 0 })) }
  }
}))

vi.mock('./stripe/pricing', () => ({ clampTierToEntitlement: (t: string) => t }))
vi.mock('./stripe/subscriptionSync', () => ({ getCurrentUserId: () => null }))
vi.mock('./telemetry/posthog', () => ({ trackEvent: vi.fn() }))
// Pin model resolution so telemetry assertions compare against a known id
// instead of whatever Ollama happens to have installed on the machine running
// the suite. Only the routing surface is stubbed; the rest of models.ts is real.
vi.mock('./models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./models')>()),
  resolveGeneralModel: async () => 'qwen3.5:latest',
  resolveOllamaModel: async (preferred: string) => preferred,
  shouldRouteToCloud: () => h.route.toCloud,
  resolveCloudModel: () => 'claude-sonnet-5',
  streamAnthropic: h.streamAnthropic
}))
vi.mock('./cloudFreeTier', () => ({ emitLocalUsage: vi.fn() }))
vi.mock('./improvement', () => ({
  classifyFeedbackSignal: () => null,
  getCustomSystemPrompt: () => null
}))
vi.mock('./trainingStore', () => ({
  TrajectoryRecorder: class {
    recordStep(): void {}
    commit(): void {}
  },
  applyQualitySignal: vi.fn(),
  applyExplicitQuality: vi.fn(),
  buildFewShotBlock: () => '',
  exportDatasetToFile: vi.fn(async () => '')
}))

import { handleChat, clearHistory, registerAgentIPC, isOllamaRunnerCrash } from './agent'
import { trackEvent } from './telemetry/posthog'
import { Events } from './telemetry/events'

// A fake BrowserWindow that records everything emitted to the renderer.
const win = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, ...args: unknown[]) => h.sends.push({ channel, args })
  }
} as never

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const chunks = (): string => h.sends.filter((s) => s.channel === 'openui:chat:chunk').map((s) => String(s.args[0])).join('')
const sent = (channel: string): boolean => h.sends.some((s) => s.channel === channel)
const lastArg = (channel: string): Record<string, unknown> | undefined => {
  const found = [...h.sends].reverse().find((s) => s.channel === channel)
  return found?.args[0] as Record<string, unknown> | undefined
}
/** The most recent status pushed for a given task-list row id (or undefined). */
const lastTaskStatus = (id: string): string | undefined => {
  const found = [...h.sends]
    .reverse()
    .find((s) => s.channel === 'openui:task:update' && (s.args[0] as { id?: string })?.id === id)
  return (found?.args[0] as { status?: string } | undefined)?.status
}

beforeEach(() => {
  clearHistory()
  h.sends.length = 0
  h.state.responses = []
  h.ollamaChat.mockClear()
  h.executeTool.mockClear().mockResolvedValue({ ok: true, output: 'done' })
  h.looksLikeTask.mockReset().mockReturnValue(false)
  h.generatePlan.mockReset().mockResolvedValue(null)
  h.route.toCloud = false
  h.streamAnthropic.mockClear()
  vi.mocked(trackEvent).mockClear()
  // isOllamaRunning() probes GET /api/tags — report the local engine as up so
  // the loop streams from our mocked Ollama transport instead of the "start
  // ollama" fallback message.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true }) as unknown as Response)
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Telemetry reports the model the turn actually ran on ──────────────────────
// Regression: the tracked `model` property used to be derived from a constant
// that had nothing to do with the route the turn took, so dashboards attributed
// every turn to a model that was never called.
describe('handleChat — tracked model matches the actual route', () => {
  /** The `model` property on the last event of this name, or undefined. */
  const trackedModel = (event: string): unknown => {
    const call = [...vi.mocked(trackEvent).mock.calls].reverse().find((c) => c[0] === event)
    return (call?.[1] as Record<string, unknown> | undefined)?.model
  }

  it('reports the local Ollama model for a free-tier turn', async () => {
    h.state.responses = ['Hello there.']
    await handleChat(win, 'hi', 'free')

    expect(trackedModel(Events.CHAT_MESSAGE_SENT)).toBe('qwen3.5:latest')
    expect(trackedModel(Events.CHAT_RESPONSE_RECEIVED)).toBe('qwen3.5:latest')
    // The renderer's model tag is fed from the same value, so it agrees too.
    expect(lastArg('openui:chat:model')).toMatchObject({ model: 'qwen3.5:latest', tier: 'free' })
    // Free tier is local: the cloud transport is never touched.
    expect(h.streamAnthropic).not.toHaveBeenCalled()
  })

  it('reports the cloud model when the turn is routed to the BYOK cloud tier', async () => {
    h.route.toCloud = true
    h.streamAnthropic.mockResolvedValueOnce('Hello from the cloud.')
    await handleChat(win, 'hi', 'free')

    expect(h.streamAnthropic).toHaveBeenCalled()
    expect(trackedModel(Events.CHAT_MESSAGE_SENT)).toBe('claude-sonnet-5')
    expect(trackedModel(Events.CHAT_RESPONSE_RECEIVED)).toBe('claude-sonnet-5')
    expect(lastArg('openui:chat:model')).toMatchObject({ model: 'claude-sonnet-5' })
  })
})

// ── Tool call extraction + StreamGate integration ─────────────────────────────
describe('handleChat — tool call in prose', () => {
  it('extracts and executes a tool call embedded in prose, without printing its JSON', async () => {
    h.state.responses = [
      'Sure, I will do that: {"tool":"open_app","args":{"name":"Slack"}}',
      'Opened Slack for you.'
    ]
    await handleChat(win, 'open slack', 'free')

    // The tool ran with the parsed args…
    expect(h.executeTool).toHaveBeenCalledTimes(1)
    expect(h.executeTool.mock.calls[0][0]).toBe('open_app')
    expect(h.executeTool.mock.calls[0][1]).toEqual({ name: 'Slack' })

    // …and the raw tool JSON never reached the visible transcript.
    const visible = chunks()
    expect(visible).not.toContain('{"tool"')
    expect(visible).not.toContain('{')
    expect(visible).toContain('Sure, I will do that:')
    expect(visible).toContain('Opened Slack for you.')
    expect(sent('openui:chat:done')).toBe(true)
  })

  it('emits the tool call on the tool channel but never as chat text', async () => {
    h.state.responses = ['{"tool":"open_app","args":{"name":"Notes"}}', 'Done.']
    await handleChat(win, 'open notes', 'free')

    expect(sent('openui:chat:tool')).toBe(true)
    expect(lastArg('openui:chat:tool')).toMatchObject({ tool: 'open_app' })
    expect(chunks()).not.toContain('open_app')
  })
})

// ── Malformed tool-call JSON ──────────────────────────────────────────────────
describe('handleChat — malformed tool-call JSON', () => {
  it('does not crash and executes no tool when the JSON is unbalanced', async () => {
    // Unbalanced object → parseToolCall returns null → treated as a (revealed)
    // natural-language answer. The turn must complete cleanly.
    h.state.responses = ['{"tool":"open_app","args":{"name":"Slack"']
    await expect(handleChat(win, 'open slack', 'free')).resolves.toBeUndefined()

    expect(h.executeTool).not.toHaveBeenCalled()
    expect(sent('openui:chat:done')).toBe(true)
    expect(sent('openui:chat:error')).toBe(false)
  })

  it('treats prose that merely mentions JSON as a normal answer', async () => {
    h.state.responses = ['The response was {"status":"ok","count":3} — all good.']
    await handleChat(win, 'status?', 'free')

    expect(h.executeTool).not.toHaveBeenCalled()
    expect(sent('openui:chat:done')).toBe(true)
  })
})

// ── Plan-approval state machine ───────────────────────────────────────────────
describe('handleChat — plan approval gate', () => {
  const plan = { summary: 'Tidy up', steps: ['step one', 'step two'] }

  beforeEach(() => {
    h.looksLikeTask.mockReturnValue(true)
    h.generatePlan.mockResolvedValue(plan)
    registerAgentIPC(win)
  })

  function resolvePlan(approved: boolean): void {
    const req = lastArg('openui:plan:request')
    expect(req, 'a plan:request should have been emitted').toBeDefined()
    const handler = h.ipc.get('openui:plan:response')
    expect(handler, 'plan:response IPC handler should be registered').toBeDefined()
    handler?.(null, { id: req?.id, approved })
  }

  it('does not execute any step until the user approves the plan', async () => {
    h.state.responses = ['{"tool":"open_app","args":{}}', 'Finished.']
    const pending = handleChat(win, 'clean my desktop', 'free')

    // Let the planning stage run up to the approval await.
    await tick()
    await tick()
    expect(sent('openui:plan:request')).toBe(true)
    expect(h.executeTool).not.toHaveBeenCalled() // still gated

    resolvePlan(true)
    await pending
    expect(h.executeTool).toHaveBeenCalledTimes(1)
    expect(h.executeTool.mock.calls[0][0]).toBe('open_app')
  })

  it('runs nothing and cancels when the user rejects the plan', async () => {
    h.state.responses = ['{"tool":"open_app","args":{}}']
    const pending = handleChat(win, 'clean my desktop', 'free')

    await tick()
    await tick()
    resolvePlan(false)
    await pending

    expect(h.executeTool).not.toHaveBeenCalled()
    // The model transport is never even consulted once the plan is cancelled.
    expect(h.ollamaChat).not.toHaveBeenCalled()
    expect(chunks().toLowerCase()).toContain('cancelled')
    expect(sent('openui:chat:done')).toBe(true)
  })

  // Regression: if the renderer never answers the plan prompt (window closed
  // while the modal is open, renderer crash/reload, dropped IPC), the backstop
  // timeout must auto-cancel the turn instead of hanging forever. Only fake
  // setTimeout so the test harness's setImmediate-based `tick()` still runs.
  it('auto-cancels the turn if the plan prompt is never answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.state.responses = ['{"tool":"open_app","args":{}}']
      const pending = handleChat(win, 'clean my desktop', 'free')

      await tick()
      await tick()
      expect(sent('openui:plan:request')).toBe(true)

      // User never responds — advance past the backstop timeout (150s).
      vi.advanceTimersByTime(200_000)
      await pending

      expect(sent('openui:plan:timeout')).toBe(true)
      expect(h.executeTool).not.toHaveBeenCalled()
      expect(h.ollamaChat).not.toHaveBeenCalled()
      expect(chunks().toLowerCase()).toContain('cancelled')
      expect(sent('openui:chat:done')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── False-completion guard: planned OS run ────────────────────────────────────
// Regression for the core bug: the model opens an app, then declares a 3-step
// plan "done" in prose without ever checking off steps 2 & 3. The checklist must
// NOT green those steps, and the reply must own up to what didn't complete.
describe('handleChat — premature "done" on a planned run', () => {
  const plan = { summary: 'Set things up', steps: ['open the app', 'write the file', 'send the message'] }

  beforeEach(() => {
    h.looksLikeTask.mockReturnValue(true)
    h.generatePlan.mockResolvedValue(plan)
    registerAgentIPC(win)
  })

  function approvePlan(): void {
    const req = lastArg('openui:plan:request')
    const handler = h.ipc.get('openui:plan:response')
    handler?.(null, { id: req?.id, approved: true })
  }

  it('greens only the step actually checked off and marks the rest error', async () => {
    // open_app → complete_step s1 → prose claiming everything is done; the model
    // then keeps insisting (default "All done.") through the nudge budget.
    h.state.responses = [
      '{"tool":"open_app","args":{}}',
      '{"tool":"complete_step","args":{"step_id":"s1"}}',
      'Everything is finished — I did all three steps for you!'
    ]
    const pending = handleChat(win, 'set up my workspace and build the site', 'free')
    await tick()
    await tick()
    approvePlan()
    await pending

    // s1 was explicitly completed; s2 and s3 never were → must not be 'done'.
    expect(lastTaskStatus('s1')).toBe('done')
    expect(lastTaskStatus('s2')).not.toBe('done')
    expect(lastTaskStatus('s3')).not.toBe('done')
    expect(lastTaskStatus('s2')).toBe('error')
    expect(lastTaskStatus('s3')).toBe('error')

    // The user-facing reply is honest about the steps that didn't complete.
    expect(String(lastArg('openui:chat:done')?.text)).toContain('could not confirm')
  })
})

// ── GPU-runner-crash detection (pure) ─────────────────────────────────────────
describe('isOllamaRunnerCrash', () => {
  it('recognises the transport-level signatures of a crashed GPU runner', () => {
    for (const m of [
      'An existing connection was forcibly closed by the remote host',
      'read ECONNRESET',
      'socket hang up',
      'llama runner terminated',
      'model runner has unexpectedly stopped',
      'CUDA error: invalid argument',
      'Error: request failed with status code 500',
      'Internal Server Error'
    ]) {
      expect(isOllamaRunnerCrash(new Error(m)), m).toBe(true)
    }
  })

  it('does not mistake ordinary errors for a runner crash', () => {
    for (const m of ['model not found', 'invalid api key', 'request timed out', 'bad request 400']) {
      expect(isOllamaRunnerCrash(new Error(m)), m).toBe(false)
    }
  })
})

// ── GPU crash → automatic CPU fallback ────────────────────────────────────────
describe('handleChat — GPU runner crash recovery', () => {
  it('retries on CPU (num_gpu: 0) and still delivers a reply when the GPU runner dies before streaming', async () => {
    // First generation dies exactly as it does in the wild: the 500 resets the
    // socket before any token is produced.
    h.ollamaChat.mockRejectedValueOnce(
      new Error('An existing connection was forcibly closed by the remote host')
    )
    h.state.responses = ['Recovered on CPU.']

    await handleChat(win, 'hello', 'free')

    // Two chat attempts: the crashed GPU run, then the CPU fallback.
    expect(h.ollamaChat).toHaveBeenCalledTimes(2)
    const fallbackReq = (h.ollamaChat.mock.calls[1] as unknown[])[0] as {
      options?: Record<string, unknown>
    }
    expect(fallbackReq.options?.num_gpu).toBe(0)

    // The user gets a warning about the crash AND the actual answer — not an error.
    expect(sent('openui:chat:warning')).toBe(true)
    expect(String(lastArg('openui:chat:warning')?.message)).toMatch(/CPU/i)
    expect(chunks()).toContain('Recovered on CPU.')
    expect(sent('openui:chat:error')).toBe(false)
    expect(sent('openui:chat:done')).toBe(true)
  })

  it('does not retry (and surfaces an actionable error) once tokens have already streamed', async () => {
    // A crash mid-stream can't be retried without duplicating what the user has
    // already seen, so the turn fails — but with a message that names the fix.
    h.ollamaChat.mockImplementationOnce(async () => {
      async function* stream(): AsyncGenerator<{ message: { content: string } }> {
        yield { message: { content: 'thinking… ' } }
        throw new Error('CUDA error: invalid argument')
      }
      return stream()
    })

    await handleChat(win, 'hello', 'free')

    expect(h.ollamaChat).toHaveBeenCalledTimes(1) // no CPU retry
    expect(sent('openui:chat:error')).toBe(true)
    expect(String(lastArg('openui:chat:error'))).toMatch(/OLLAMA_FLASH_ATTENTION=0|qwen3:4b/)
  })
})
