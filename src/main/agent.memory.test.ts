/**
 * agent.memory.test.ts — conversation memory across New Chat / resume.
 *
 * Proves the invariant the Run Console redesign depends on: the model is
 * answered with the RIGHT conversation's history. Specifically:
 *
 *   1. Send message A in conversation 1.
 *   2. New Chat (clearHistory) → send message B in conversation 2, and assert
 *      the model call for B does NOT see A (histories don't bleed across).
 *   3. Resume conversation 1 → ask about A, and assert the model call now DOES
 *      receive A's exchange in its message window.
 *   4. The bounded context window (contextForModel) keeps only a valid,
 *      user-first alternating slice.
 *
 * The model transport is mocked at the Ollama boundary; the database mock here
 * is a REAL in-memory message store (unlike agent.test.ts's no-op stub) so that
 * resumeConversation can actually reload a past thread.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { contextForModel, MAX_CONTEXT_MESSAGES } from './agent'
import type { Message } from './agent'

const h = vi.hoisted(() => {
  // gate: when set, the model call waits on it, so a test can act mid-turn.
  // fail: the next model call throws, to drive the failed-turn rollback.
  const state = { responses: [] as string[], gate: null as Promise<void> | null, fail: false }
  // Real in-memory store so getMessagesByConversation returns what addMessage saved.
  const store = {
    convSeq: 0,
    messages: [] as Array<{ conversationId: string; role: string; content: string }>
  }
  return {
    state,
    store,
    sends: [] as Array<{ channel: string; args: unknown[] }>,
    ipc: new Map<string, (...a: unknown[]) => unknown>(),
    // Each ollama.chat() call yields the next scripted response as one chunk and
    // records the messages it was asked to send (so we can assert what the model
    // actually saw this turn).
    ollamaChat: vi.fn(async (_arg: unknown) => {
      if (state.gate) await state.gate
      if (state.fail) {
        state.fail = false
        throw new Error('model exploded')
      }
      const text = state.responses.shift() ?? 'All done.'
      async function* stream(): AsyncGenerator<{ message: { content: string } }> {
        yield { message: { content: text } }
      }
      return stream()
    })
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, cb: (...a: unknown[]) => unknown) => h.ipc.set(channel, cb),
    handle: (channel: string, cb: (...a: unknown[]) => unknown) => h.ipc.set(channel, cb)
  },
  BrowserWindow: class {}
}))

vi.mock('ollama', () => ({ Ollama: class { chat = h.ollamaChat } }))

vi.mock('./tools', () => ({
  executeTool: vi.fn(async () => ({ ok: true, output: 'done' })),
  toolSchemas: [],
  describeToolCall: (tool: string) => `Run ${tool}`,
  DESTRUCTIVE_TOOLS: new Set<string>()
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
vi.mock('./runLog', () => ({ startRun: vi.fn(() => ({ end: vi.fn(), toolCall: vi.fn(), step: vi.fn() })) }))
vi.mock('./browser/consent', () => ({ grantOrigin: vi.fn() }))
vi.mock('./planner', () => ({ generatePlan: vi.fn(async () => null), looksLikeTask: vi.fn(() => false) }))
vi.mock('./mcp-client', () => ({ getMcpToolSchemas: () => [], callMcpTool: vi.fn(async () => ({ ok: false, error: 'no mcp' })) }))

vi.mock('./database', () => ({
  database: {
    conversations: {
      createConversation: vi.fn(() => `conv-${++h.store.convSeq}`),
      getConversationsByUser: vi.fn(() => [])
    },
    messages: {
      addMessage: vi.fn((conversationId: string, role: string, content: string) => {
        h.store.messages.push({ conversationId, role, content })
        return `msg-${h.store.messages.length}`
      }),
      getMessagesByConversation: vi.fn((conversationId: string) =>
        h.store.messages.filter((m) => m.conversationId === conversationId)
      )
    },
    feedback: { applySignalToLast: vi.fn(), recordTurn: vi.fn(), setExplicitRatingOnLast: vi.fn() },
    settings: { getSetting: vi.fn(() => undefined) },
    training: { getStats: vi.fn(() => ({ total: 0 })) }
  }
}))

vi.mock('./stripe/pricing', () => ({ clampTierToEntitlement: (t: string) => t }))
vi.mock('./stripe/subscriptionSync', () => ({ getCurrentUserId: () => null }))
vi.mock('./telemetry/posthog', () => ({ trackEvent: vi.fn() }))
vi.mock('./models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./models')>()),
  resolveGeneralModel: async () => 'qwen3.5:latest',
  resolveOllamaModel: async (preferred: string) => preferred,
  // See agent.test.ts: the availability probe would otherwise hit /api/tags,
  // which this file's transport mock does not implement.
  isModelInstalled: async () => true,
  shouldRouteToCloud: () => false,
  resolveCloudModel: () => 'claude-sonnet-5',
  streamAnthropic: vi.fn(async () => 'cloud reply')
}))
vi.mock('./cloudFreeTier', () => ({ emitLocalUsage: vi.fn() }))
vi.mock('./usageMeter', () => ({
  checkAllowance: () => ({ allowed: true, used: 0, limit: null, remaining: null, unlimited: true, resetsAt: 0 }),
  recordTurn: vi.fn(),
  limitReachedMessage: () => ''
}))
vi.mock('./improvement', () => ({ classifyFeedbackSignal: () => null, getCustomSystemPrompt: () => null }))
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

// resume-conversation / clear-history live in different registrars: clear-history
// in registerAgentIPC, resume-conversation in registerConversationIPC. Register both.
import { handleChat, clearHistory, registerAgentIPC, registerConversationIPC } from './agent'

const win = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, ...args: unknown[]) => h.sends.push({ channel, args }) }
} as never

/** Concatenated content of every message the model was sent on its Nth call. */
function messagesOnCall(callIndex: number): string {
  const arg = h.ollamaChat.mock.calls[callIndex]?.[0] as { messages?: Array<{ content: string }> } | undefined
  return (arg?.messages ?? []).map((m) => m.content).join('\n')
}
/** Content the model was sent on its most recent call. */
function lastModelContext(): string {
  return messagesOnCall(h.ollamaChat.mock.calls.length - 1)
}

beforeEach(() => {
  clearHistory()
  h.sends.length = 0
  h.state.responses = []
  h.state.gate = null
  h.state.fail = false
  h.store.messages.length = 0
  h.store.convSeq = 0
  h.ollamaChat.mockClear()
  registerAgentIPC(win)
  registerConversationIPC(win)
  // isOllamaRunning() probes GET /api/tags — report the engine as up.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as unknown as Response))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conversation memory — New Chat isolates, resume restores', () => {
  it('does not bleed conversation 1 into conversation 2, and restores it on resume', async () => {
    const resume = h.ipc.get('openui:resume-conversation') as (e: unknown, id: string) => Promise<unknown>
    const newChat = h.ipc.get('openui:clear-history') as () => void
    expect(resume).toBeTypeOf('function')
    expect(newChat).toBeTypeOf('function')

    // ── Conversation 1: establish a memorable fact (message A) ────────────────
    h.state.responses = ['Got it — the secret word is APPLE.']
    await handleChat(win, 'Remember: the secret word is APPLE.', 'free')
    // conv-1 exists and both sides of A are persisted.
    expect(h.store.messages.filter((m) => m.conversationId === 'conv-1')).toHaveLength(2)

    // ── New Chat → Conversation 2: a fresh, unrelated turn (message B) ────────
    newChat()
    h.ollamaChat.mockClear()
    h.state.responses = ['It is sunny today.']
    await handleChat(win, 'What is the weather?', 'free')
    // A brand-new conversation row was created…
    expect(h.store.convSeq).toBe(2)
    // …and the model call for B must NOT have seen A's secret word.
    expect(lastModelContext()).not.toContain('APPLE')
    expect(lastModelContext()).toContain('What is the weather?')

    // ── Resume Conversation 1 → ask about A ──────────────────────────────────
    await resume(null, 'conv-1')
    h.ollamaChat.mockClear()
    h.state.responses = ['The secret word was APPLE.']
    await handleChat(win, 'What was the secret word?', 'free')
    // The model was answered WITH conversation 1's exchange in its window.
    const ctx = lastModelContext()
    expect(ctx).toContain('APPLE')
    expect(ctx).toContain('the secret word is APPLE') // A's assistant reply too
    expect(ctx).toContain('What was the secret word?')
    // And this turn was persisted back into conversation 1, not a new one.
    expect(h.store.convSeq).toBe(2)
    expect(h.store.messages.filter((m) => m.conversationId === 'conv-1')).toHaveLength(4)
  })
})

describe('one turn at a time — double send and New chat mid-answer', () => {
  /** Hold the model mid-answer; returns the release function. */
  function holdModel(): () => void {
    let release!: () => void
    h.state.gate = new Promise<void>((r) => (release = r))
    return () => {
      h.state.gate = null
      release()
    }
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('refuses a second message while the first is still answering, without failing the first', async () => {
    const release = holdModel()
    h.state.responses = ['First answer.']
    const first = handleChat(win, 'first message', 'free')
    await tick()

    const second = await handleChat(win, 'second message', 'free')
    expect(second).toBe(false)
    // Refused silently: an error event would mark the RUNNING answer as failed.
    expect(h.sends.some((s) => s.channel === 'openui:chat:error')).toBe(false)

    release()
    expect(await first).toBe(true)
    expect(h.ollamaChat).toHaveBeenCalledTimes(1)
    expect(h.store.messages.map((m) => m.content)).toEqual(['first message', 'First answer.'])
  })

  it('applies New chat pressed mid-answer once the answer ends, so nothing bleeds across', async () => {
    const newChat = h.ipc.get('openui:clear-history') as () => void
    const release = holdModel()
    h.state.responses = ['The code is PEAR.']
    const first = handleChat(win, 'Remember the code PEAR.', 'free')
    await tick()
    newChat()
    release()
    await first
    // The old turn still finished into ITS conversation…
    expect(h.store.messages.filter((m) => m.conversationId === 'conv-1')).toHaveLength(2)

    // …and the next message starts a new one that cannot see it.
    h.ollamaChat.mockClear()
    h.state.responses = ['Hello.']
    await handleChat(win, 'hi', 'free')
    expect(h.store.convSeq).toBe(2)
    expect(lastModelContext()).not.toContain('PEAR')
  })

  it('a turn that fails after New chat leaves no holes in the new chat', async () => {
    const newChat = h.ipc.get('openui:clear-history') as () => void
    h.state.responses = ['KIWI-TWO']
    await handleChat(win, 'KIWI-ONE', 'free')

    const release = holdModel()
    h.state.fail = true
    const failing = handleChat(win, 'this one fails', 'free')
    await tick()
    newChat()
    release()
    await failing
    expect(h.sends.some((s) => s.channel === 'openui:chat:error')).toBe(true)

    // Before the fix the rollback re-grew the cleared history to its old
    // length with empty slots, and the next turn crashed reading `.role`.
    h.sends.length = 0
    h.ollamaChat.mockClear()
    h.state.responses = ['Fresh start.']
    expect(await handleChat(win, 'new chat message', 'free')).toBe(true)
    expect(h.sends.some((s) => s.channel === 'openui:chat:error')).toBe(false)
    expect(lastModelContext()).not.toContain('KIWI')
    expect(lastModelContext()).toContain('new chat message')
  })
})

describe('contextForModel — bounded, valid window', () => {
  const mk = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }) as Message)

  it('returns the transcript unchanged when within the cap', () => {
    const msgs = mk(10)
    expect(contextForModel(msgs)).toBe(msgs)
  })

  it('caps to at most MAX_CONTEXT_MESSAGES and starts on a user turn', () => {
    const msgs = mk(MAX_CONTEXT_MESSAGES * 3)
    const win = contextForModel(msgs)
    expect(win.length).toBeLessThanOrEqual(MAX_CONTEXT_MESSAGES)
    expect(win[0].role).toBe('user')
    // It keeps the MOST RECENT messages (the last one is preserved).
    expect(win[win.length - 1]).toBe(msgs[msgs.length - 1])
  })

  it('preserves strict user/assistant alternation in the window', () => {
    const win = contextForModel(mk(MAX_CONTEXT_MESSAGES * 2 + 1))
    for (let i = 0; i < win.length; i++) {
      expect(win[i].role).toBe(i % 2 === 0 ? 'user' : 'assistant')
    }
  })
})
