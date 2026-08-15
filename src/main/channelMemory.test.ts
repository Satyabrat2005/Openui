/**
 * channelMemory.test.ts — the memory layer's own logic, without the agent loop.
 *
 * Covers the three pieces the end-to-end test (agent.channelMemory.test.ts)
 * exercises only in aggregate: what gets written for a given tool call, how
 * candidates are ranked against a question, and how the prompt block renders.
 *
 * `./database` is stubbed here because these functions are pure with respect to
 * it — scoreMemories/renderMemoryBlock take rows as arguments. Only the two
 * store-touching wrappers (recordChannelAction, recallForText) go through the
 * stub, and the real SQL behind it is covered in repositories.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MemoryRow } from './database'
import { database } from './database'

const h = vi.hoisted(() => ({
  recorded: [] as Array<Record<string, string>>,
  found: [] as unknown[]
}))

vi.mock('./database', () => ({
  database: {
    memory: {
      recordMemory: vi.fn((input: Record<string, string>) => {
        h.recorded.push(input)
        return `mem-${h.recorded.length}`
      }),
      findMemories: vi.fn(() => h.found)
    }
  }
}))

import {
  summarizeChannelAction,
  recordChannelAction,
  recallForText,
  scoreMemories,
  renderMemoryBlock,
  normalizeSubject,
  tokenize,
  candidateKeys,
  isChannelAction,
  CHANNEL_ACTIONS,
  MEMORY_BLOCK_HEADER,
  MEMORY_BLOCK_DISCLAIMER,
  MIN_RECALL_SCORE,
  MAX_CONTENT_CHARS
} from './channelMemory'

const ok = { ok: true, output: 'Message sent.' }

/** Build a stored row for the ranking/rendering tests. */
function row(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 'r1',
    subject_key: 'ashu',
    subject_label: 'Ashu',
    channel: 'whatsapp',
    action: 'send_whatsapp_message',
    direction: 'sent',
    summary: 'Sent a WhatsApp message to Ashu: "The design review moved to Thursday 4pm"',
    created_at: 1_700_000_000,
    ...over
  }
}

beforeEach(() => {
  h.recorded.length = 0
  h.found.length = 0
})

describe('normalizeSubject', () => {
  it('strips the sigils that are channel artefacts, not part of the name', () => {
    expect(normalizeSubject('#eng')).toBe('eng')
    expect(normalizeSubject('@ashu')).toBe('ashu')
    expect(normalizeSubject('  Design   Review ')).toBe('design review')
  })

  it('keeps an email address distinct from the bare name', () => {
    // Recall bridges these two by token overlap; the KEY stays unmangled so
    // two different Priyas don't collapse into one subject.
    expect(normalizeSubject('Priya@acme.com')).toBe('priya@acme.com')
    expect(normalizeSubject('Priya')).toBe('priya')
  })
})

describe('summarizeChannelAction', () => {
  it('files a WhatsApp send under the contact, with the message text', () => {
    const input = summarizeChannelAction(
      'send_whatsapp_message',
      { contact: 'Ashu', message: 'The design review moved to Thursday 4pm' },
      ok
    )
    expect(input).toMatchObject({
      subjectKey: 'ashu',
      subjectLabel: 'Ashu',
      channel: 'whatsapp',
      direction: 'sent'
    })
    expect(input?.summary).toContain('Thursday 4pm')
  })

  it('files a Slack post under the channel', () => {
    const input = summarizeChannelAction(
      'send_slack_message',
      { channel: 'eng', text: 'standup at 10' },
      ok
    )
    expect(input?.subjectKey).toBe('eng')
    expect(input?.summary).toContain('#eng')
  })

  it('files an email under the recipient', () => {
    const input = summarizeChannelAction(
      'send_email',
      { to: 'priya@acme.com', subject: 'Q3', body: 'numbers attached' },
      ok
    )
    expect(input?.subjectKey).toBe('priya@acme.com')
    expect(input?.channel).toBe('gmail')
  })

  it('returns null for a failed call — a send that did not happen is not a memory', () => {
    expect(
      summarizeChannelAction(
        'send_whatsapp_message',
        { contact: 'Ashu', message: 'hi' },
        { ok: false, error: 'User denied the action' }
      )
    ).toBeNull()
  })

  it('returns null for tools that are not channel actions', () => {
    expect(summarizeChannelAction('write_file', { path: 'a.txt' }, ok)).toBeNull()
    expect(isChannelAction('write_file')).toBe(false)
    expect(isChannelAction('send_telegram_message')).toBe(true)
  })

  it('returns null when the subject arg is missing or blank', () => {
    expect(summarizeChannelAction('send_whatsapp_message', { message: 'hi' }, ok)).toBeNull()
    expect(
      summarizeChannelAction('send_whatsapp_message', { contact: '   ', message: 'hi' }, ok)
    ).toBeNull()
  })

  it('clips long content so one long email cannot dominate the store', () => {
    const input = summarizeChannelAction(
      'send_email',
      { to: 'a@b.com', body: 'x'.repeat(5000) },
      ok
    )
    expect(input!.summary.length).toBeLessThan(MAX_CONTENT_CHARS + 120)
  })

  it('covers every tool listed in CHANNEL_ACTIONS', () => {
    // A tool added to the map without a working subject arg would silently
    // never record. Drive each one with its own declared subject arg.
    for (const [tool, spec] of Object.entries(CHANNEL_ACTIONS)) {
      const args: Record<string, unknown> = { [spec.subjectArg]: 'Subject' }
      if (spec.contentArg) args[spec.contentArg] = 'content here'
      const input = summarizeChannelAction(tool, args, ok)
      expect(input, `${tool} produced no memory`).not.toBeNull()
      expect(input!.channel).toBe(spec.channel)
      expect(input!.summary.length).toBeGreaterThan(0)
    }
  })
})

describe('recordChannelAction', () => {
  it('writes through to the store for a successful channel action', () => {
    const id = recordChannelAction(
      'send_whatsapp_message',
      { contact: 'Ashu', message: 'later' },
      ok
    )
    expect(id).toBe('mem-1')
    expect(h.recorded).toHaveLength(1)
  })

  it('writes nothing for a non-channel tool', () => {
    expect(recordChannelAction('read_screen', {}, ok)).toBeNull()
    expect(h.recorded).toHaveLength(0)
  })
})

describe('scoreMemories', () => {
  it('ranks a named contact above an unrelated row', () => {
    const rows = [
      row({ id: 'other', subject_key: 'mom', subject_label: 'Mom', summary: 'Sent a WhatsApp message to Mom: "running late"' }),
      row()
    ]
    const scored = scoreMemories(rows, 'what did I tell Ashu about the design review')
    expect(scored[0].row.id).toBe('r1')
    expect(scored.map((s) => s.row.id)).not.toContain('other')
  })

  it('matches an email row by the local part of the address', () => {
    // The cross-form bridge: a Gmail row keyed "priya@acme.com" answers a
    // question that only says "Priya".
    const rows = [
      row({
        id: 'mail',
        subject_key: 'priya@acme.com',
        subject_label: 'priya@acme.com',
        channel: 'gmail',
        summary: 'Sent an email to priya@acme.com: "Q3 numbers attached"'
      })
    ]
    expect(scoreMemories(rows, 'what did I send Priya')).toHaveLength(1)
  })

  it('matches on topic alone when the phrase is contiguous', () => {
    const scored = scoreMemories([row()], 'when is the design review happening')
    expect(scored).toHaveLength(1)
    expect(scored[0].score).toBeGreaterThanOrEqual(MIN_RECALL_SCORE)
  })

  it('does NOT match on two scattered words that never form a phrase', () => {
    // The counterpart to the test above, and the reason the contiguity bonus
    // exists rather than a lower threshold: "moved" and "sent" both appear in
    // the memory, but never adjacently and never as its topic.
    const scored = scoreMemories([row()], 'has the printer moved since you sent it')
    expect(scored).toHaveLength(0)
  })

  it('drops rows that only share stopwords', () => {
    expect(scoreMemories([row()], 'can you do that for me please')).toHaveLength(0)
  })

  it('returns nothing for an unrelated question', () => {
    expect(scoreMemories([row()], 'what is the weather like today')).toHaveLength(0)
  })

  it('breaks ties toward the more recent memory', () => {
    const older = row({ id: 'old', created_at: 1_000 })
    const newer = row({ id: 'new', created_at: 2_000 })
    const scored = scoreMemories([older, newer], 'what did I tell Ashu')
    expect(scored[0].row.id).toBe('new')
  })

  it('scores an empty or stopword-only query as no match', () => {
    expect(scoreMemories([row()], '')).toEqual([])
    expect(scoreMemories([row()], 'the and of it')).toEqual([])
  })
})

describe('candidateKeys', () => {
  it('offers single words and adjacent pairs, so multi-word topics are reachable', () => {
    const keys = candidateKeys('what did I say about the design review')
    expect(keys).toContain('design')
    expect(keys).toContain('design review')
  })

  it('drops stopwords', () => {
    expect(tokenize('what is the weather')).toEqual(['weather'])
  })
})

describe('renderMemoryBlock', () => {
  const now = 1_700_003_600 // one hour after the fixture row

  it('renders nothing at all for no rows, so unrelated prompts are unchanged', () => {
    expect(renderMemoryBlock([], now)).toBe('')
  })

  it('labels the channel and the age, and carries the anti-hallucination clause', () => {
    const block = renderMemoryBlock([row()], now)
    expect(block).toContain(MEMORY_BLOCK_HEADER)
    expect(block).toContain('WhatsApp')
    expect(block).toContain('1h ago')
    expect(block).toContain('Thursday 4pm')
    expect(block).toContain(MEMORY_BLOCK_DISCLAIMER)
  })

  it('never opens with a bare capitalised keyword that reads as a tool name', () => {
    // Regression: the first version headed the block "MEMORY — …" and the local
    // model replied {"tool": "MEMORY", "args": {}} — it sits just below
    // "Available tools:" in the prompt, so a lone all-caps word looked like one.
    const block = renderMemoryBlock([row()], now)
    const firstLine = block.split('\n').filter((l) => l.trim())[0]
    expect(firstLine).not.toMatch(/^[A-Z]{3,}\b/)
    expect(block).toContain('never emit one as a tool call')
  })

  it('stays small enough not to eat the prompt budget', () => {
    // The local free-tier model runs at num_ctx 8192 with a 3.9–6.8k prompt, so
    // memory has to fit in what is left. Four maximally long rows is the worst
    // case MAX_RECALL_ENTRIES allows: ~1050 chars of rows on top of ~390 chars
    // of fixed instructions, i.e. roughly 375 tokens. The instruction half does
    // not grow with the number of rows, and both of its clauses are load-bearing
    // (a live model called the block as a tool without one, and speculated
    // without the other), so the ceiling is set above them rather than trimming.
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ id: `r${i}`, summary: `Sent a WhatsApp message to Ashu: "${'x'.repeat(200)}"` })
    )
    expect(renderMemoryBlock(rows, now).length).toBeLessThan(1500)
  })

  it('keeps the fixed instruction overhead small when only one thing is recalled', () => {
    // The common case. A single short memory must not drag 400 chars of
    // boilerplate behind it on every messaging turn.
    expect(renderMemoryBlock([row()], now).length).toBeLessThan(600)
  })
})

describe('recallForText', () => {
  it('returns the ranked rows the store offers', () => {
    h.found.push(row())
    expect(recallForText('what did I tell Ashu about the design review')).toHaveLength(1)
  })

  it('degrades to no memory rather than throwing when the store fails', () => {
    h.found.push(row())
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(database.memory.findMemories).mockImplementationOnce(() => {
      throw new Error('db is gone')
    })
    expect(recallForText('what did I tell Ashu')).toEqual([])
    spy.mockRestore()
  })
})
