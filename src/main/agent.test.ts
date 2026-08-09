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
  const state = {
    responses: [] as string[],
    // Drives getAutonomyLevel() via the mocked settings repo. undefined → the
    // safe default (approve-plan), which is what most tests want.
    autonomy: undefined as string | undefined
  }
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
  codingToolSchemas: [
    {
      name: 'write_file',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] }
    }
  ],
  executeCodingTool: vi.fn(async () => ({ ok: true, output: 'done' })),
  describeCodingToolCall: (tool: string) => `Coding ${tool}`,
  mutatesWorkspace: (name: string) => name === 'write_file'
}))
// The builder session touches the real project workspace; keep it off disk.
vi.mock('./sandbox', () => ({
  getWorkspaceDir: () => '/tmp/openui-test-workspace',
  setActiveProject: vi.fn(),
  getActiveProject: () => null,
  listSandboxFiles: vi.fn(async () => ['index.html'])
}))
vi.mock('./codebaseIndex', () => ({ ensureCodebaseIndexed: vi.fn(async () => ({ ok: true })) }))
vi.mock('./codebaseMap', () => ({ buildCodebaseMap: vi.fn(async () => ({ files: 0, symbols: 0 })) }))
vi.mock('./editor', () => ({ armEditorAutoOpen: vi.fn() }))
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
    settings: {
      getSetting: vi.fn((key: string) => (key === 'autonomy_level' ? h.state.autonomy : undefined))
    },
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

import {
  handleChat,
  clearHistory,
  registerAgentIPC,
  raiseWindow,
  isOllamaRunnerCrash,
  compactBuilderHistory,
  looksLikeBuildRequest,
  DESIGNER_SYSTEM_PROMPT,
  DESIGNER_TOOL_NAMES,
  type Message
} from './agent'
import { figmaBuildToolSchemas } from './figmaBuild'
import { trackEvent } from './telemetry/posthog'
import { Events } from './telemetry/events'
import { callMcpTool } from './mcp-client'
import { executeCodingTool } from './codingTools'
import { grantOrigin } from './browser/consent'

// A fake BrowserWindow that records everything emitted to the renderer, plus the
// window-management calls raiseWindow makes so a test can assert the OpenUI window
// is pulled to the foreground before a HITL prompt (so the modal isn't stranded
// behind an app a tool just focused, e.g. WhatsApp).
const winCalls = { focus: 0, show: 0, alwaysOnTop: [] as boolean[] }
const win = {
  isDestroyed: () => false,
  isMinimized: () => false,
  restore: () => {},
  show: () => {
    winCalls.show++
  },
  focus: () => {
    winCalls.focus++
  },
  setAlwaysOnTop: (flag: boolean) => {
    winCalls.alwaysOnTop.push(flag)
  },
  webContents: {
    send: (channel: string, ...args: unknown[]) => h.sends.push({ channel, args })
  }
} as never

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
/**
 * Drive the loop forward until `pred` holds. The number of microtask turns
 * between handleChat() and a given emit varies with the path taken (model
 * stream → parse → executeTool → gate), so polling is far less brittle than a
 * fixed number of tick()s. Returns false if it never became true.
 */
const waitFor = async (pred: () => boolean, maxTicks = 60): Promise<boolean> => {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return true
    await tick()
  }
  return pred()
}
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
  winCalls.focus = 0
  winCalls.show = 0
  winCalls.alwaysOnTop.length = 0
  h.state.responses = []
  h.ollamaChat.mockClear()
  h.executeTool.mockClear().mockResolvedValue({ ok: true, output: 'done' })
  h.looksLikeTask.mockReset().mockReturnValue(false)
  h.generatePlan.mockReset().mockResolvedValue(null)
  h.route.toCloud = false
  h.state.autonomy = undefined
  h.streamAnthropic.mockClear()
  vi.mocked(trackEvent).mockClear()
  vi.mocked(callMcpTool).mockClear().mockResolvedValue({ ok: false, error: 'no mcp' })
  vi.mocked(grantOrigin).mockClear()
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

// ── HITL approval gate: the promise-resolution path ───────────────────────────
// This is the boundary that decides whether an LLM-proposed state-changing
// action actually touches the user's machine. executeTool returns
// pending_approval, the loop emits openui:hitl:request and AWAITS a resolver
// stored in a module-level map; the renderer's openui:hitl:response resolves it.
// Nothing here was covered before: these tests drive a real pending_approval
// through Allow, Deny, the backstop timeout, and the stale/garbage-id cases.
describe('handleChat — HITL approval gate', () => {
  /** Tools our stubbed executeTool treats as state-changing (mirrors tools.ts). */
  const GATED = new Set(['open_app', 'delete_file'])

  beforeEach(() => {
    registerAgentIPC(win)
    // Behave like the real executeTool: pause for approval unless bypassHitl.
    h.executeTool.mockImplementation(async (...a: unknown[]) => {
      const name = a[0] as string
      const args = a[1] as Record<string, unknown>
      const ctx = (a[2] ?? {}) as { bypassHitl?: boolean }
      if (GATED.has(name) && !ctx.bypassHitl) {
        return { status: 'pending_approval', tool: name, args }
      }
      return { ok: true, output: 'done' }
    })
  })

  /** Answer the outstanding HITL prompt exactly as the renderer would. */
  function respondHitl(approved: unknown, idOverride?: string): void {
    const req = lastArg('openui:hitl:request')
    const handler = h.ipc.get('openui:hitl:response')
    expect(handler, 'hitl:response IPC handler should be registered').toBeDefined()
    handler?.(null, { id: idOverride ?? req?.id, approved })
  }

  /** Calls to executeTool that actually ran the tool (i.e. past the gate). */
  const bypassCalls = (): unknown[][] =>
    h.executeTool.mock.calls.filter((c) => (c[2] as { bypassHitl?: boolean } | undefined)?.bypassHitl)

  it('pauses on a state-changing tool and does not run it before the user answers', async () => {
    h.state.responses = ['{"tool":"open_app","args":{"name":"Slack"}}', 'Opened it.']
    const pending = handleChat(win, 'open slack', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    // The prompt carries the tool + args the user is being asked to authorise.
    expect(lastArg('openui:hitl:request')).toMatchObject({
      tool: 'open_app',
      args: { name: 'Slack' }
    })
    // Gated: the tool has been *offered* to executeTool but never executed.
    expect(bypassCalls()).toHaveLength(0)

    respondHitl(true)
    await pending

    // Allow → re-executed, this time with bypassHitl so it really runs.
    expect(bypassCalls()).toHaveLength(1)
    expect(bypassCalls()[0][0]).toBe('open_app')
    expect(bypassCalls()[0][1]).toEqual({ name: 'Slack' })
    expect(sent('openui:chat:done')).toBe(true)
  })

  it('never executes the tool when the user denies, and tells the model not to retry', async () => {
    h.state.responses = ['{"tool":"open_app","args":{"name":"Slack"}}', 'Understood.']
    const pending = handleChat(win, 'open slack', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    respondHitl(false)
    await pending

    // The critical assertion: a denied action is NEVER run.
    expect(bypassCalls()).toHaveLength(0)
    expect(sent('openui:chat:done')).toBe(true)
    expect(sent('openui:chat:error')).toBe(false)
    // The task row reflects the refusal rather than silently going green.
    // (Row ids come from a module-level counter, so assert on the last update.)
    expect(lastArg('openui:task:update')).toMatchObject({ status: 'error' })
  })

  // A non-boolean payload must fail CLOSED. The resolver compares `approved ===
  // true`, so a truthy-but-not-true value (a stringified "true" from a sloppy
  // renderer, say) must still deny rather than authorise an OS action.
  it('treats a non-boolean approval payload as a denial', async () => {
    h.state.responses = ['{"tool":"open_app","args":{}}', 'Understood.']
    const pending = handleChat(win, 'open slack', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    respondHitl('true') // string, not boolean
    await pending

    expect(bypassCalls()).toHaveLength(0)
  })

  // Regression guard for the loop hanging forever: if the renderer never
  // answers (crash, reload, closed window, dropped IPC), the main-process
  // backstop must auto-DENY and let the turn finish.
  it('auto-denies and completes the turn if the prompt is never answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.state.responses = ['{"tool":"open_app","args":{}}', 'Understood.']
      const pending = handleChat(win, 'open slack', 'free')

      expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
      vi.advanceTimersByTime(200_000) // past HITL_BACKSTOP_TIMEOUT_MS (150s)
      await pending

      expect(sent('openui:hitl:timeout')).toBe(true)
      expect(bypassCalls()).toHaveLength(0) // timed out ⇒ denied ⇒ never ran
      expect(sent('openui:chat:done')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // The resolver map is keyed by request id. A response for an id that is not
  // outstanding (a late click on a stale modal, a duplicate send) must be
  // ignored — not crash, and not resolve the request that IS outstanding.
  it('ignores a response carrying an unknown id, then still honours the real one', async () => {
    h.state.responses = ['{"tool":"open_app","args":{}}', 'Opened it.']
    const pending = handleChat(win, 'open slack', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    respondHitl(true, 'hitl-nonexistent') // stale/garbage id → no effect
    await tick()
    expect(bypassCalls()).toHaveLength(0) // still waiting on the real prompt

    respondHitl(true)
    await pending
    expect(bypassCalls()).toHaveLength(1)
  })

  it('ignores a malformed response payload without crashing the turn', async () => {
    h.state.responses = ['{"tool":"open_app","args":{}}', 'Opened it.']
    const pending = handleChat(win, 'open slack', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    const handler = h.ipc.get('openui:hitl:response')
    expect(() => {
      handler?.(null, null)
      handler?.(null, 'not an object')
      handler?.(null, { id: 42, approved: true }) // non-string id
    }).not.toThrow()
    await tick()
    expect(bypassCalls()).toHaveLength(0)

    respondHitl(true)
    await pending
    expect(bypassCalls()).toHaveLength(1)
  })

  // A second gated tool in the same turn must take its OWN approval — one
  // Allow authorises one action, never a standing grant for the rest of the turn.
  it('requires a separate approval for each gated tool in the same turn', async () => {
    h.state.responses = [
      '{"tool":"open_app","args":{"name":"Slack"}}',
      '{"tool":"open_app","args":{"name":"Notes"}}',
      'Both open.'
    ]
    const pending = handleChat(win, 'open both', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    const firstId = lastArg('openui:hitl:request')?.id
    respondHitl(true)

    expect(await waitFor(() => lastArg('openui:hitl:request')?.id !== firstId)).toBe(true)
    const secondId = lastArg('openui:hitl:request')?.id
    expect(secondId).not.toBe(firstId) // a fresh request, not the stale one
    respondHitl(true)
    await pending

    expect(bypassCalls()).toHaveLength(2)
  })
})

// ── Autonomy vs. DESTRUCTIVE_TOOLS ────────────────────────────────────────────
// agent.ts computes `bypassHitl = autopilot && !DESTRUCTIVE_TOOLS.has(tool)`.
// That single expression is what stops full-auto from silently deleting files;
// if it ever inverted, an autonomous run could destroy user data with no prompt.
describe('handleChat — autonomy never bypasses a destructive tool', () => {
  const GATED = new Set(['open_app', 'delete_file'])

  beforeEach(() => {
    registerAgentIPC(win)
    h.executeTool.mockImplementation(async (...a: unknown[]) => {
      const name = a[0] as string
      const ctx = (a[2] ?? {}) as { bypassHitl?: boolean }
      if (GATED.has(name) && !ctx.bypassHitl) {
        return { status: 'pending_approval', tool: name, args: a[1] }
      }
      return { ok: true, output: 'done' }
    })
  })

  it('runs a non-destructive tool with no prompt under full-auto', async () => {
    h.state.autonomy = 'full-auto'
    h.state.responses = ['{"tool":"open_app","args":{"name":"Slack"}}', 'Done.']
    await handleChat(win, 'open slack', 'free')

    expect(sent('openui:hitl:request')).toBe(false) // autopilot — no human click
    expect(h.executeTool.mock.calls[0][2]).toMatchObject({ bypassHitl: true })
  })

  it('STILL prompts for a destructive tool under full-auto', async () => {
    h.state.autonomy = 'full-auto'
    h.state.responses = ['{"tool":"delete_file","args":{"path":"~/x.txt"}}', 'Done.']
    const pending = handleChat(win, 'delete x', 'free')

    // delete_file is in DESTRUCTIVE_TOOLS, so autopilot must NOT bypass it.
    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    expect(lastArg('openui:hitl:request')).toMatchObject({ tool: 'delete_file' })
    expect(h.executeTool.mock.calls[0][2]).toMatchObject({ bypassHitl: false })

    const handler = h.ipc.get('openui:hitl:response')
    handler?.(null, { id: lastArg('openui:hitl:request')?.id, approved: false })
    await pending

    // Denied under full-auto ⇒ the deletion never ran.
    expect(
      h.executeTool.mock.calls.filter(
        (c) => c[0] === 'delete_file' && (c[2] as { bypassHitl?: boolean })?.bypassHitl
      )
    ).toHaveLength(0)
  })

  it('prompts for every state-changing tool under the default (approve-plan, no plan)', async () => {
    // Outside an approved plan, approve-plan behaves like ask-each.
    h.state.autonomy = undefined
    h.state.responses = ['{"tool":"open_app","args":{}}', 'Done.']
    const pending = handleChat(win, 'open slack', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    expect(h.executeTool.mock.calls[0][2]).toMatchObject({ bypassHitl: false })
    const handler = h.ipc.get('openui:hitl:response')
    handler?.(null, { id: lastArg('openui:hitl:request')?.id, approved: true })
    await pending
  })
})

// ── Sensitive-action re-entry (needsConfirmation) ─────────────────────────────
// A tool can refuse mid-execution and ask for one human click (per-site browser
// consent, a payment/password step). This gate sits BELOW autonomy — full-auto
// included — so it must fire even when bypassHitl was already true.
describe('handleChat — tool-requested confirmation (needsConfirmation)', () => {
  beforeEach(() => registerAgentIPC(win))

  it('re-runs with sensitiveApproved and persists the site grant on approval', async () => {
    h.state.autonomy = 'full-auto' // even here the tool-level gate must fire
    h.executeTool
      .mockResolvedValueOnce({
        ok: false,
        error: 'needs consent',
        needsConfirmation: {
          kind: 'site-consent',
          label: 'Allow OpenUI to use example.com?',
          origin: 'https://example.com'
        }
      })
      .mockResolvedValue({ ok: true, output: 'navigated' })

    h.state.responses = ['{"tool":"browser_navigate","args":{"url":"https://example.com"}}', 'Done.']
    const pending = handleChat(win, 'go to example', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    expect(lastArg('openui:hitl:request')).toMatchObject({
      label: 'Allow OpenUI to use example.com?'
    })

    const handler = h.ipc.get('openui:hitl:response')
    handler?.(null, { id: lastArg('openui:hitl:request')?.id, approved: true })
    await pending

    // The origin grant is persisted, and the retry carries sensitiveApproved.
    expect(vi.mocked(grantOrigin)).toHaveBeenCalledWith('https://example.com', 'hitl')
    expect(h.executeTool.mock.calls[1][2]).toMatchObject({ sensitiveApproved: true })
  })

  it('does not grant the origin or re-run when the user declines', async () => {
    h.executeTool.mockResolvedValue({
      ok: false,
      error: 'needs consent',
      needsConfirmation: {
        kind: 'site-consent',
        label: 'Allow OpenUI to use evil.example?',
        origin: 'https://evil.example'
      }
    })

    h.state.responses = ['{"tool":"browser_navigate","args":{"url":"https://evil.example"}}', 'OK.']
    const pending = handleChat(win, 'go there', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    const handler = h.ipc.get('openui:hitl:response')
    handler?.(null, { id: lastArg('openui:hitl:request')?.id, approved: false })
    await pending

    expect(vi.mocked(grantOrigin)).not.toHaveBeenCalled()
    expect(
      h.executeTool.mock.calls.filter(
        (c) => (c[2] as { sensitiveApproved?: boolean } | undefined)?.sensitiveApproved
      )
    ).toHaveLength(0)
  })
})

// ── Candidate picker (needsConfirmation.kind === 'choice') ────────────────────
// An ambiguous target (e.g. "which WhatsApp chat did you mean?") comes back as a
// choice result: the loop must emit a picker request carrying the `choices`, and
// on a pick, RE-RUN the same tool with the picked value merged in as
// resolvedContact — that re-run is what actually reaches the send. If this path
// is broken the user sees "WhatsApp opened, then nothing". These pin it down.
describe('handleChat — candidate picker (choice confirmation)', () => {
  beforeEach(() => registerAgentIPC(win))

  function respondChoice(selected: string | null): void {
    const req = lastArg('openui:hitl:request')
    const handler = h.ipc.get('openui:hitl:choice-response')
    expect(handler, 'choice-response IPC handler should be registered').toBeDefined()
    handler?.(null, { id: req?.id, selected })
  }

  it('emits a picker with choices and re-runs the tool with the picked contact on select', async () => {
    h.executeTool
      .mockResolvedValueOnce({
        ok: false,
        error: 'Could not confidently find a single WhatsApp chat for "John".',
        needsConfirmation: {
          kind: 'choice',
          label: 'Which WhatsApp chat did you mean by "John"?',
          choices: ['John Smith', 'John Doe']
        }
      })
      .mockResolvedValue({ ok: true, output: 'Sent your WhatsApp message to "John Doe".' })

    h.state.responses = ['{"tool":"send_whatsapp_message","args":{"contact":"John","message":"hi"}}', 'Sent it.']
    const pending = handleChat(win, 'message John hi', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    // The request is a picker: it carries the candidate list, not a plain Allow/Deny.
    expect(lastArg('openui:hitl:request')).toMatchObject({
      choices: ['John Smith', 'John Doe']
    })
    // The window was raised so the picker isn't hidden behind the focused app.
    expect(winCalls.focus).toBeGreaterThan(0)
    expect(winCalls.alwaysOnTop).toContain(true)

    respondChoice('John Doe')
    await pending

    // The pick is fed back as resolvedContact on a re-run of the SAME tool — this
    // is the step that actually sends, not just opens the chat.
    const sendCalls = h.executeTool.mock.calls.filter((c) => c[0] === 'send_whatsapp_message')
    expect(sendCalls.length).toBe(2)
    expect(sendCalls[1][1]).toMatchObject({ contact: 'John', resolvedContact: 'John Doe' })
  })

  it('does not re-run the tool when the user cancels the picker', async () => {
    h.executeTool.mockResolvedValue({
      ok: false,
      error: 'ambiguous',
      needsConfirmation: { kind: 'choice', label: 'Which one?', choices: ['A', 'B'] }
    })

    h.state.responses = ['{"tool":"send_whatsapp_message","args":{"contact":"X","message":"hi"}}', 'OK.']
    const pending = handleChat(win, 'message X hi', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    respondChoice(null) // cancel
    await pending

    // Only the initial resolve attempt ran — no re-run carrying resolvedContact.
    const withResolved = h.executeTool.mock.calls.filter(
      (c) => (c[1] as { resolvedContact?: string } | undefined)?.resolvedContact
    )
    expect(withResolved).toHaveLength(0)
  })
})

// ── Tier-gate refusal is surfaced, never a silent dead end ────────────────────
// A free user hitting a Pro-only tool (computer_use / browser_vision_act) gets an
// ok:false with tierRequired. The model is told, but it can go quiet — leaving a
// browser that opened and went nowhere. The loop must make the upgrade reason
// visible to the user when the turn ends without it.
describe('handleChat — tier-gated tool surfacing', () => {
  beforeEach(() => registerAgentIPC(win))

  it('tells the user the feature needs an upgrade when the model ends quietly', async () => {
    h.executeTool.mockResolvedValueOnce({
      ok: false,
      tierRequired: 'pro',
      error: '"computer_use" requires a pro subscription or higher (current tier: free).'
    })
    // Model opens nothing useful afterwards — ends with vague prose that omits the reason.
    h.state.responses = [
      '{"tool":"computer_use","args":{"goal":"find a paper"}}',
      'I had a look for you.'
    ]
    const pending = handleChat(win, 'find me a paper on transformers', 'free')
    await pending

    const doneText = String(lastArg('openui:chat:done')?.text ?? '')
    expect(doneText).toMatch(/computer_use/)
    expect(doneText).toMatch(/Pro subscription/i)
  })
})

// ── raiseWindow (pure, defensive) ─────────────────────────────────────────────
describe('raiseWindow', () => {
  it('shows, focuses, and toggles always-on-top to force a z-order raise', () => {
    const calls: string[] = []
    const fake = {
      isDestroyed: () => false,
      isMinimized: () => false,
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
      setAlwaysOnTop: (f: boolean) => calls.push(`aot:${f}`)
    } as never
    raiseWindow(fake)
    expect(calls).toEqual(['show', 'focus', 'aot:true', 'aot:false'])
  })

  it('is a no-op on a destroyed window and never throws', () => {
    expect(() => raiseWindow({ isDestroyed: () => true } as never)).not.toThrow()
  })

  it('never throws on a stripped window missing the optional methods', () => {
    expect(() => raiseWindow({} as never)).not.toThrow()
  })
})

// ── MCP fallback is gated too ─────────────────────────────────────────────────
// An unknown tool falls through to an MCP server, which can run arbitrary local
// actions. Because it is not a built-in, executeTool's own HITL gate never
// fires for it — agent.ts has to gate it separately. That substitute gate is
// what these tests pin down.
describe('handleChat — unknown tool → MCP fallback', () => {
  beforeEach(() => {
    registerAgentIPC(win)
    h.executeTool.mockResolvedValue({ ok: false, error: 'Unknown tool "mcp_thing".' })
  })

  it('asks for approval before invoking an MCP tool, and invokes it on Allow', async () => {
    h.state.responses = ['{"tool":"mcp_thing","args":{"a":1}}', 'Done.']
    const pending = handleChat(win, 'do the mcp thing', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    expect(vi.mocked(callMcpTool)).not.toHaveBeenCalled() // gated first

    const handler = h.ipc.get('openui:hitl:response')
    handler?.(null, { id: lastArg('openui:hitl:request')?.id, approved: true })
    await pending

    expect(vi.mocked(callMcpTool)).toHaveBeenCalledWith('mcp_thing', { a: 1 })
  })

  it('never invokes the MCP tool when denied', async () => {
    h.state.responses = ['{"tool":"mcp_thing","args":{}}', 'OK.']
    const pending = handleChat(win, 'do the mcp thing', 'free')

    expect(await waitFor(() => sent('openui:hitl:request'))).toBe(true)
    const handler = h.ipc.get('openui:hitl:response')
    handler?.(null, { id: lastArg('openui:hitl:request')?.id, approved: false })
    await pending

    expect(vi.mocked(callMcpTool)).not.toHaveBeenCalled()
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

describe('designer system prompt', () => {
  // The designer prompt is what actually decides whether the Figma build tools
  // get used. It previously stated outright that nothing could author a Figma
  // file — true before the builder plugin existed, and afterwards a line that
  // silently talked the model out of a whole feature. These guard that drift.

  it('allow-lists every Figma build tool for designer mode', () => {
    // DESIGNER_TOOL_NAMES is the filter the prompt renders through — a tool
    // missing here is registered but invisible to the mode built to use it.
    // (Asserting on the rendered list itself would only test this file's
    // toolSchemas mock.)
    for (const schema of figmaBuildToolSchemas) {
      expect(
        DESIGNER_TOOL_NAMES,
        `${schema.name} is registered but not offered in designer mode`
      ).toContain(schema.name)
    }
  })

  it('does not claim that nothing can create Figma layers', () => {
    expect(DESIGNER_SYSTEM_PROMPT).not.toMatch(/there is no tool that does/i)
    expect(DESIGNER_SYSTEM_PROMPT).not.toMatch(/cannot create[^.]*frames[^.]*\band there is no\b/i)
  })

  it('still states the real limit — existing layers cannot be edited', () => {
    // The boundary is genuine and load-bearing: the builder ADDS layers via a
    // plugin, it does not mutate what is already there.
    expect(DESIGNER_SYSTEM_PROMPT).toMatch(/READ-ONLY for file content/i)
    expect(DESIGNER_SYSTEM_PROMPT).toMatch(/never claim to have edited a Figma file/i)
  })

  it('tells the model what to do when the builder plugin is not running', () => {
    expect(DESIGNER_SYSTEM_PROMPT).toContain('setup_figma_builder')
  })
})

// ── Builder context budget ───────────────────────────────────────────────────
// Regression: a builder session accumulated every written file in its message
// history and never trimmed it. Past num_ctx, Ollama silently drops the MIDDLE
// of the prompt — where the tool instructions live — so the model stopped
// emitting tool calls and answered in prose instead, which reached the user as
// the agent declining to build rather than as a context overflow.
describe('compactBuilderHistory', () => {
  const msg = (role: 'user' | 'assistant', content: string): Message => ({ role, content })
  const size = (ms: Message[]): number => ms.reduce((n, m) => n + m.content.length, 0)

  it('leaves a history that already fits untouched', () => {
    const history = [msg('user', 'build a site'), msg('assistant', 'ok')]
    expect(compactBuilderHistory(history, 10_000)).toBe(history)
  })

  it('brings an oversized history back under budget', () => {
    const history: Message[] = [msg('user', 'build a marketing site')]
    for (let i = 0; i < 20; i++) {
      history.push(msg('assistant', JSON.stringify({ tool: 'write_file', args: { path: `page${i}.html`, content: 'x'.repeat(4000) } })))
      history.push(msg('user', `TOOL RESULT [write_file] success: ${'y'.repeat(2000)}`))
    }
    const budget = 20_000
    expect(size(history)).toBeGreaterThan(budget)
    expect(size(compactBuilderHistory(history, budget))).toBeLessThanOrEqual(budget)
  })

  it('keeps the original request and the most recent exchanges verbatim', () => {
    const request = 'build a marketing site with a pricing page'
    const history: Message[] = [msg('user', request)]
    for (let i = 0; i < 20; i++) {
      history.push(msg('assistant', JSON.stringify({ tool: 'write_file', args: { path: `p${i}.html`, content: 'x'.repeat(4000) } })))
      history.push(msg('user', `TOOL RESULT [write_file] success: wrote p${i}.html`))
    }
    const out = compactBuilderHistory(history, 20_000)
    expect(out[0].content).toBe(request)
    expect(out.at(-1)?.content).toBe(history.at(-1)?.content)
  })

  it('replaces a dropped file body with a pointer to the file on disk', () => {
    const history: Message[] = [msg('user', 'build a site')]
    for (let i = 0; i < 20; i++) {
      history.push(msg('assistant', JSON.stringify({ tool: 'write_file', args: { path: `p${i}.html`, content: 'x'.repeat(4000) } })))
      history.push(msg('user', `TOOL RESULT [write_file] success: wrote p${i}.html`))
    }
    const out = compactBuilderHistory(history, 40_000)
    const compacted = out.filter((m) => m.content.startsWith('[earlier step]'))
    expect(compacted.length).toBeGreaterThan(0)
    // The model must be told the contents are recoverable, or it will rewrite
    // the file blind — and write_file replaces the whole thing.
    expect(compacted[0].content).toContain('read_file')
    expect(compacted[0].content).toContain('write_file')
  })

  it('truncates even a single oversized request rather than overflowing', () => {
    const history = [msg('user', 'z'.repeat(50_000))]
    const out = compactBuilderHistory(history, 5000)
    expect(size(out)).toBeLessThanOrEqual(5000)
    expect(out[0].content).toContain('truncated')
  })
})

// ── Build-request routing ────────────────────────────────────────────────────
// Only these messages reach the sandboxed builder loop; everything else falls
// through to OS automation, where there are no file-writing tools at all.
describe('looksLikeBuildRequest', () => {
  it('matches plain build requests', () => {
    expect(looksLikeBuildRequest('build me a react app')).toBe(true)
    expect(looksLikeBuildRequest('make one website with this specification')).toBe(true)
    expect(looksLikeBuildRequest('create a landing page')).toBe(true)
  })

  it('matches continuation phrasing', () => {
    // Regression: the trigger only accepted the bare verb, so the follow-up the
    // step-limit message itself suggests ("keep building the website") missed
    // the builder and was answered by the OS-automation loop, which cannot
    // write a single file.
    expect(looksLikeBuildRequest('keep building the website')).toBe(true)
    expect(looksLikeBuildRequest('continue the project')).toBe(true)
    expect(looksLikeBuildRequest('finish the app')).toBe(true)
  })

  it('still ignores plain OS requests', () => {
    expect(looksLikeBuildRequest('create a folder on my Desktop')).toBe(false)
    expect(looksLikeBuildRequest('send a whatsapp message to mum')).toBe(false)
  })
})

// ── Builder loop: no-progress guards ─────────────────────────────────────────
// Regression, observed in a real local run: the model answered "TOOL RESULT
// [write_file] success" by writing the same file again, 38 times, until the
// step budget ran out and the user got a half-built project.
describe('runBuilderSession — repeated identical writes', () => {
  const writeCall = JSON.stringify({ tool: 'write_file', args: { path: 'index.html', content: '<h1>hi</h1>' } })

  it('executes an identical write once, however many times the model asks', async () => {
    clearHistory()
    vi.mocked(executeCodingTool).mockClear()
    h.state.responses = [writeCall, writeCall, writeCall, writeCall, writeCall, writeCall]

    await handleChat(win, 'build a website', 'free')

    expect(vi.mocked(executeCodingTool)).toHaveBeenCalledTimes(1)
  })

  it('gives up with the files it has rather than spending every step on one file', async () => {
    clearHistory()
    vi.mocked(executeCodingTool).mockClear()
    h.state.responses = Array.from({ length: 40 }, () => writeCall)

    await handleChat(win, 'build a website', 'free')

    const final = String((h.sends.filter((s) => s.channel === 'openui:chat:done').at(-1)?.args[0] as { text: string }).text)
    expect(final).toMatch(/stopped making progress/i)
    expect(final).toContain('index.html')
    // The whole point: it bailed early instead of burning the budget.
    expect(h.state.responses.length).toBeGreaterThan(30)
  })
})
