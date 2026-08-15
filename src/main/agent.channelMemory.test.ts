/**
 * agent.channelMemory.test.ts — the cross-channel memory story, end to end.
 *
 * This is the test the feature exists to pass:
 *
 *   1. The user has OpenUI send something on WHATSAPP.
 *   2. In a FRESH conversation, the user asks about it while working on SLACK.
 *   3. The fact from step 1 reaches the model — it is in the context the model
 *      is actually called with.
 *
 * The two controls are what make it non-vacuous, and neither is optional:
 *
 *   • clearHistory() between the turns. Without it the fact would still be in
 *     the conversation transcript and the test would pass with the memory layer
 *     ripped out — it would be measuring chat history, not memory.
 *   • The "memory store empty" run at the end asserts the SAME turn-2 prompt
 *     does NOT contain the fact. That is the failing half: the feature is what
 *     moves this assertion, and if someone deletes the write hook this file
 *     goes red rather than quietly still passing.
 *
 * The model transport is mocked at the Ollama boundary and `./database` is
 * backed by a REAL in-memory memory store, so recordMemory/findMemories run
 * their actual logic (dedupe, ranking, rendering) rather than being stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const state = { responses: [] as string[] }
  interface MemRow {
    id: string
    subject_key: string
    subject_label: string
    channel: string
    action: string
    direction: string
    summary: string
    created_at: number
  }
  // A real (if tiny) memory store: the repo's SQL semantics reimplemented over
  // an array, so the layer under test does its own work. The SQL itself is
  // covered against real SQLite in database/repositories/repositories.test.ts.
  const mem = {
    rows: [] as MemRow[],
    seq: 0
  }
  return {
    state,
    mem,
    sends: [] as Array<{ channel: string; args: unknown[] }>,
    ipc: new Map<string, (...a: unknown[]) => unknown>(),
    // Typed to the full ToolResult shape so a per-test override can return a
    // failure (ok:false + error) without widening the inferred success type.
    executeTool: vi.fn(
      async (): Promise<{ ok: boolean; output?: string; error?: string }> => ({
        ok: true,
        output: 'Message sent.'
      })
    ),
    ollamaChat: vi.fn(async (_arg: unknown) => {
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
  executeTool: h.executeTool,
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
      createConversation: vi.fn(() => `conv-${Date.now()}-${Math.random()}`),
      getConversationsByUser: vi.fn(() => [])
    },
    messages: { addMessage: vi.fn(() => 'msg'), getMessagesByConversation: vi.fn(() => []) },
    feedback: { applySignalToLast: vi.fn(), recordTurn: vi.fn(), setExplicitRatingOnLast: vi.fn() },
    settings: { getSetting: vi.fn(() => undefined) },
    training: { getStats: vi.fn(() => ({ total: 0 })) },
    memory: {
      recordMemory: vi.fn((input: Record<string, string>) => {
        const dup = h.mem.rows.find(
          (r) =>
            r.subject_key === input.subjectKey &&
            r.channel === input.channel &&
            r.action === input.action &&
            r.summary === input.summary
        )
        if (dup) return dup.id
        const id = `mem-${++h.mem.seq}`
        h.mem.rows.push({
          id,
          subject_key: input.subjectKey,
          subject_label: input.subjectLabel,
          channel: input.channel,
          action: input.action,
          direction: input.direction,
          summary: input.summary,
          created_at: Math.floor(Date.now() / 1000)
        })
        return id
      }),
      // Mirrors the repo: rows under any requested key, plus the recent tail,
      // de-duplicated, newest first.
      findMemories: vi.fn((keys: string[], recentLimit = 40) => {
        const newestFirst = [...h.mem.rows].reverse()
        const byKey = newestFirst.filter((r) => keys.includes(r.subject_key))
        const recent = newestFirst.slice(0, recentLimit)
        const seen = new Set<string>()
        return [...byKey, ...recent].filter((r) => !seen.has(r.id) && seen.add(r.id))
      }),
      listMemories: vi.fn(() => [...h.mem.rows].reverse()),
      deleteMemory: vi.fn(() => true),
      clearSubject: vi.fn(() => 0),
      clearAllMemories: vi.fn(() => 0),
      countMemories: vi.fn(() => h.mem.rows.length)
    }
  }
}))

vi.mock('./stripe/pricing', () => ({ clampTierToEntitlement: (t: string) => t }))
vi.mock('./stripe/subscriptionSync', () => ({ getCurrentUserId: () => null }))
vi.mock('./telemetry/posthog', () => ({ trackEvent: vi.fn() }))
vi.mock('./models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./models')>()),
  resolveGeneralModel: async () => 'qwen3.5:latest',
  resolveOllamaModel: async (preferred: string) => preferred,
  isModelInstalled: async () => true,
  shouldRouteToCloud: () => false,
  resolveCloudModel: () => 'claude-sonnet-5',
  streamAnthropic: vi.fn(async () => 'cloud reply')
}))
vi.mock('./cloudFreeTier', () => ({ emitLocalUsage: vi.fn() }))
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

import { handleChat, clearHistory, registerAgentIPC } from './agent'
import { MEMORY_BLOCK_HEADER, MEMORY_BLOCK_DISCLAIMER } from './channelMemory'

const win = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, ...args: unknown[]) => h.sends.push({ channel, args }) }
} as never

/** Everything the model was sent on its most recent call, system prompt included. */
function lastModelContext(): string {
  const calls = h.ollamaChat.mock.calls
  const arg = calls[calls.length - 1]?.[0] as { messages?: Array<{ content: string }> } | undefined
  return (arg?.messages ?? []).map((m) => m.content).join('\n')
}

/** The fact established on WhatsApp and asked about from Slack. */
const FACT = 'Thursday 4pm'
const WHATSAPP_TURN = 'message Ashu on WhatsApp that the design review moved to Thursday 4pm'
const SLACK_TURN = 'post in #eng on slack what I told Ashu about the design review'

/** Drive the WhatsApp turn: one tool call, then a wrap-up. */
async function sendOnWhatsApp(): Promise<void> {
  h.state.responses = [
    JSON.stringify({
      tool: 'send_whatsapp_message',
      args: { contact: 'Ashu', message: 'The design review moved to Thursday 4pm' }
    }),
    'Sent that to Ashu.'
  ]
  await handleChat(win, WHATSAPP_TURN, 'free')
}

beforeEach(() => {
  clearHistory()
  h.sends.length = 0
  h.state.responses = []
  h.mem.rows.length = 0
  h.mem.seq = 0
  h.ollamaChat.mockClear()
  h.executeTool.mockClear()
  registerAgentIPC(win)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as unknown as Response))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cross-channel memory — WhatsApp → Slack', () => {
  it('writes a memory when a WhatsApp send succeeds', async () => {
    await sendOnWhatsApp()

    expect(h.executeTool).toHaveBeenCalledWith(
      'send_whatsapp_message',
      expect.objectContaining({ contact: 'Ashu' }),
      expect.anything()
    )
    expect(h.mem.rows).toHaveLength(1)
    expect(h.mem.rows[0]).toMatchObject({
      subject_key: 'ashu',
      subject_label: 'Ashu',
      channel: 'whatsapp',
      action: 'send_whatsapp_message',
      direction: 'sent'
    })
    expect(h.mem.rows[0].summary).toContain(FACT)
  })

  it('carries the WhatsApp fact into a fresh Slack turn', async () => {
    await sendOnWhatsApp()

    // New Chat: the transcript that contained the fact is gone. Anything the
    // model knows from here on came from the memory layer.
    clearHistory()
    h.ollamaChat.mockClear()
    h.state.responses = ['Posted it in #eng.']
    await handleChat(win, SLACK_TURN, 'free')

    const context = lastModelContext()
    // The prior turn's transcript really is gone…
    expect(context).not.toContain(WHATSAPP_TURN)
    // …and yet the fact is present, via the MEMORY block.
    expect(context).toContain(MEMORY_BLOCK_HEADER)
    expect(context).toContain(FACT)
    expect(context).toContain('Ashu')
  })

  it('VACUITY CONTROL: the same Slack turn has no fact when memory is empty', async () => {
    await sendOnWhatsApp()
    expect(h.mem.rows).toHaveLength(1)

    // Simulate the user clearing memory in Settings → Memory. This is also
    // exactly the state the codebase would be in with the write hook removed.
    h.mem.rows.length = 0

    clearHistory()
    h.ollamaChat.mockClear()
    h.state.responses = ['I do not have that.']
    await handleChat(win, SLACK_TURN, 'free')

    const context = lastModelContext()
    expect(context).not.toContain(FACT)
    expect(context).not.toContain(MEMORY_BLOCK_HEADER)
  })

  it('instructs the model not to invent facts the memory block does not contain', async () => {
    await sendOnWhatsApp()
    clearHistory()
    h.ollamaChat.mockClear()
    h.state.responses = ['Posted it in #eng.']
    await handleChat(win, SLACK_TURN, 'free')

    // The anti-hallucination clause travels with the block; without it the
    // model reads the block as licence to speculate about other channels.
    expect(lastModelContext()).toContain(MEMORY_BLOCK_DISCLAIMER)
  })

  it('adds nothing to the prompt on a turn with no relevant memory', async () => {
    await sendOnWhatsApp()

    clearHistory()
    h.ollamaChat.mockClear()
    h.state.responses = ['It is sunny.']
    await handleChat(win, 'what is the weather like today', 'free')

    // An unrelated question must not drag in whatever was messaged most
    // recently — that is prompt tax and a privacy leak at once.
    const context = lastModelContext()
    expect(context).not.toContain(MEMORY_BLOCK_HEADER)
    expect(context).not.toContain(FACT)
  })

  it('does not record a memory when the send failed or was denied', async () => {
    h.executeTool.mockImplementationOnce(async () => ({
      ok: false,
      error: 'User denied the action: send a WhatsApp message to Ashu.'
    }))
    h.state.responses = [
      JSON.stringify({
        tool: 'send_whatsapp_message',
        args: { contact: 'Ashu', message: 'The design review moved to Thursday 4pm' }
      }),
      'I could not send that without your approval.'
    ]
    await handleChat(win, WHATSAPP_TURN, 'free')

    // A denied send did not happen. Recording it would let a later turn report
    // it as done — the worst possible failure for a memory feature.
    expect(h.mem.rows).toHaveLength(0)
  })
})
