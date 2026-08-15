/**
 * contacts.test.ts — the contact-identity layer in isolation, before anything
 * is built on top of it.
 *
 * Run against a REAL (temp-file) SQLite database through the same schema.ts +
 * migrations.ts the app applies, not a stub: the UNIQUE(channel, handle_key)
 * constraint is half of the correctness argument here (one handle, one owner),
 * and a hand-written fake would not enforce it.
 *
 * The load-bearing test is `the Telegram gap`: it takes a real Telegram message
 * fixture and shows the SAME person-scoped question fails to match it before the
 * one-time link exists and matches it after — nothing else about the message,
 * the query, or the code changes between the two halves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDb, type TempDb } from './database/repositories/__support__/tempDb'

const holder = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('./database/init', () => ({
  getDb: () => holder.current,
  initDb: () => holder.current
}))

import { applySchema } from './database/schema'
import { runMigrations } from './database/migrations'
import { database } from './database'
import {
  normalizeName,
  normalizeHandle,
  validateHandle,
  resolveContact,
  handleForChannel,
  emailForContact,
  linkIdentity,
  describeContact,
  explainUnresolved,
  isIdentityChannel,
  contactToolSchemas,
  contactRegistry,
  NAME_BEARING_CHANNELS,
  IDENTITY_CHANNELS,
  MAX_IDENTITY_CHARS
} from './contacts'

let temp: TempDb

beforeEach(() => {
  temp = createTempDb()
  holder.current = temp.db
  applySchema()
  runMigrations()
})

afterEach(() => {
  temp.cleanup()
  holder.current = null
})

/** Resolve and assert it worked, so the callers below stay readable. */
function resolved(query: string): ReturnType<typeof resolveContact> & { status: 'resolved' } {
  const r = resolveContact(query)
  if (r.status !== 'resolved') throw new Error(`expected "${query}" to resolve, got ${r.status}`)
  return r
}

describe('normalization', () => {
  it('collapses names to a stable key', () => {
    expect(normalizeName('  Ashu   Kumar ')).toBe('ashu kumar')
    expect(normalizeName('@Ashu')).toBe('ashu')
  })

  it('keeps a Telegram group id negative but strips a username sigil', () => {
    // The sign distinguishes a group from a user — mangling it points the read
    // at a different chat entirely.
    expect(normalizeHandle('telegram', '-1001234567890')).toBe('-1001234567890')
    expect(normalizeHandle('telegram', '@AshuChannel')).toBe('ashuchannel')
  })

  it('treats Slack "#eng"/"@ashu" and Gmail casing as the same handle', () => {
    expect(normalizeHandle('slack', '#Eng')).toBe('eng')
    expect(normalizeHandle('slack', '@Ashu')).toBe('ashu')
    expect(normalizeHandle('gmail', 'Ashu@Acme.COM')).toBe('ashu@acme.com')
  })

  it('recognises exactly the four supported channels', () => {
    for (const c of IDENTITY_CHANNELS) expect(isIdentityChannel(c)).toBe(true)
    expect(isIdentityChannel('discord')).toBe(false)
    expect(isIdentityChannel('')).toBe(false)
  })
})

describe('handle validation', () => {
  it('rejects a Telegram handle that is a person\'s name', () => {
    // The exact mistake the link exists to prevent: this would be stored happily
    // and then fail on every read, with the user believing they had linked it.
    const err = validateHandle('telegram', 'Ashu')
    expect(err).toBeTruthy()
    expect(err).toMatch(/numeric id/i)
  })

  it('accepts real Telegram id forms', () => {
    expect(validateHandle('telegram', '123456789')).toBeNull()
    expect(validateHandle('telegram', '-1001234567890')).toBeNull()
    expect(validateHandle('telegram', '@ashuchannel')).toBeNull()
  })

  it('rejects a Gmail handle that is not an address', () => {
    expect(validateHandle('gmail', 'Ashu')).toMatch(/not an email address/i)
    expect(validateHandle('gmail', 'ashu@acme.com')).toBeNull()
  })

  it('rejects an empty or oversized handle on every channel', () => {
    for (const channel of IDENTITY_CHANNELS) {
      expect(validateHandle(channel, '   ')).toMatch(/empty/i)
      expect(validateHandle(channel, 'a'.repeat(MAX_IDENTITY_CHARS + 1))).toMatch(/too long/i)
    }
  })
})

describe('resolution', () => {
  it('returns unknown for a person who was never linked', () => {
    expect(resolveContact('Ashu').status).toBe('unknown')
  })

  it('resolves by exact name, by handle, and by a unique partial name', () => {
    linkIdentity({ name: 'Ashu Kumar', channel: 'gmail', handle: 'ashu@acme.com' })

    expect(resolved('Ashu Kumar').contact.display_name).toBe('Ashu Kumar')
    expect(resolved('ashu@acme.com').contact.display_name).toBe('Ashu Kumar')
    expect(resolved('Ashu').contact.display_name).toBe('Ashu Kumar')
    expect(resolved('Kumar').contact.display_name).toBe('Ashu Kumar')
  })

  it('reports ambiguity instead of picking a winner', () => {
    linkIdentity({ name: 'Ashu Kumar', channel: 'gmail', handle: 'ashu.k@acme.com' })
    linkIdentity({ name: 'Ashu Mehta', channel: 'gmail', handle: 'ashu.m@acme.com' })

    const r = resolveContact('Ashu')
    expect(r.status).toBe('ambiguous')
    if (r.status !== 'ambiguous') throw new Error('unreachable')
    expect(r.candidates.map((c) => c.display_name).sort()).toEqual(['Ashu Kumar', 'Ashu Mehta'])
    expect(explainUnresolved(r, 'Ashu')).toMatch(/more than one contact/i)
  })

  it('does not match on a partial token — "ash" is not "ashu"', () => {
    linkIdentity({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })
    expect(resolveContact('ash').status).toBe('unknown')
    expect(resolveContact('Ashley').status).toBe('unknown')
  })
})

describe('channel handles', () => {
  it('falls back to the display name only on the name-bearing channels', () => {
    linkIdentity({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })
    const ashu = resolved('Ashu')

    for (const channel of NAME_BEARING_CHANNELS) {
      expect(handleForChannel(ashu, channel)).toEqual({ handle: 'Ashu', source: 'display-name' })
    }
    // Telegram has no fallback: a chat_id of "Ashu" would read an imaginary chat
    // and report nothing found, which is indistinguishable from "he said nothing".
    expect(handleForChannel(ashu, 'telegram')).toBeNull()
  })

  it('prefers an explicit link over the display-name fallback', () => {
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu (work)' })
    expect(handleForChannel(resolved('Ashu'), 'whatsapp')).toEqual({
      handle: 'Ashu (work)',
      source: 'link'
    })
  })

  it('has no email until one is linked', () => {
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })
    expect(emailForContact(resolved('Ashu'))).toBeNull()

    linkIdentity({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })
    expect(emailForContact(resolved('Ashu'))).toBe('ashu@acme.com')
  })
})

describe('the Telegram gap — the reason this layer exists', () => {
  // A real getUpdates-shaped message: the chat carries an id and NOTHING that
  // names the person. This is the fixture both halves below run against.
  const telegramMessage = { chat_id: '123456789', text: 'pushed the fix, can you review?' }

  /**
   * The person-scoped question, expressed exactly as the summary layer will ask
   * it: resolve who "him" is, get their Telegram handle, and keep the message
   * only if the handle matches the chat it arrived in.
   */
  function messagesFromPerson(query: string): typeof telegramMessage[] {
    const r = resolveContact(query)
    if (r.status !== 'resolved') return []
    const handle = handleForChannel(r, 'telegram')
    if (!handle) return []
    return [telegramMessage].filter((m) => m.chat_id === handle.handle)
  }

  it('fails to match the message before the link exists', () => {
    // Ashu is a known person on other channels — so this is not "nobody called
    // Ashu"; it is specifically that Telegram carries no name to match on.
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })
    expect(resolveContact('Ashu').status).toBe('resolved')

    expect(messagesFromPerson('Ashu')).toEqual([])
  })

  it('matches the same message, with the same query, after the one-time link', () => {
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })
    linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })

    expect(messagesFromPerson('Ashu')).toEqual([telegramMessage])
  })

  it('still refuses to guess for an unlinked person', () => {
    linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
    // Priya exists and has an email, but no Telegram link — the chat must NOT be
    // attributed to her just because she is the only other person around.
    linkIdentity({ name: 'Priya', channel: 'gmail', handle: 'priya@acme.com' })

    expect(messagesFromPerson('Priya')).toEqual([])
  })
})

describe('linking', () => {
  it('moves a handle rather than leaving two owners', () => {
    linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
    linkIdentity({ name: 'Priya', channel: 'telegram', handle: '123456789' })

    expect(handleForChannel(resolved('Ashu'), 'telegram')).toBeNull()
    expect(handleForChannel(resolved('Priya'), 'telegram')?.handle).toBe('123456789')
    // Exactly one row can claim the handle, so resolution can never be ambiguous.
    expect(resolved('123456789').contact.display_name).toBe('Priya')
  })

  it('keeps the display name the user first chose', () => {
    linkIdentity({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })
    linkIdentity({ name: 'ashu', channel: 'telegram', handle: '123456789' })
    expect(resolved('Ashu').contact.display_name).toBe('Ashu')
    expect(database.contacts.countContacts()).toBe(1)
  })

  it('records one person across all four channels', () => {
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })
    linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
    linkIdentity({ name: 'Ashu', channel: 'slack', handle: 'U024BE7LH' })
    linkIdentity({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })

    const r = resolved('Ashu')
    expect(r.identities.map((i) => i.channel).sort()).toEqual([
      'gmail',
      'slack',
      'telegram',
      'whatsapp'
    ])
    expect(describeContact(r)).toContain('Telegram: 123456789')
  })

  it('refuses a malformed handle instead of storing it', () => {
    const r = linkIdentity({ name: 'Ashu', channel: 'telegram', handle: 'Ashu' })
    expect(r.ok).toBe(false)
    expect(database.contacts.countContacts()).toBe(0)
  })
})

describe('tools', () => {
  it('every schema has an executor and vice versa', () => {
    expect(contactToolSchemas.map((s) => s.name).sort()).toEqual(Object.keys(contactRegistry).sort())
  })

  it('link_contact then list_contacts round-trips', async () => {
    const link = await contactRegistry.link_contact({
      name: 'Ashu',
      channel: 'telegram',
      handle: '123456789'
    })
    expect(link.ok).toBe(true)
    expect(link.output).toContain('Ashu')

    const list = await contactRegistry.list_contacts({})
    expect(list.output).toContain('Telegram: 123456789')
  })

  it('list_contacts says so when nothing is linked', async () => {
    const list = await contactRegistry.list_contacts({})
    expect(list.ok).toBe(true)
    expect(list.output).toMatch(/no contacts are linked/i)
  })

  it('link_contact rejects an unsupported channel', async () => {
    const r = await contactRegistry.link_contact({
      name: 'Ashu',
      channel: 'discord',
      handle: 'ashu#1234'
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/channel/i)
  })

  it('unlink_contact removes one channel, then the person', async () => {
    await contactRegistry.link_contact({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
    await contactRegistry.link_contact({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })

    const one = await contactRegistry.unlink_contact({ name: 'Ashu', channel: 'telegram' })
    expect(one.ok).toBe(true)
    expect(handleForChannel(resolved('Ashu'), 'telegram')).toBeNull()
    expect(emailForContact(resolved('Ashu'))).toBe('ashu@acme.com')

    const all = await contactRegistry.unlink_contact({ name: 'Ashu' })
    expect(all.ok).toBe(true)
    expect(resolveContact('Ashu').status).toBe('unknown')
    // The handle must not survive its owner and keep resolving to a ghost.
    expect(resolveContact('ashu@acme.com').status).toBe('unknown')
  })

  it('unlink_contact refuses an unknown person rather than silently succeeding', async () => {
    const r = await contactRegistry.unlink_contact({ name: 'Nobody' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no contact named/i)
  })
})
