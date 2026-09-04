/**
 * broadcast — send one message to the same people across every channel they can
 * be reached on.
 *
 * THE MISSING HALF. summarize_inbox reads across WhatsApp, Telegram, Slack and
 * Gmail; until now there was no way to answer back across them. The only sends
 * were per-channel (send_whatsapp_message, send_telegram_message,
 * send_slack_message, send_email), so "tell the team on every platform" meant
 * four separate confirmations and four chances to miss one.
 *
 * WHY THIS IS NOT A MASS-MAILER. A tool that can put the same text in front of
 * arbitrarily many people is one bad model turn away from being a spam cannon,
 * so the shape is deliberately narrow:
 *
 *   • RECIPIENTS ARE NAMED, NEVER INFERRED. There is no "everyone" mode. An
 *     unbounded broadcast would have to guess who the user meant, and this
 *     codebase already decided (contacts.ts, send_summary_email) that guessing a
 *     recipient is the one thing never to do — the failure mode is a private
 *     message reaching a stranger.
 *   • ONE APPROVAL SHOWS THE WHOLE FAN-OUT. The plan is resolved before anything
 *     sends, so the confirmation names every destination on every channel. Four
 *     separate approvals is how one gets clicked through by muscle memory.
 *   • CAPPED. MAX_RECIPIENTS bounds a single call regardless of what the model
 *     asks for.
 *   • PARTIAL FAILURE IS REPORTED AS PARTIAL. Three sent and two failed is
 *     never summarised as "sent" — each destination carries its own outcome.
 *   • A CHANNEL THAT COULD NOT BE TRIED SAYS SO. Not connected, or no handle
 *     linked for that person, is reported per destination. Silence must never
 *     read as delivery.
 *
 * The senders are injected for the same reason InboxDeps are: the assembly —
 * resolution, planning, dedup, partial-failure accounting — is the part worth
 * testing, and it should be testable without a Slack workspace, a Telegram bot,
 * a Gmail grant and a WhatsApp window.
 */
import {
  resolveContact,
  handleForChannel,
  explainUnresolved,
  isIdentityChannel,
  CHANNEL_LABELS,
  IDENTITY_CHANNELS,
  type IdentityChannel,
  type ResolvedContact
} from './contacts'
import { isTelegramConnected, send_telegram_message } from './telegram'
import { isSlackConnected, slackRegistry } from './slack'
import { isGmailConnected, sendGmailMessage } from './gmail'
import { isUnifiedInboxEnabled, GATE_MESSAGE } from './inboxSummary'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

/**
 * Most people one call may reach. Twenty is a team, not a mailing list — past
 * that this stops being "tell the people working on this" and becomes bulk
 * messaging, which is a different product with different consent rules.
 */
export const MAX_RECIPIENTS = 20

/**
 * Longest message accepted. Telegram's own hard limit is 4096 characters and is
 * the tightest of the four, so anything longer cannot go everywhere — failing
 * up front beats delivering to three channels and erroring on the fourth.
 */
export const MAX_BROADCAST_CHARS = 4000

/** One resolved destination the broadcast will actually attempt. */
export interface BroadcastTarget {
  channel: IdentityChannel
  /** The channel-native destination: a chat name, chat id, #channel, address. */
  destination: string
  /** The contact this destination belongs to. */
  contact: string
}

/** A destination that could not even be attempted, and why. */
export interface BroadcastSkip {
  channel: IdentityChannel
  contact: string
  reason: 'no_handle' | 'not_connected'
  detail: string
}

/** What happened to one attempted destination. */
export interface BroadcastOutcome extends BroadcastTarget {
  status: 'sent' | 'failed'
  detail: string
}

export interface BroadcastReport {
  message: string
  subject?: string
  outcomes: BroadcastOutcome[]
  skipped: BroadcastSkip[]
  totals: { attempted: number; sent: number; failed: number; skipped: number }
}

/**
 * The four sends, injected. Each returns the channel's own ToolResult so its
 * error text — which is already written for a person — survives into the report.
 */
export interface BroadcastSenders {
  whatsapp(destination: string, message: string): Promise<ToolResult>
  telegram(destination: string, message: string): Promise<ToolResult>
  slack(destination: string, message: string): Promise<ToolResult>
  gmail(destination: string, message: string, subject: string): Promise<ToolResult>
}

/**
 * Which channels can be attempted right now.
 *
 * WhatsApp is absent on purpose: it is screen automation with no credential to
 * check, so "connected" is not a question that can be answered before trying.
 * Its send reports its own failure instead.
 */
export interface ConnectivityProbe {
  telegram(): boolean
  slack(): boolean
  gmail(): boolean
}

export const defaultConnectivity: ConnectivityProbe = {
  telegram: isTelegramConnected,
  slack: isSlackConnected,
  gmail: isGmailConnected
}

/** Production senders, each delegating to the channel module that owns the send. */
export function defaultBroadcastSenders(
  whatsappSend: (args: Record<string, unknown>) => Promise<ToolResult>
): BroadcastSenders {
  return {
    whatsapp: (destination, message) => whatsappSend({ contact: destination, message }),
    telegram: (destination, message) => send_telegram_message({ chat_id: destination, text: message }),
    slack: (destination, message) => slackRegistry.send_slack_message({ channel: destination, text: message }),
    gmail: async (destination, message, subject) => {
      const res = await sendGmailMessage({ to: [destination], subject, body: message })
      return res.ok
        ? { ok: true, output: res.output ?? `Sent to ${destination}.` }
        : { ok: false, error: res.error ?? 'Gmail send failed.' }
    }
  }
}

/** Validate and clamp the channel filter, defaulting to all four. */
export function parseBroadcastChannels(
  raw: unknown
): { channels: IdentityChannel[] } | { error: string } {
  if (raw == null) return { channels: [...IDENTITY_CHANNELS] }
  const list = Array.isArray(raw) ? raw : [raw]
  const channels: IdentityChannel[] = []
  for (const entry of list) {
    const name = String(entry).trim().toLowerCase()
    if (!isIdentityChannel(name)) {
      return { error: `"${name}" is not a supported channel (${IDENTITY_CHANNELS.join(', ')}).` }
    }
    if (!channels.includes(name)) channels.push(name)
  }
  if (channels.length === 0) return { channels: [...IDENTITY_CHANNELS] }
  return { channels }
}

/** Normalise the recipient list, enforcing the cap. */
export function parseRecipients(raw: unknown): { names: string[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const names: string[] = []
  for (const entry of list) {
    const name = String(entry).trim()
    if (!name) continue
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
  }
  if (names.length === 0) {
    return {
      error:
        'broadcast_message requires "to" — the people who should receive this. There is deliberately ' +
        'no "send to everyone" mode: ASK the user who this should go to and name them, rather than ' +
        'picking recipients yourself.'
    }
  }
  if (names.length > MAX_RECIPIENTS) {
    return {
      error:
        `broadcast_message accepts at most ${MAX_RECIPIENTS} recipients per call (got ${names.length}). ` +
        'Send to a smaller group, or ask the user to confirm a narrower list.'
    }
  }
  return { names }
}

/**
 * Turn resolved contacts into the exact set of destinations to attempt.
 *
 * Dedupes on (channel, destination): two contacts linked to the same Slack
 * channel must not each trigger a post, which would put the message in that
 * channel twice.
 */
export function planBroadcast(
  contacts: ResolvedContact[],
  channels: IdentityChannel[],
  connectivity: ConnectivityProbe
): { targets: BroadcastTarget[]; skipped: BroadcastSkip[] } {
  const targets: BroadcastTarget[] = []
  const skipped: BroadcastSkip[] = []
  const seen = new Set<string>()

  for (const resolved of contacts) {
    const name = resolved.contact.display_name
    for (const channel of channels) {
      const found = handleForChannel(resolved, channel)
      if (!found) {
        skipped.push({
          channel,
          contact: name,
          reason: 'no_handle',
          detail:
            `No ${CHANNEL_LABELS[channel]} handle is linked for ${name}, so there is nowhere to send ` +
            `this on ${CHANNEL_LABELS[channel]}. Link one with link_contact if the user knows it. ` +
            `This is NOT a delivery.`
        })
        continue
      }
      // WhatsApp has no credential to probe — its send reports its own failure.
      const reachable = channel === 'whatsapp' ? true : connectivity[channel]()
      if (!reachable) {
        skipped.push({
          channel,
          contact: name,
          reason: 'not_connected',
          detail:
            `${CHANNEL_LABELS[channel]} is not connected, so ${name} was NOT messaged there. ` +
            `Connect it in Settings and send again if they should have received this.`
        })
        continue
      }
      const key = `${channel}::${found.handle.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ channel, destination: found.handle, contact: name })
    }
  }
  return { targets, skipped }
}

/**
 * Send one message everywhere the named people can be reached.
 *
 * HITL-gated and in DESTRUCTIVE_TOOLS: it puts real text in front of real
 * people on several platforms at once and none of it can be unsent.
 */
export async function broadcastMessage(
  args: Record<string, unknown>,
  senders: BroadcastSenders,
  connectivity: ConnectivityProbe = defaultConnectivity
): Promise<ToolResult> {
  if (!isUnifiedInboxEnabled()) return { ok: false, error: GATE_MESSAGE }

  const message = typeof args.message === 'string' ? args.message : ''
  if (!message.trim()) {
    return { ok: false, error: 'broadcast_message requires a non-empty "message" to send.' }
  }
  if (message.length > MAX_BROADCAST_CHARS) {
    return {
      ok: false,
      error:
        `broadcast_message: "message" is ${message.length} characters, over the ${MAX_BROADCAST_CHARS} ` +
        'limit (Telegram rejects anything longer, so it could not go to every channel). Shorten it.'
    }
  }

  const subject = typeof args.subject === 'string' && args.subject.trim() ? args.subject.trim() : 'Message'

  const recipients = parseRecipients(args.to)
  if ('error' in recipients) return { ok: false, error: recipients.error }

  const requested = parseBroadcastChannels(args.channels)
  if ('error' in requested) return { ok: false, error: `broadcast_message: ${requested.error}` }

  // Resolve every recipient BEFORE sending anything. A half-sent broadcast that
  // then discovers it cannot identify someone is worse than one that never
  // started: the user has to work out who already got it.
  const contacts: ResolvedContact[] = []
  const unresolved: string[] = []
  for (const name of recipients.names) {
    const resolution = resolveContact(name)
    if (resolution.status !== 'resolved') {
      unresolved.push(explainUnresolved(resolution, name))
      continue
    }
    contacts.push(resolution)
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      error:
        'broadcast_message sent nothing, because not every recipient could be identified: ' +
        unresolved.join(' ')
    }
  }

  const { targets, skipped } = planBroadcast(contacts, requested.channels, connectivity)
  if (targets.length === 0) {
    return {
      ok: false,
      error:
        'broadcast_message sent nothing — there is no reachable destination for anyone named. ' +
        skipped.map((s) => s.detail).join(' ')
    }
  }

  const outcomes: BroadcastOutcome[] = []
  for (const target of targets) {
    let result: ToolResult
    try {
      result =
        target.channel === 'gmail'
          ? await senders.gmail(target.destination, message, subject)
          : await senders[target.channel](target.destination, message)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    outcomes.push({
      ...target,
      status: result.ok ? 'sent' : 'failed',
      detail: result.ok ? (result.output ?? 'Sent.') : (result.error ?? 'Send failed.')
    })
  }

  const sent = outcomes.filter((o) => o.status === 'sent').length
  const failed = outcomes.length - sent
  const report: BroadcastReport = {
    message,
    ...(requested.channels.includes('gmail') ? { subject } : {}),
    outcomes,
    skipped,
    totals: { attempted: outcomes.length, sent, failed, skipped: skipped.length }
  }

  // A broadcast where nothing landed is a failure, not a report of one.
  if (sent === 0) {
    return { ok: false, error: renderBroadcast(report, 'none') }
  }
  return { ok: true, output: renderBroadcast(report, failed > 0 || skipped.length > 0 ? 'partial' : 'all') }
}

/**
 * Render the result the model reports from.
 *
 * The headline states the split up front, because the one thing the user must
 * not be told is "sent" when two destinations failed — and a model handed a bare
 * list of rows will summarise optimistically.
 */
export function renderBroadcast(report: BroadcastReport, kind: 'all' | 'partial' | 'none'): string {
  const { totals } = report
  const headline =
    kind === 'all'
      ? `Delivered to all ${totals.sent} destination${totals.sent === 1 ? '' : 's'}.`
      : kind === 'none'
        ? `NOTHING was delivered — all ${totals.attempted} attempt${totals.attempted === 1 ? '' : 's'} failed.`
        : `PARTIAL: ${totals.sent} of ${totals.attempted} destinations received it, ` +
          `${totals.failed} failed, ${totals.skipped} could not be attempted. ` +
          'Tell the user exactly who did NOT get it — do not report this as sent.'
  return [headline, JSON.stringify(report, null, 2)].join('\n')
}

// ── schema (LLM-facing surface) ─────────────────────────────────────────────

export const broadcastToolSchemas: ToolSchema[] = [
  {
    name: 'broadcast_message',
    description:
      'Send the SAME message to one or more named people across every channel they can be reached on ' +
      '(WhatsApp, Telegram, Slack, Gmail) in a single confirmed action. Use this for "tell the team ' +
      'on every platform", "send this to Ashu everywhere", or "let everyone know". Recipients must be ' +
      'NAMED and known — there is no "send to everyone" mode, and this REFUSES rather than choosing ' +
      'recipients for you; if the user was vague about who, ask them. Each destination reports its own ' +
      'outcome: when some fail or a channel has no linked handle, say exactly who did not receive it ' +
      'rather than reporting success. Sends real messages that cannot be unsent, and always asks the ' +
      'user to confirm the full list first.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: `The text to send, identical on every channel (max ${MAX_BROADCAST_CHARS} characters).`
        },
        to: {
          type: 'array',
          description:
            `Who should receive it: names of known contacts ("Ashu") or handles already linked to them. ` +
            `Required, at most ${MAX_RECIPIENTS}. Never fill this in yourself — ask the user who they mean.`,
          items: { type: 'string' }
        },
        channels: {
          type: 'array',
          description:
            'Optional. Restrict to some channels, e.g. ["slack","gmail"]. Omit to use every channel each ' +
            'person has a linked handle on.',
          items: { type: 'string' }
        },
        subject: {
          type: 'string',
          description: 'Optional subject, used only for the email channel. Defaults to "Message".'
        }
      },
      required: ['message', 'to']
    }
  }
]

/**
 * Registry entry. WhatsApp's send is screen automation living in tools.ts, so it
 * is injected there — the same reason inboxRegistry takes its readers.
 */
export function broadcastRegistry(
  whatsappSend: (args: Record<string, unknown>) => Promise<ToolResult>
): Record<string, (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>> {
  const senders = defaultBroadcastSenders(whatsappSend)
  return {
    broadcast_message: (args) => broadcastMessage(args, senders)
  }
}
