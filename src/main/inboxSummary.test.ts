/**
 * inboxSummary.test.ts — the cross-channel read and the summary-to-email action.
 *
 * The four channel reads are INJECTED (see InboxDeps), so these tests exercise
 * the real assembly logic — identity resolution, per-channel status, attribution
 * — against seeded messages instead of a Slack workspace, a Telegram bot, a
 * Gmail grant and a WhatsApp window that this environment does not have. Contact
 * identity and the settings gate run against a real temp SQLite database,
 * because both are the thing under test rather than scaffolding.
 *
 * The two load-bearing tests:
 *   • `draws from every channel the person is reachable on` — a person seeded
 *     across four channels must appear from all four, not the first one that hit.
 *   • `the Telegram and Gmail gap` — the SAME seeded messages are invisible
 *     before the one-time link and visible after, with nothing else changed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDb, type TempDb } from './database/repositories/__support__/tempDb'

const holder = vi.hoisted(() => ({ current: null as unknown }))
const gmailStub = vi.hoisted(() => ({
  connected: true,
  sent: [] as Array<{ to: string[]; subject?: string; body: string }>,
  result: { ok: true, output: 'Sent.' } as { ok: boolean; output?: string; error?: string }
}))

vi.mock('./database/init', () => ({
  getDb: () => holder.current,
  initDb: () => holder.current
}))

// Only the SEND path reaches the real gmail module (the read path is injected),
// so this stub exists to prove sendSummaryEmail's resolution and refusal
// behaviour without an OAuth grant.
vi.mock('./gmail', () => ({
  isGmailConnected: () => gmailStub.connected,
  findEmailThread: async () => ({ ok: true, candidates: [] }),
  sendGmailMessage: async (input: { to: string[]; subject?: string; body: string }) => {
    gmailStub.sent.push(input)
    return gmailStub.result
  }
}))

import { applySchema } from './database/schema'
import { runMigrations } from './database/migrations'
import { database } from './database'
import { linkIdentity } from './contacts'
import {
  summarizeInbox,
  sendSummaryEmail,
  resolveRecipient,
  emailAddressOf,
  isUnifiedInboxEnabled,
  inboxToolSchemas,
  inboxRegistry,
  UNIFIED_INBOX_SETTING_KEY,
  GATE_MESSAGE,
  type InboxDeps,
  type InboxSummaryData,
  type ChannelRead,
  type ChannelScope,
  type ChannelReport,
  type RawItem
} from './inboxSummary'
import type { IdentityChannel } from './contacts'

let temp: TempDb

beforeEach(() => {
  temp = createTempDb()
  holder.current = temp.db
  applySchema()
  runMigrations()
  gmailStub.connected = true
  gmailStub.sent = []
  gmailStub.result = { ok: true, output: 'Sent.' }
})

afterEach(() => {
  temp.cleanup()
  holder.current = null
})

function enableInbox(): void {
  database.settings.setSetting(UNIFIED_INBOX_SETTING_KEY, true)
}

// ── seeded channel data ─────────────────────────────────────────────────────
//
// One person — Ashu — who has said something on all four surfaces, each keyed
// the way that surface actually keys people: a chat name, a numeric chat_id, a
// Slack user id, an email address. Plus one message from someone else, so a
// person-scoped read has something it must NOT return.

const SEED: Record<IdentityChannel, RawItem[]> = {
  whatsapp: [{ source: 'Ashu', from: 'Ashu', preview: 'are we still on for 4pm?' }],
  telegram: [
    {
      source: 'Ashu',
      from: 'Ashu',
      preview: 'pushed the fix, can you review?',
      senderKey: '123456789'
    },
    { source: 'Standup bot', from: 'Standup bot', preview: 'daily reminder', senderKey: '999' }
  ],
  slack: [
    { source: '#eng', from: 'Ashu Kumar', preview: 'deploy is green', senderKey: 'U024BE7LH' },
    { source: '#eng', from: 'Priya', preview: 'nice', senderKey: 'U777PRIYA' }
  ],
  gmail: [
    {
      source: 'Invoice for August',
      from: 'Ashu <ashu@acme.com>',
      preview: 'attached the invoice',
      senderKey: 'ashu@acme.com'
    }
  ]
}

/** Deps that return the seed, filtered by handle the way each real reader does. */
function seededDeps(overrides: Partial<InboxDeps> = {}): InboxDeps {
  const reader =
    (channel: IdentityChannel) =>
    async (scope: ChannelScope): Promise<ChannelRead> => {
      const all = SEED[channel]
      if (!scope.handle) return { status: 'ok', items: all }
      const wanted = scope.handle.toLowerCase()
      return {
        status: 'ok',
        items: all.filter(
          (i) =>
            (i.senderKey ?? '').toLowerCase() === wanted ||
            i.from.toLowerCase() === wanted ||
            i.source.toLowerCase() === wanted
        )
      }
    }
  return {
    whatsapp: reader('whatsapp'),
    telegram: reader('telegram'),
    slack: reader('slack'),
    gmail: reader('gmail'),
    ...overrides
  }
}

/** Run the tool and parse the JSON payload back out of its output. */
async function summarize(
  args: Record<string, unknown>,
  deps: InboxDeps = seededDeps()
): Promise<InboxSummaryData> {
  const result = await summarizeInbox(args, deps)
  if (!result.ok) throw new Error(`expected a summary, got: ${result.error}`)
  const json = (result.output ?? '').slice((result.output ?? '').indexOf('{'))
  return JSON.parse(json) as InboxSummaryData
}

function report(summary: InboxSummaryData, channel: IdentityChannel): ChannelReport {
  const found = summary.channels.find((c) => c.channel === channel)
  if (!found) throw new Error(`no report for ${channel}`)
  return found
}

/** Link Ashu on every channel that needs an explicit link, plus WhatsApp. */
function linkAshuEverywhere(): void {
  linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })
  linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
  linkIdentity({ name: 'Ashu', channel: 'slack', handle: 'U024BE7LH' })
  linkIdentity({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })
}

// ── the gate ────────────────────────────────────────────────────────────────

describe('the off-by-default gate', () => {
  it('is off when the setting was never written', () => {
    expect(isUnifiedInboxEnabled()).toBe(false)
  })

  it('refuses both tools until it is turned on', async () => {
    const read = await summarizeInbox({}, seededDeps())
    expect(read.ok).toBe(false)
    expect(read.error).toBe(GATE_MESSAGE)

    const send = await sendSummaryEmail({ recipient: 'x@y.com', summary: 'hi' })
    expect(send.ok).toBe(false)
    expect(send.error).toBe(GATE_MESSAGE)
    // Nothing must reach Gmail while the feature is off.
    expect(gmailStub.sent).toEqual([])
  })

  it('reads nothing at all while gated — not even the connected channels', async () => {
    const spy = vi.fn(async (): Promise<ChannelRead> => ({ status: 'ok', items: [] }))
    await summarizeInbox({}, seededDeps({ slack: spy, gmail: spy, telegram: spy, whatsapp: spy }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('runs once the setting is on', async () => {
    enableInbox()
    expect(isUnifiedInboxEnabled()).toBe(true)
    const summary = await summarize({})
    expect(summary.totals.items).toBeGreaterThan(0)
  })
})

// ── whole-inbox read ────────────────────────────────────────────────────────

describe('the whole-inbox summary', () => {
  beforeEach(enableInbox)

  it('reads all four channels and reports each one', async () => {
    const summary = await summarize({})
    expect(summary.scope).toBe('everything')
    expect(summary.channels.map((c) => c.channel).sort()).toEqual([
      'gmail',
      'slack',
      'telegram',
      'whatsapp'
    ])
    for (const channel of summary.channels) expect(channel.status).toBe('ok')
    expect(summary.totals.channelsRead).toBe(4)
  })

  it('attributes items to a known person and leaves strangers unattributed', async () => {
    linkAshuEverywhere()
    const summary = await summarize({})

    const telegram = report(summary, 'telegram')
    const fromAshu = telegram.items.find((i) => i.preview.includes('pushed the fix'))
    // The Telegram item carries no name at all — only the link makes this work.
    expect(fromAshu?.contact).toBe('Ashu')
    expect(telegram.items.find((i) => i.preview === 'daily reminder')?.contact).toBeUndefined()
  })

  it('honours a channel filter', async () => {
    const summary = await summarize({ channels: ['slack', 'gmail'] })
    expect(report(summary, 'slack').status).toBe('ok')
    expect(report(summary, 'whatsapp').status).toBe('not_requested')
    expect(report(summary, 'telegram').items).toEqual([])
  })

  it('rejects an unknown channel instead of silently ignoring it', async () => {
    const result = await summarizeInbox({ channels: ['discord'] }, seededDeps())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/discord/i)
  })

  it('marks WhatsApp best-effort and the API channels as api', async () => {
    const summary = await summarize({})
    expect(report(summary, 'whatsapp').confidence).toBe('best-effort')
    for (const channel of ['telegram', 'slack', 'gmail'] as const) {
      expect(report(summary, channel).confidence).toBe('api')
    }
  })
})

// ── the point of the feature ────────────────────────────────────────────────

describe('a person-scoped summary', () => {
  beforeEach(enableInbox)

  it('draws from every channel the person is reachable on', async () => {
    linkAshuEverywhere()
    const summary = await summarize({ contact: 'Ashu' })

    expect(summary.scope).toBe('contact')
    expect(summary.contact?.name).toBe('Ashu')

    // The actual assertion of the feature: four channels, four contributions,
    // not one channel answering for all of them.
    const channelsWithItems = summary.channels.filter((c) => c.items.length > 0)
    expect(channelsWithItems.map((c) => c.channel).sort()).toEqual([
      'gmail',
      'slack',
      'telegram',
      'whatsapp'
    ])
    const previews = summary.channels.flatMap((c) => c.items.map((i) => i.preview))
    expect(previews).toContain('are we still on for 4pm?')
    expect(previews).toContain('pushed the fix, can you review?')
    expect(previews).toContain('deploy is green')
    expect(previews).toContain('attached the invoice')
  })

  it('excludes everyone else', async () => {
    linkAshuEverywhere()
    const summary = await summarize({ contact: 'Ashu' })
    const previews = summary.channels.flatMap((c) => c.items.map((i) => i.preview))
    expect(previews).not.toContain('daily reminder')
    expect(previews).not.toContain('nice')
  })

  it('refuses when the person cannot be resolved, instead of summarising everything', async () => {
    const result = await summarizeInbox({ contact: 'him' }, seededDeps())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no contact named "him"/i)
    expect(result.error).toMatch(/link_contact/)
  })

  it('refuses on an ambiguous name rather than picking one', async () => {
    linkIdentity({ name: 'Ashu Kumar', channel: 'gmail', handle: 'a.k@acme.com' })
    linkIdentity({ name: 'Ashu Mehta', channel: 'gmail', handle: 'a.m@acme.com' })
    const result = await summarizeInbox({ contact: 'Ashu' }, seededDeps())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/more than one contact/i)
  })

  it('records which handle each channel matched on, and how', async () => {
    linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
    const summary = await summarize({ contact: 'Ashu' })
    const handles = Object.fromEntries(summary.contact!.handles.map((h) => [h.channel, h]))

    expect(handles.telegram).toEqual({ channel: 'telegram', handle: '123456789', via: 'link' })
    // WhatsApp and Slack expose display names, so they resolve with no link.
    expect(handles.whatsapp.via).toBe('display-name')
    expect(handles.slack.via).toBe('display-name')
    expect(handles.gmail).toBeUndefined()
  })
})

describe('the Telegram and Gmail gap — before and after the one-time link', () => {
  beforeEach(enableInbox)

  it('cannot see the message before the link, and says so rather than reporting silence', async () => {
    // Ashu is a known person, reachable on the name-bearing channels.
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })

    const summary = await summarize({ contact: 'Ashu' })
    const telegram = report(summary, 'telegram')
    const gmail = report(summary, 'gmail')

    expect(telegram.items).toEqual([])
    expect(gmail.items).toEqual([])
    // The distinction that keeps the summary honest: this is "I could not look",
    // not "he sent nothing".
    expect(telegram.status).toBe('no_handle')
    expect(gmail.status).toBe('no_handle')
    expect(telegram.detail).toMatch(/NOT evidence/i)
    expect(telegram.detail).toMatch(/link_contact/)
    expect(summary.totals.channelsUnavailable).toBe(2)
  })

  it('sees the same messages, from the same query, after linking', async () => {
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })
    linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
    linkIdentity({ name: 'Ashu', channel: 'gmail', handle: 'ashu@acme.com' })

    const summary = await summarize({ contact: 'Ashu' })
    expect(report(summary, 'telegram').items.map((i) => i.preview)).toEqual([
      'pushed the fix, can you review?'
    ])
    expect(report(summary, 'gmail').items.map((i) => i.preview)).toEqual(['attached the invoice'])
    expect(summary.totals.channelsUnavailable).toBe(0)
  })
})

// ── failure reporting ───────────────────────────────────────────────────────

describe('unavailable channels', () => {
  beforeEach(enableInbox)

  it('reports not_connected and error distinctly, never as an empty inbox', async () => {
    const summary = await summarize(
      {},
      seededDeps({
        slack: async () => ({ status: 'not_connected', detail: 'No Slack token configured.' }),
        gmail: async () => ({ status: 'error', detail: 'Gmail search failed: HTTP 503' })
      })
    )
    expect(report(summary, 'slack').status).toBe('not_connected')
    expect(report(summary, 'slack').detail).toMatch(/No Slack token/)
    expect(report(summary, 'gmail').status).toBe('error')
    expect(report(summary, 'gmail').detail).toMatch(/503/)
    expect(summary.totals.channelsUnavailable).toBe(2)
  })

  it('does not lose the other three channels when one throws', async () => {
    const summary = await summarize(
      {},
      seededDeps({
        telegram: async () => {
          throw new Error('socket hang up')
        }
      })
    )
    expect(report(summary, 'telegram').status).toBe('error')
    expect(report(summary, 'telegram').detail).toBe('socket hang up')
    expect(report(summary, 'slack').items.length).toBeGreaterThan(0)
    expect(report(summary, 'whatsapp').items.length).toBeGreaterThan(0)
  })

  it('tells the model to say so, in the payload itself', async () => {
    const result = await summarizeInbox({}, seededDeps())
    expect(result.output).toMatch(/do not invent items/i)
    expect(result.output).toMatch(/could not check it/i)
  })
})

describe('limits', () => {
  beforeEach(enableInbox)

  it('clamps the per-channel limit', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      source: '#eng',
      from: 'Someone',
      preview: `msg ${i}`
    }))
    const summary = await summarize(
      { limit: 999 },
      seededDeps({ slack: async () => ({ status: 'ok', items: many }) })
    )
    expect(report(summary, 'slack').items.length).toBe(50)
  })

  it('clips a very long preview', async () => {
    const summary = await summarize(
      {},
      seededDeps({
        gmail: async () => ({
          status: 'ok',
          items: [{ source: 'Long', from: 'x', preview: 'a'.repeat(5000) }]
        })
      })
    )
    expect(report(summary, 'gmail').items[0].preview.length).toBeLessThan(400)
  })
})

// ── the outbound half ───────────────────────────────────────────────────────

describe('sendSummaryEmail', () => {
  beforeEach(enableInbox)

  it('sends to a literal address without needing a contact', async () => {
    const r = await sendSummaryEmail({
      recipient: 'boss@acme.com',
      summary: 'Ashu pushed a fix.',
      subject: 'Today'
    })
    expect(r.ok).toBe(true)
    expect(gmailStub.sent).toEqual([
      { to: ['boss@acme.com'], subject: 'Today', body: 'Ashu pushed a fix.' }
    ])
  })

  it('sends to a contact whose address is linked', async () => {
    linkIdentity({ name: 'Priya', channel: 'gmail', handle: 'priya@acme.com' })
    const r = await sendSummaryEmail({ recipient: 'Priya', summary: 'Here is the summary.' })
    expect(r.ok).toBe(true)
    expect(gmailStub.sent[0].to).toEqual(['priya@acme.com'])
  })

  it('REFUSES when the recipient is not a known person', async () => {
    const r = await sendSummaryEmail({ recipient: 'him', summary: 'Here is the summary.' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no contact named "him"/i)
    expect(r.error).toMatch(/do not guess/i)
    expect(gmailStub.sent).toEqual([])
  })

  it('REFUSES when the person is known but has no email, and asks which one to use', async () => {
    // The exact scenario: "mail this to him", where "him" IS resolvable — just
    // not by email. The tempting failure is to reach for the only other address
    // in the contact list.
    linkIdentity({ name: 'Ashu', channel: 'telegram', handle: '123456789' })
    linkIdentity({ name: 'Priya', channel: 'gmail', handle: 'priya@acme.com' })

    const r = await sendSummaryEmail({ recipient: 'Ashu', summary: 'Here is the summary.' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no email address is linked/i)
    expect(r.error).toMatch(/ASK the user/)
    expect(gmailStub.sent).toEqual([])
  })

  it('REFUSES an ambiguous recipient', async () => {
    linkIdentity({ name: 'Ashu Kumar', channel: 'gmail', handle: 'a.k@acme.com' })
    linkIdentity({ name: 'Ashu Mehta', channel: 'gmail', handle: 'a.m@acme.com' })
    const r = await sendSummaryEmail({ recipient: 'Ashu', summary: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/more than one contact/i)
    expect(gmailStub.sent).toEqual([])
  })

  it('requires a summary body', async () => {
    const r = await sendSummaryEmail({ recipient: 'boss@acme.com', summary: '   ' })
    expect(r.ok).toBe(false)
    expect(gmailStub.sent).toEqual([])
  })

  it('surfaces a Gmail failure rather than claiming success', async () => {
    gmailStub.result = { ok: false, error: 'Gmail rejected the message: quota exceeded' }
    const r = await sendSummaryEmail({ recipient: 'boss@acme.com', summary: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/quota exceeded/)
  })

  it('says Gmail is not connected instead of failing opaquely', async () => {
    gmailStub.connected = false
    const r = await sendSummaryEmail({ recipient: 'boss@acme.com', summary: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not connected/i)
  })
})

describe('resolveRecipient', () => {
  beforeEach(enableInbox)

  it('never falls back to the only address it knows', () => {
    linkIdentity({ name: 'Priya', channel: 'gmail', handle: 'priya@acme.com' })
    linkIdentity({ name: 'Ashu', channel: 'whatsapp', handle: 'Ashu' })

    const r = resolveRecipient('Ashu')
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('unreachable')
    expect(r.error).not.toContain('priya@acme.com')
  })

  it('reads the address out of a full From header', () => {
    expect(emailAddressOf('Ashu Kumar <ashu@acme.com>')).toBe('ashu@acme.com')
    expect(emailAddressOf('ashu@acme.com')).toBe('ashu@acme.com')
  })
})

describe('tool surface', () => {
  it('every schema has an executor', () => {
    const registry = inboxRegistry({
      unreadSenders: async () => [],
      readChat: async () => ({ fullText: '', recentContext: [] })
    })
    expect(inboxToolSchemas.map((s) => s.name).sort()).toEqual(Object.keys(registry).sort())
  })

  it('tells the model not to guess a recipient', () => {
    const schema = inboxToolSchemas.find((s) => s.name === 'send_summary_email')
    expect(schema?.description).toMatch(/never invent an address/i)
    expect(schema?.description).toMatch(/refuses/i)
  })
})
