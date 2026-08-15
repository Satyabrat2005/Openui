/**
 * channelMemory.live.test.ts — does a REAL model actually use the memory?
 *
 * agent.channelMemory.test.ts proves the fact reaches the model's context. That
 * is necessary but not sufficient: the remaining question is behavioural — with
 * the block present does the model USE the fact, and with it absent does it
 * admit ignorance rather than inventing a time?
 *
 * A mocked transport cannot answer that, so this file talks to the local Ollama
 * model the app actually ships on. It is therefore NOT part of the default
 * suite (vitest.config.ts is explicit that the unit tests mock the network) and
 * is skipped unless you opt in:
 *
 *   OPENUI_LIVE_MODEL=1 npx vitest run src/main/channelMemory.live.test.ts
 *
 * Requires `ollama serve` to be up with the general model pulled. Results are
 * indicative, not exact: temperature is pinned to 0 but a local model is still
 * free to phrase things differently between versions.
 */
import { describe, it, expect, vi } from 'vitest'
import type { MemoryRow } from './database'

vi.mock('./database', () => ({ database: { memory: { findMemories: vi.fn(() => []) } } }))

import { renderMemoryBlock } from './channelMemory'

const LIVE = process.env.OPENUI_LIVE_MODEL === '1'
const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const MODEL = process.env.OPENUI_LIVE_MODEL_NAME ?? 'qwen3.5:latest'

/** The memory a real WhatsApp send would have written (see summarizeChannelAction). */
const STORED: MemoryRow = {
  id: 'm1',
  subject_key: 'ashu',
  subject_label: 'Ashu',
  channel: 'whatsapp',
  action: 'send_whatsapp_message',
  direction: 'sent',
  summary: 'Sent a WhatsApp message to Ashu: "The design review moved to Thursday 4pm"',
  created_at: Math.floor(Date.now() / 1000) - 3600
}

/**
 * A cut-down stand-in for the app's system prompt: same tool-call protocol and
 * the one tool this turn needs. The full 133-schema prompt is captured from the
 * running app by the eval harness; reproducing it here would drift.
 */
const BASE_PROMPT = [
  'You are OpenUI, a desktop assistant that automates the user\'s computer.',
  '',
  'To use a tool, reply with ONLY a JSON object as the whole message:',
  '{"tool": "<name>", "args": {...}}',
  'No prose, no code fences. Otherwise reply in plain language.',
  '',
  'Available tools:',
  '- send_slack_message(channel: string, text: string) — post a message to a Slack channel.'
].join('\n')

const QUESTION = 'post in #eng on slack what I told Ashu about the design review'

interface ChatResponse {
  message?: { content?: string }
}

/** One non-streaming chat completion at temperature 0. */
async function ask(system: string, user: string): Promise<string> {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { temperature: 0, seed: 0, num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as ChatResponse
  return body.message?.content ?? ''
}

/** True when the reply commits to the remembered time in any plausible form. */
function statesTheFact(reply: string): boolean {
  const flat = reply.toLowerCase().replace(/\s+/g, ' ')
  return flat.includes('thursday') && /4\s*(pm|:00)/.test(flat)
}

describe.skipIf(!LIVE)('LIVE: a real local model and the memory block', () => {
  it('uses the remembered WhatsApp fact when composing the Slack post', async () => {
    const withMemory = BASE_PROMPT + renderMemoryBlock([STORED])
    const reply = await ask(withMemory, QUESTION)
    console.log('\n--- WITH memory ---\n' + reply + '\n')

    expect(statesTheFact(reply)).toBe(true)
  }, 180_000)

  it('does NOT invent a time when the memory block is absent', async () => {
    // The vacuity control at the behavioural level. A failure here is a real
    // finding about the model (it hallucinated), not a broken test — report it
    // rather than loosening the assertion.
    const reply = await ask(BASE_PROMPT, QUESTION)
    console.log('\n--- WITHOUT memory ---\n' + reply + '\n')

    expect(statesTheFact(reply)).toBe(false)
  }, 180_000)

  it('declines to answer a question the memory block does not cover', async () => {
    // The anti-hallucination clause has to hold even WITH a block present:
    // having one memory must not license guessing about a different contact.
    const withMemory = BASE_PROMPT + renderMemoryBlock([STORED])
    const reply = await ask(withMemory, 'what time did I tell Priya her interview is?')
    console.log('\n--- unrelated question, memory present ---\n' + reply + '\n')

    // It must not manufacture a time for Priya out of Ashu's memory.
    expect(/priya[^.]*\b\d{1,2}\s*(pm|am|:\d{2})/i.test(reply)).toBe(false)
  }, 180_000)
})
