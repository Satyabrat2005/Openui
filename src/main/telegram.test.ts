import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  isValidBotToken,
  isValidChatId,
  telegramPath,
  extractMessage,
  describeChat,
  formatChats,
  formatMessages,
  getTelegramToken,
  send_telegram_message,
  read_telegram_messages,
  list_telegram_chats
} from './telegram'

// node:https is mocked so the transport tests can assert the exact request BODY
// the Bot API receives (mirrors figma.test.ts). Every other test in this file
// fails validation or the token gate before reaching the network.
const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }))
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => httpsRequestMock(...args)
}))

// A syntactically valid BotFather token (bot_id : 35-char secret). Not a real one.
const GOOD_TOKEN = '123456789:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLL'

// The async tool tests exercise the pure validation + token gate that runs
// BEFORE any network call, so no HTTP mock is needed. TELEGRAM_BOT_TOKEN is
// cleared so the "no token" branch is deterministic regardless of the dev's env.
const savedToken = process.env.TELEGRAM_BOT_TOKEN

beforeEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = savedToken
})

describe('isValidBotToken', () => {
  it('accepts a well-formed BotFather token', () => {
    expect(isValidBotToken(GOOD_TOKEN)).toBe(true)
  })
  it('rejects tokens without the "<id>:<secret>" shape', () => {
    expect(isValidBotToken('')).toBe(false)
    expect(isValidBotToken('nope')).toBe(false)
    expect(isValidBotToken('123:short')).toBe(false)
    expect(isValidBotToken('abc:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLL')).toBe(false)
    // path-injection attempt must not validate
    expect(isValidBotToken('123456789:AAA/../deleteWebhook')).toBe(false)
  })
})

describe('isValidChatId', () => {
  it('accepts positive, negative, and @username ids', () => {
    expect(isValidChatId('123456789')).toBe(true)
    expect(isValidChatId('-1001234567890')).toBe(true)
    expect(isValidChatId('@durov')).toBe(true)
  })
  it('rejects malformed ids', () => {
    expect(isValidChatId('')).toBe(false)
    expect(isValidChatId('12.5')).toBe(false)
    expect(isValidChatId('@a')).toBe(false) // too short
    expect(isValidChatId('not an id')).toBe(false)
    expect(isValidChatId('@bad name')).toBe(false)
  })
})

describe('telegramPath', () => {
  it('builds /bot<token>/<method> for a valid token', () => {
    expect(telegramPath(GOOD_TOKEN, 'sendMessage')).toBe(`/bot${GOOD_TOKEN}/sendMessage`)
  })
  it('throws rather than build a path with a malformed token', () => {
    expect(() => telegramPath('garbage', 'getUpdates')).toThrow(/malformed bot token/)
  })
})

describe('extractMessage', () => {
  it('picks message, edited_message, channel_post, or edited_channel_post', () => {
    const chat = { id: 1 }
    expect(extractMessage({ message: { chat, text: 'a' } })?.text).toBe('a')
    expect(extractMessage({ edited_message: { chat, text: 'b' } })?.text).toBe('b')
    expect(extractMessage({ channel_post: { chat, text: 'c' } })?.text).toBe('c')
    expect(extractMessage({ edited_channel_post: { chat, text: 'd' } })?.text).toBe('d')
    expect(extractMessage({})).toBeNull()
  })
})

describe('describeChat', () => {
  it('uses full name for private chats', () => {
    expect(describeChat({ id: 1, type: 'private', first_name: 'Ada', last_name: 'Lovelace' })).toBe(
      'Ada Lovelace'
    )
  })
  it('uses title for groups/channels', () => {
    expect(describeChat({ id: -100, type: 'supergroup', title: 'Devs' })).toBe('Devs')
  })
  it('falls back to @username then id', () => {
    expect(describeChat({ id: 5, type: 'private', username: 'ada' })).toBe('@ada')
    expect(describeChat({ id: 7 })).toBe('7')
  })
})

describe('formatChats', () => {
  it('explains the empty case (nobody has messaged the bot)', () => {
    const out = formatChats([])
    expect(out).toMatch(/No chats found/)
    expect(out).toMatch(/press Start/)
  })
  it('dedupes by chat id and sorts by most recent activity', () => {
    const out = formatChats([
      { message: { chat: { id: 1, type: 'private', first_name: 'Old' }, date: 100 } },
      { message: { chat: { id: 2, type: 'private', first_name: 'New' }, date: 300 } },
      { message: { chat: { id: 1, type: 'private', first_name: 'Old' }, date: 200 } }
    ])
    // two distinct chats
    expect(out).toMatch(/Chats the bot has seen \(2\)/)
    // "New" (date 300) must come before "Old" (latest 200)
    expect(out.indexOf('New')).toBeLessThan(out.indexOf('Old'))
    expect(out).toMatch(/id: 1/)
    expect(out).toMatch(/id: 2/)
  })
})

describe('formatMessages', () => {
  const updates = [
    { message: { chat: { id: 42, type: 'private' }, from: { first_name: 'Ada' }, date: 100, text: 'first' } },
    { message: { chat: { id: 99, type: 'private' }, from: { first_name: 'Bob' }, date: 150, text: 'other chat' } },
    { message: { chat: { id: 42, type: 'private' }, from: { first_name: 'Ada' }, date: 200, text: 'second' } }
  ]
  it('filters to one chat by numeric id, oldest-first', () => {
    const out = formatMessages(updates, '42', 20)
    expect(out).toMatch(/Last 2 message/)
    expect(out).toContain('first')
    expect(out).toContain('second')
    expect(out).not.toContain('other chat')
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'))
  })
  it('honours the limit (keeps the most recent N)', () => {
    const out = formatMessages(updates, '42', 1)
    expect(out).toMatch(/Last 1 message/)
    expect(out).toContain('second')
    expect(out).not.toContain('first')
  })
  it('matches by @username case-insensitively', () => {
    const out = formatMessages(
      [{ message: { chat: { id: 5, type: 'channel', username: 'MyChan' }, date: 10, text: 'hi' } }],
      '@mychan',
      20
    )
    expect(out).toContain('hi')
  })
  it('renders a placeholder for non-text messages', () => {
    const out = formatMessages(
      [{ message: { chat: { id: 8, type: 'private' }, from: { first_name: 'Z' }, date: 1 } }],
      '8',
      20
    )
    expect(out).toContain('(non-text message)')
  })
  it('explains the empty case', () => {
    expect(formatMessages(updates, '777', 20)).toMatch(/No recent messages found/)
  })
})

describe('getTelegramToken', () => {
  it('falls back to the TELEGRAM_BOT_TOKEN env var', () => {
    process.env.TELEGRAM_BOT_TOKEN = `  ${GOOD_TOKEN}  `
    expect(getTelegramToken()).toBe(GOOD_TOKEN)
  })
  it('returns empty string when nothing is configured', () => {
    expect(getTelegramToken()).toBe('')
  })
})

describe('send_telegram_message (validation gate)', () => {
  it('requires a chat_id', async () => {
    const r = await send_telegram_message({ text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a "chat_id"/)
  })
  it('rejects an invalid chat_id', async () => {
    const r = await send_telegram_message({ chat_id: 'not an id', text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid chat_id/)
  })
  it('requires non-empty text', async () => {
    const r = await send_telegram_message({ chat_id: '123', text: '   ' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/non-empty "text"/)
  })
  it('rejects text over the 4096-char limit', async () => {
    const r = await send_telegram_message({ chat_id: '123', text: 'x'.repeat(4097) })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/4096-character limit/)
  })
  it('reports a missing token once validation passes', async () => {
    const r = await send_telegram_message({ chat_id: '123456789', text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No Telegram bot token configured/)
  })
  it('reports a malformed configured token', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'garbage'
    const r = await send_telegram_message({ chat_id: '123456789', text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/malformed/)
  })
})

describe('read_telegram_messages (validation gate)', () => {
  it('requires a chat_id', async () => {
    const r = await read_telegram_messages({})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/requires a "chat_id"/)
  })
  it('rejects an invalid chat_id', async () => {
    const r = await read_telegram_messages({ chat_id: 'nope!' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid chat_id/)
  })
  it('rejects a non-positive limit', async () => {
    const r = await read_telegram_messages({ chat_id: '123', limit: 0 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/positive integer/)
  })
})

// ── transport: what actually goes on the wire ────────────────────────────────
//
// These are the regression guards for two defects that are invisible to the
// pure-function tests because they live in the request PARAMETERS, not in the
// formatting of the response.

describe('getUpdates request parameters', () => {
  /** Capture the JSON bodies https.request is asked to write. */
  function captureBodies(responseBody: string): { bodies: Record<string, unknown>[] } {
    const captured: Record<string, unknown>[] = []
    httpsRequestMock.mockImplementation((_opts: unknown, cb: (res: EventEmitter) => void) => {
      const req = Object.assign(new EventEmitter(), {
        write: (chunk: string): void => {
          captured.push(JSON.parse(chunk) as Record<string, unknown>)
        },
        destroy: (): void => {},
        setTimeout: (): void => {},
        end: (): void => {
          setImmediate(() => {
            const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
            cb(res)
            setImmediate(() => {
              res.emit('data', Buffer.from(responseBody))
              res.emit('end')
            })
          })
        }
      })
      return req
    })
    return { bodies: captured }
  }

  beforeEach(() => {
    httpsRequestMock.mockReset()
    process.env.TELEGRAM_BOT_TOKEN = GOOD_TOKEN
  })

  const emptyUpdates = JSON.stringify({ ok: true, result: [] })

  // THE BUG: getUpdates with no offset returns the EARLIEST unconfirmed updates.
  // Both read tools promise recent activity, so on a bot with a queue longer than
  // the page size they returned stale data and missed the newest messages — the
  // exact case an active account (i.e. a live demo) hits. A negative offset reads
  // from the END of the queue, and unlike a positive one does not confirm/consume.
  it('list_telegram_chats asks for the TAIL of the queue, not the head', async () => {
    const { bodies } = captureBodies(emptyUpdates)
    await list_telegram_chats()
    expect(bodies).toHaveLength(1)
    expect(bodies[0].offset).toBe(-100)
    expect(bodies[0].limit).toBe(100)
    // timeout 0 keeps it a plain poll rather than a long-poll that blocks the tool.
    expect(bodies[0].timeout).toBe(0)
  })

  it('read_telegram_messages asks for the TAIL of the queue, not the head', async () => {
    const { bodies } = captureBodies(emptyUpdates)
    await read_telegram_messages({ chat_id: '123456789' })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].offset).toBe(-100)
  })

  it('never sends a positive offset (which would consume the update queue)', async () => {
    const { bodies } = captureBodies(emptyUpdates)
    await list_telegram_chats()
    await read_telegram_messages({ chat_id: '123456789', limit: 5 })
    for (const body of bodies) {
      expect(Number(body.offset)).toBeLessThan(0)
    }
  })
})

describe('send_telegram_message threading', () => {
  function captureSend(): { bodies: Record<string, unknown>[] } {
    const captured: Record<string, unknown>[] = []
    httpsRequestMock.mockImplementation((_opts: unknown, cb: (res: EventEmitter) => void) => {
      const req = Object.assign(new EventEmitter(), {
        write: (chunk: string): void => {
          captured.push(JSON.parse(chunk) as Record<string, unknown>)
        },
        destroy: (): void => {},
        setTimeout: (): void => {},
        end: (): void => {
          setImmediate(() => {
            const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
            cb(res)
            setImmediate(() => {
              res.emit('data', Buffer.from(JSON.stringify({ ok: true, result: { message_id: 42 } })))
              res.emit('end')
            })
          })
        }
      })
      return req
    })
    return { bodies: captured }
  }

  beforeEach(() => {
    httpsRequestMock.mockReset()
    process.env.TELEGRAM_BOT_TOKEN = GOOD_TOKEN
  })

  it('sends a plain message with no reply_parameters by default', async () => {
    const { bodies } = captureSend()
    const r = await send_telegram_message({ chat_id: '123456789', text: 'hi' })
    expect(r.ok).toBe(true)
    expect(bodies[0]).toMatchObject({ chat_id: '123456789', text: 'hi' })
    expect(bodies[0].reply_parameters).toBeUndefined()
  })

  // Telegram deprecated the flat reply_to_message_id in favour of ReplyParameters,
  // so the wire format must be the object even though the tool argument is flat.
  it('translates reply_to_message_id into a reply_parameters object', async () => {
    const { bodies } = captureSend()
    const r = await send_telegram_message({
      chat_id: '123456789',
      text: 'answering',
      reply_to_message_id: 7
    })
    expect(r.ok).toBe(true)
    expect(bodies[0].reply_parameters).toEqual({ message_id: 7 })
    // allow_sending_without_reply is deliberately unset: a threaded reply whose
    // target vanished should fail, not silently land as a contextless message.
    expect(bodies[0].allow_sending_without_reply).toBeUndefined()
  })

  it('rejects a non-integer reply_to_message_id before any network call', async () => {
    const { bodies } = captureSend()
    const r = await send_telegram_message({
      chat_id: '123456789',
      text: 'hi',
      reply_to_message_id: 'not-a-number'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/positive integer message id/)
    expect(bodies).toHaveLength(0)
  })
})

describe('formatMessages exposes message ids', () => {
  // Without the id in the transcript there is no way to obtain one, so the model
  // could read a thread but never reply into it.
  it('prints the id needed for an in-thread reply', () => {
    const out = formatMessages(
      [{ message: { message_id: 99, date: 1, text: 'ping', chat: { id: 5, type: 'private', first_name: 'Ada' } } }],
      '5',
      10
    )
    expect(out).toMatch(/#99/)
    expect(out).toMatch(/Ada: ping/)
  })
})
