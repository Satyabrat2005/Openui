import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  read_telegram_messages
} from './telegram'

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
