import { describe, it, expect, vi, beforeEach } from 'vitest'

// broadcast_message is the highest-blast-radius tool in the app: one call puts
// the same text in front of several people on several platforms, and none of it
// can be unsent. So these tests are mostly about what it REFUSES to do, and
// about never reporting a partial delivery as a success.
//
// Everything below the four channel sends is mocked at the module boundary — no
// Slack workspace, no Telegram bot, no Gmail grant, no WhatsApp window.

const H = vi.hoisted(() => ({
  gateOpen: true,
  /** contacts index: name → per-channel handles. */
  contacts: new Map<string, Record<string, string>>(),
  connectivity: { telegram: true, slack: true, gmail: true }
}))

vi.mock('./database', () => ({ database: { settings: { getSetting: () => undefined } } }))
vi.mock('./telegram', () => ({
  isTelegramConnected: () => H.connectivity.telegram,
  send_telegram_message: vi.fn(async () => ({ ok: true, output: 'tg sent' }))
}))
vi.mock('./slack', () => ({
  isSlackConnected: () => H.connectivity.slack,
  slackRegistry: { send_slack_message: vi.fn(async () => ({ ok: true, output: 'slack sent' })) }
}))
vi.mock('./gmail', () => ({
  isGmailConnected: () => H.connectivity.gmail,
  sendGmailMessage: vi.fn(async () => ({ ok: true, output: 'mail sent' }))
}))
vi.mock('./inboxSummary', () => ({
  isUnifiedInboxEnabled: () => H.gateOpen,
  GATE_MESSAGE: 'GATE CLOSED'
}))

// The contact layer is faked so resolution outcomes can be driven directly.
// CHANNEL_LABELS / IDENTITY_CHANNELS keep their real values.
vi.mock('./contacts', () => {
  const IDENTITY_CHANNELS = ['whatsapp', 'telegram', 'slack', 'gmail'] as const
  return {
    IDENTITY_CHANNELS,
    CHANNEL_LABELS: {
      whatsapp: 'WhatsApp',
      telegram: 'Telegram',
      slack: 'Slack',
      gmail: 'Gmail'
    },
    isIdentityChannel: (v: string) => (IDENTITY_CHANNELS as readonly string[]).includes(v),
    resolveContact: (name: string) => {
      const handles = H.contacts.get(name.toLowerCase())
      if (!handles) return { status: 'unknown' as const }
      return {
        status: 'resolved' as const,
        contact: { display_name: name },
        identities: Object.entries(handles).map(([channel, handle]) => ({ channel, handle }))
      }
    },
    handleForChannel: (
      resolved: { identities: { channel: string; handle: string }[] },
      channel: string
    ) => {
      const found = resolved.identities.find((i) => i.channel === channel)
      return found ? { handle: found.handle, source: 'link' as const } : null
    },
    explainUnresolved: (_r: unknown, name: string) => `I don't know who "${name}" is.`
  }
})

import {
  broadcastMessage,
  planBroadcast,
  parseRecipients,
  parseBroadcastChannels,
  MAX_RECIPIENTS,
  MAX_BROADCAST_CHARS,
  type BroadcastSenders,
  type ConnectivityProbe
} from './broadcast'

const connectivity: ConnectivityProbe = {
  telegram: () => H.connectivity.telegram,
  slack: () => H.connectivity.slack,
  gmail: () => H.connectivity.gmail
}

function senders(over: Partial<BroadcastSenders> = {}): BroadcastSenders {
  return {
    whatsapp: vi.fn(async () => ({ ok: true, output: 'wa sent' })),
    telegram: vi.fn(async () => ({ ok: true, output: 'tg sent' })),
    slack: vi.fn(async () => ({ ok: true, output: 'slack sent' })),
    gmail: vi.fn(async () => ({ ok: true, output: 'mail sent' })),
    ...over
  }
}

/** Parse the JSON payload back out of the rendered report. */
function payload(text: string): {
  outcomes: { channel: string; destination: string; status: string }[]
  skipped: { channel: string; reason: string }[]
  totals: Record<string, number>
} {
  return JSON.parse(text.slice(text.indexOf('{')))
}

beforeEach(() => {
  H.gateOpen = true
  H.connectivity = { telegram: true, slack: true, gmail: true }
  H.contacts.clear()
  H.contacts.set('ashu', {
    whatsapp: 'Ashu',
    telegram: '12345',
    slack: '#eng',
    gmail: 'ashu@acme.com'
  })
})

describe('what broadcast_message refuses to do', () => {
  it('refuses with no recipients — there is deliberately no "everyone" mode', async () => {
    const out = await broadcastMessage({ message: 'ship it' }, senders(), connectivity)
    expect(out.ok).toBe(false)
    // The model must be told to ASK, not to pick.
    expect(out.error).toMatch(/no "send to everyone" mode/i)
    expect(out.error).toMatch(/ASK the user/i)
  })

  it('caps the recipient list so one call cannot become a mailing list', async () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `person${i}`)
    const out = await broadcastMessage({ message: 'hi', to: many }, senders(), connectivity)
    expect(out.ok).toBe(false)
    expect(out.error).toContain(String(MAX_RECIPIENTS))
  })

  it('sends NOTHING when any recipient cannot be identified', async () => {
    const s = senders()
    const out = await broadcastMessage(
      { message: 'hi', to: ['Ashu', 'whoever'] },
      s,
      connectivity
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/don't know who "whoever" is/)
    // The critical property: Ashu must NOT have been messaged. A half-sent
    // broadcast leaves the user unable to tell who already got it.
    expect(s.whatsapp).not.toHaveBeenCalled()
    expect(s.telegram).not.toHaveBeenCalled()
    expect(s.slack).not.toHaveBeenCalled()
    expect(s.gmail).not.toHaveBeenCalled()
  })

  it('rejects a message longer than the tightest channel limit, before sending', async () => {
    const s = senders()
    const out = await broadcastMessage(
      { message: 'x'.repeat(MAX_BROADCAST_CHARS + 1), to: ['Ashu'] },
      s,
      connectivity
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/Telegram rejects anything longer/i)
    expect(s.slack).not.toHaveBeenCalled()
  })

  it('rejects an empty message', async () => {
    const out = await broadcastMessage({ message: '   ', to: ['Ashu'] }, senders(), connectivity)
    expect(out.ok).toBe(false)
  })

  it('rejects an unknown channel name rather than silently dropping it', async () => {
    const out = await broadcastMessage(
      { message: 'hi', to: ['Ashu'], channels: ['discord'] },
      senders(),
      connectivity
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/"discord" is not a supported channel/)
  })

  it('respects the gate when it is switched off', async () => {
    H.gateOpen = false
    const out = await broadcastMessage({ message: 'hi', to: ['Ashu'] }, senders(), connectivity)
    expect(out).toMatchObject({ ok: false, error: 'GATE CLOSED' })
  })
})

describe('planning — who actually gets attempted', () => {
  it('reaches every channel the person has a linked handle on', async () => {
    const s = senders()
    const out = await broadcastMessage({ message: 'ship it', to: ['Ashu'] }, s, connectivity)

    expect(out.ok).toBe(true)
    expect(s.whatsapp).toHaveBeenCalledWith('Ashu', 'ship it')
    expect(s.telegram).toHaveBeenCalledWith('12345', 'ship it')
    expect(s.slack).toHaveBeenCalledWith('#eng', 'ship it')
    expect(s.gmail).toHaveBeenCalledWith('ashu@acme.com', 'ship it', 'Message')
  })

  it('honours a channel filter', async () => {
    const s = senders()
    await broadcastMessage(
      { message: 'hi', to: ['Ashu'], channels: ['slack', 'gmail'] },
      s,
      connectivity
    )
    expect(s.slack).toHaveBeenCalled()
    expect(s.gmail).toHaveBeenCalled()
    expect(s.whatsapp).not.toHaveBeenCalled()
    expect(s.telegram).not.toHaveBeenCalled()
  })

  it('passes a custom subject to email only', async () => {
    const s = senders()
    await broadcastMessage(
      { message: 'hi', to: ['Ashu'], subject: 'Release 7.3' },
      s,
      connectivity
    )
    expect(s.gmail).toHaveBeenCalledWith('ashu@acme.com', 'hi', 'Release 7.3')
  })

  it('does not post twice when two people share one destination', () => {
    // Two contacts both linked to #eng must not put the message in it twice.
    const resolved = (name: string, slack: string) =>
      ({
        status: 'resolved' as const,
        contact: { display_name: name },
        identities: [{ channel: 'slack', handle: slack }]
      }) as never
    const { targets } = planBroadcast(
      [resolved('Ashu', '#eng'), resolved('Rin', '#ENG')],
      ['slack'],
      connectivity
    )
    expect(targets).toHaveLength(1)
  })

  it('reports a missing handle as a skip, never as a delivery', async () => {
    H.contacts.set('rin', { slack: '#eng' }) // no whatsapp/telegram/gmail
    const out = await broadcastMessage({ message: 'hi', to: ['Rin'] }, senders(), connectivity)

    expect(out.ok).toBe(true)
    const data = payload(out.output as string)
    expect(data.totals.sent).toBe(1)
    expect(data.skipped).toHaveLength(3)
    for (const skip of data.skipped) expect(skip.reason).toBe('no_handle')
    expect(out.output).toMatch(/NOT a delivery/i)
  })

  it('reports a disconnected channel as a skip, and says the person was not messaged', async () => {
    H.connectivity.slack = false
    const s = senders()
    const out = await broadcastMessage({ message: 'hi', to: ['Ashu'] }, s, connectivity)

    expect(s.slack).not.toHaveBeenCalled()
    const data = payload(out.output as string)
    const skip = data.skipped.find((x) => x.channel === 'slack')
    expect(skip?.reason).toBe('not_connected')
    expect(out.output).toMatch(/was NOT messaged there/i)
  })

  it('still attempts WhatsApp, which has no credential to probe', async () => {
    // WhatsApp is screen automation — "connected" cannot be answered up front,
    // so it must be tried and allowed to report its own failure.
    H.connectivity = { telegram: false, slack: false, gmail: false }
    const s = senders()
    await broadcastMessage({ message: 'hi', to: ['Ashu'] }, s, connectivity)
    expect(s.whatsapp).toHaveBeenCalled()
  })

  it('fails when nobody is reachable at all, rather than reporting an empty success', async () => {
    H.contacts.set('rin', { slack: '#eng' })
    H.connectivity.slack = false
    const out = await broadcastMessage({ message: 'hi', to: ['Rin'] }, senders(), connectivity)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no reachable destination/i)
  })
})

describe('partial failure is never reported as success', () => {
  it('marks a run PARTIAL and names it when one channel fails', async () => {
    const s = senders({
      slack: vi.fn(async () => ({ ok: false, error: 'channel_not_found' }))
    })
    const out = await broadcastMessage({ message: 'hi', to: ['Ashu'] }, s, connectivity)

    // Still ok:true — three people really did get it — but the payload and the
    // headline must both make the failure impossible to gloss over.
    expect(out.ok).toBe(true)
    expect(out.output).toMatch(/^PARTIAL: 3 of 4/m)
    expect(out.output).toMatch(/do not report this as sent/i)

    const data = payload(out.output as string)
    expect(data.totals).toMatchObject({ attempted: 4, sent: 3, failed: 1 })
    const slack = data.outcomes.find((o) => o.channel === 'slack')
    expect(slack?.status).toBe('failed')
  })

  it('preserves the channel’s own error text so the user learns the real cause', async () => {
    const s = senders({
      gmail: vi.fn(async () => ({ ok: false, error: 'Gmail token expired — reconnect in Settings.' }))
    })
    const out = await broadcastMessage({ message: 'hi', to: ['Ashu'] }, s, connectivity)
    expect(out.output).toContain('Gmail token expired — reconnect in Settings.')
  })

  it('returns ok:false when every attempt fails', async () => {
    const s = senders({
      whatsapp: vi.fn(async () => ({ ok: false, error: 'no window' })),
      telegram: vi.fn(async () => ({ ok: false, error: 'bad token' })),
      slack: vi.fn(async () => ({ ok: false, error: 'not_in_channel' })),
      gmail: vi.fn(async () => ({ ok: false, error: 'auth' }))
    })
    const out = await broadcastMessage({ message: 'hi', to: ['Ashu'] }, s, connectivity)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/NOTHING was delivered/i)
  })

  it('a sender that THROWS is recorded as a failure, not lost', async () => {
    const s = senders({
      telegram: vi.fn(async () => {
        throw new Error('socket hang up')
      })
    })
    const out = await broadcastMessage({ message: 'hi', to: ['Ashu'] }, s, connectivity)

    const data = payload(out.output as string)
    expect(data.totals.failed).toBe(1)
    // And the other three still went — one channel throwing must not lose them.
    expect(data.totals.sent).toBe(3)
    expect(out.output).toContain('socket hang up')
  })

  it('reports all-clear only when everything landed and nothing was skipped', async () => {
    const out = await broadcastMessage({ message: 'hi', to: ['Ashu'] }, senders(), connectivity)
    expect(out.output).toMatch(/^Delivered to all 4 destinations\./m)
    expect(out.output).not.toMatch(/PARTIAL/)
  })
})

describe('argument parsing', () => {
  it('dedupes recipients case-insensitively', () => {
    expect(parseRecipients(['Ashu', 'ashu', 'Rin'])).toEqual({ names: ['Ashu', 'Rin'] })
  })

  it('accepts a bare string as a single recipient', () => {
    expect(parseRecipients('Ashu')).toEqual({ names: ['Ashu'] })
  })

  it('defaults to all four channels', () => {
    expect(parseBroadcastChannels(undefined)).toEqual({
      channels: ['whatsapp', 'telegram', 'slack', 'gmail']
    })
    expect(parseBroadcastChannels([])).toEqual({
      channels: ['whatsapp', 'telegram', 'slack', 'gmail']
    })
  })
})
