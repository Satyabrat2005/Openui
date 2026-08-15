/**
 * inboxSummary — one read across WhatsApp, Telegram, Slack and Gmail, plus the
 * outbound action that turns the result into an email.
 *
 * WHAT THIS IS NOT. It is not a fifth channel integration. Every byte it
 * returns comes from the read paths those four modules already own — the same
 * getUpdates call, the same conversations.history, the same Gmail search, the
 * same WhatsApp OCR. This module resolves WHO a question is about, asks each
 * channel, and assembles the answers.
 *
 * STRUCTURED, NOT PROSE. summarize_inbox returns JSON, not a written summary.
 * The model composes the prose. That split matters: a tool that pre-writes the
 * summary has to decide what is important before anything knows what the user
 * asked, and its per-channel wording drifts from what was actually read. Handing
 * back who / where / when / what lets the model answer the actual question and
 * makes every claim in its answer traceable to a row.
 *
 * HONEST ABOUT GAPS. Each channel reports its own status. A channel that is not
 * connected, errored, or has no handle for the person in question says exactly
 * that and returns no items — it never contributes silence that would read as
 * "nothing from them". The distinction between "he sent nothing" and "I could
 * not look" is the whole difference between a useful summary and a misleading
 * one.
 */
import { database } from './database'
import {
  resolveContact,
  handleForChannel,
  emailForContact,
  explainUnresolved,
  isIdentityChannel,
  CHANNEL_LABELS,
  IDENTITY_CHANNELS,
  type IdentityChannel,
  type ResolvedContact
} from './contacts'
import { isTelegramConnected, readTelegramInbox } from './telegram'
import { isSlackConnected, readSlackInbox } from './slack'
import { isGmailConnected, findEmailThread, sendGmailMessage } from './gmail'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

/** Persisted setting key: see isUnifiedInboxEnabled. */
export const UNIFIED_INBOX_SETTING_KEY = 'unified_inbox_enabled'

/**
 * Master switch for the unified inbox, OFF by default.
 *
 * Reason, stated plainly: the cross-channel read and the summary-to-email action
 * have never run against a real Slack workspace, a real Telegram bot, or a real
 * Gmail account in this environment — there are no credentials here to run them
 * with. Their unit tests are thorough and their gaps are reported honestly, but
 * "thoroughly tested against fakes" is not "known to work", and the failure mode
 * is reading the wrong person's messages into a summary or mailing a summary to
 * the wrong address. Absent/undefined ⇒ false, the same inverted default the
 * local calendar backend uses and for the same reason.
 *
 * The contact tools (link_contact / list_contacts / unlink_contact) are NOT
 * behind this gate: they only write to the local database, they never touch an
 * account, and their behaviour is fully covered by contacts.test.ts.
 */
export function isUnifiedInboxEnabled(): boolean {
  try {
    return database.settings.getSetting(UNIFIED_INBOX_SETTING_KEY) === true
  } catch {
    return false
  }
}

/** The message shown for every gated call, naming the exact toggle. */
export const GATE_MESSAGE =
  'The unified inbox is turned off. It reads across WhatsApp, Telegram, Slack and Gmail at ' +
  'once, and has not been verified against real accounts, so it ships off by default. Turn on ' +
  '"Unified inbox" in Settings to enable it.'

// ── the shape a channel read returns ────────────────────────────────────────

/** One message, thread or chat surfaced by a channel. */
export interface InboxItem {
  channel: IdentityChannel
  /** Where it came from, in that channel's terms: a chat name, "#eng", a subject. */
  source: string
  /** Who sent it, as the channel labelled them. */
  from: string
  /** The message text, or a short preview of it. */
  preview: string
  /** When, when the channel told us. */
  at?: string
  /** Canonical contact name, when this item could be attributed to a known person. */
  contact?: string
}

/**
 * Why a channel contributed what it did.
 *
 * `no_handle` is the one that only exists because of the identity layer: the
 * channel is connected and working, but this person has no handle on it, so
 * there is nothing to look up. Reporting it as `ok` with zero items would be a
 * lie the model would faithfully repeat.
 */
export type ChannelStatus = 'ok' | 'not_connected' | 'no_handle' | 'error' | 'not_requested'

export interface ChannelReport {
  channel: IdentityChannel
  status: ChannelStatus
  /**
   * 'api' — the channel returned structured data from its own API.
   * 'best-effort' — the reading is OCR of what is on screen and can miss or
   * invent lines. Surfaced so the model can hedge a WhatsApp claim it cannot
   * hedge for a Gmail one.
   */
  confidence: 'api' | 'best-effort'
  detail?: string
  items: InboxItem[]
}

export interface InboxSummaryData {
  scope: 'everything' | 'contact'
  /** Present when the request named a person; records how each channel matched. */
  contact?: {
    name: string
    handles: Array<{ channel: IdentityChannel; handle: string; via: 'link' | 'display-name' }>
  }
  channels: ChannelReport[]
  totals: { items: number; channelsRead: number; channelsUnavailable: number }
}

/** What one channel reader hands back before attribution. */
export interface RawItem {
  source: string
  from: string
  preview: string
  at?: string
  /**
   * The value to resolve against the contact index, when it differs from the
   * display label — a bare email address rather than "Ashu <ashu@acme.com>".
   */
  senderKey?: string
}

export type ChannelRead =
  | { status: 'ok'; items: RawItem[]; detail?: string }
  | { status: 'not_connected' | 'error'; detail: string }

/** What a reader is being asked for. */
export interface ChannelScope {
  /** Present for a person-scoped read: this person's handle ON THIS channel. */
  handle?: string
  limit: number
}

/**
 * The four reads, injected.
 *
 * Injected rather than imported because it is the only way to test the
 * assembly — attribution, per-channel status, the person-scoped path — without
 * a Slack workspace, a Telegram bot, a Gmail grant and a WhatsApp window. The
 * real implementations are {@link defaultInboxDeps}.
 */
export interface InboxDeps {
  whatsapp(scope: ChannelScope): Promise<ChannelRead>
  telegram(scope: ChannelScope): Promise<ChannelRead>
  slack(scope: ChannelScope): Promise<ChannelRead>
  gmail(scope: ChannelScope): Promise<ChannelRead>
}

/** WhatsApp's readers live in tools.ts (screen automation), so they come in. */
export interface WhatsAppReaders {
  unreadSenders(): Promise<string[]>
  readChat(name: string): Promise<{ fullText: string; recentContext: string[] }>
}

/** Items requested per channel when the caller does not say. */
export const DEFAULT_ITEM_LIMIT = 10
export const MAX_ITEM_LIMIT = 50

/** Longest preview kept per item, so one long email can't dominate the payload. */
export const MAX_PREVIEW_CHARS = 300

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_PREVIEW_CHARS ? `${flat.slice(0, MAX_PREVIEW_CHARS)}…` : flat
}

/** Pull the bare address out of a `Name <addr@host>` header. */
export function emailAddressOf(header: string): string {
  const angled = header.match(/<([^>]+)>/)
  return (angled ? angled[1] : header).trim().toLowerCase()
}

// ── the real readers ────────────────────────────────────────────────────────

/**
 * Build the production deps. Only WhatsApp is passed in — the other three are
 * plain API calls this module can make directly, while WhatsApp's read is screen
 * automation that lives in tools.ts.
 */
export function defaultInboxDeps(whatsapp: WhatsAppReaders): InboxDeps {
  return {
    whatsapp: async (scope) => {
      // Person-scoped: open that one chat and read it. This is the only path
      // that drives the screen beyond focusing the window, so it is deliberately
      // NOT taken for a whole-inbox summary.
      if (scope.handle) {
        const chat = await whatsapp.readChat(scope.handle)
        const lines = chat.recentContext.filter((l) => l.trim())
        if (lines.length === 0) {
          return {
            status: 'ok',
            items: [],
            detail:
              `Could not read the WhatsApp chat "${scope.handle}" — it may not exist, WhatsApp may ` +
              'not be running, or the contact could not be matched unambiguously.'
          }
        }
        return {
          status: 'ok',
          items: lines.slice(-scope.limit).map((line) => ({
            source: scope.handle as string,
            from: scope.handle as string,
            preview: line
          })),
          detail: 'Read by OCR of the open chat — wording may be imperfect.'
        }
      }

      const senders = await whatsapp.unreadSenders()
      return {
        status: 'ok',
        items: senders.slice(0, scope.limit).map((name) => ({
          source: name,
          from: name,
          preview: '(unread chat — contents not read)'
        })),
        detail:
          'WhatsApp reports which chats look unread, not what they say. An empty list can also ' +
          'mean WhatsApp was not reachable. Ask about a specific person to read their chat.'
      }
    },

    telegram: async (scope) => {
      if (!isTelegramConnected()) {
        return {
          status: 'not_connected',
          detail: 'No Telegram bot token configured (Settings → Telegram).'
        }
      }
      const res = await readTelegramInbox({ chatId: scope.handle, limit: scope.limit })
      if (!res.ok) return { status: 'error', detail: res.error }
      return {
        status: 'ok',
        items: res.messages.map((m) => ({
          source: m.chatLabel,
          from: m.sender,
          preview: m.text,
          at: m.at,
          // Attribution runs against the chat id, because that is what a
          // Telegram contact link stores — the sender name is not in the index.
          senderKey: m.chatId
        }))
      }
    },

    slack: async (scope) => {
      if (!isSlackConnected()) {
        return { status: 'not_connected', detail: 'No Slack token configured (Settings → Slack).' }
      }
      const res = await readSlackInbox({ limit: scope.limit })
      if (!res.ok) return { status: 'error', detail: res.error }

      // Person-scoping happens here rather than in slack.ts because only this
      // layer knows the handle might be a linked user id OR a display name.
      const wanted = scope.handle?.trim().replace(/^@/, '').toLowerCase()
      const matching = wanted
        ? res.messages.filter(
            (m) => m.userId.toLowerCase() === wanted || m.sender.toLowerCase() === wanted
          )
        : res.messages

      const read = res.channelsRead.length > 0 ? res.channelsRead.join(', ') : 'no channels'
      return {
        status: 'ok',
        items: matching.slice(-scope.limit).map((m) => ({
          source: m.channel,
          from: m.sender,
          preview: m.text,
          senderKey: m.userId || m.sender
        })),
        detail:
          `Read ${read}.` +
          (res.truncated ? ' More channels exist than were read — this is a partial view.' : '')
      }
    },

    gmail: async (scope) => {
      if (!isGmailConnected()) {
        return { status: 'not_connected', detail: 'Gmail is not connected (Settings → Gmail).' }
      }
      // A person-scoped query asks Gmail itself to filter; the unscoped one asks
      // for what is actually worth summarising rather than the whole mailbox.
      const query = scope.handle ? `from:${scope.handle} newer_than:30d` : 'is:unread newer_than:7d'
      const res = await findEmailThread(query, scope.limit)
      if (!res.ok) return { status: 'error', detail: res.error ?? 'Gmail search failed.' }
      return {
        status: 'ok',
        items: (res.candidates ?? []).map((c) => ({
          source: c.subject || '(no subject)',
          from: c.from || '(unknown sender)',
          preview: c.snippet,
          at: c.date,
          senderKey: emailAddressOf(c.from)
        })),
        detail: `Gmail query: ${query}`
      }
    }
  }
}

// ── assembly ────────────────────────────────────────────────────────────────

/** OCR-based channels can miss or garble lines; API-based ones cannot. */
function confidenceFor(channel: IdentityChannel): 'api' | 'best-effort' {
  return channel === 'whatsapp' ? 'best-effort' : 'api'
}

/**
 * Attach a canonical contact name to an item when its sender resolves to a
 * known person. Best-effort by design: an unattributed item is still reported,
 * it just cannot answer "anything from him".
 */
function attribute(item: RawItem, channel: IdentityChannel): InboxItem {
  const out: InboxItem = {
    channel,
    source: item.source,
    from: item.from,
    preview: clip(item.preview)
  }
  if (item.at) out.at = item.at
  for (const key of [item.senderKey, item.from]) {
    if (!key) continue
    const resolution = resolveContact(key)
    if (resolution.status === 'resolved') {
      out.contact = resolution.contact.display_name
      break
    }
  }
  return out
}

/**
 * Read every requested channel and return structured results. Read-only —
 * nothing here sends, drafts, or changes any remote state.
 */
export async function summarizeInbox(
  args: Record<string, unknown>,
  deps: InboxDeps
): Promise<ToolResult> {
  if (!isUnifiedInboxEnabled()) return { ok: false, error: GATE_MESSAGE }

  const rawLimit = Number(args.limit)
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_ITEM_LIMIT, Math.round(rawLimit)))
    : DEFAULT_ITEM_LIMIT

  const requested = parseChannels(args.channels)
  if ('error' in requested) return { ok: false, error: `summarize_inbox: ${requested.error}` }

  const contactArg = typeof args.contact === 'string' ? args.contact.trim() : ''
  let resolved: ResolvedContact | null = null
  if (contactArg) {
    const resolution = resolveContact(contactArg)
    if (resolution.status !== 'resolved') {
      // Refuse rather than summarise everything and let the model pick — an
      // unresolved "him" is a question for the user, not a wider net.
      return { ok: false, error: `summarize_inbox: ${explainUnresolved(resolution, contactArg)}` }
    }
    resolved = resolution
  }

  const summary: InboxSummaryData = {
    scope: resolved ? 'contact' : 'everything',
    channels: [],
    totals: { items: 0, channelsRead: 0, channelsUnavailable: 0 }
  }

  if (resolved) {
    summary.contact = {
      name: resolved.contact.display_name,
      handles: IDENTITY_CHANNELS.flatMap((channel) => {
        const handle = handleForChannel(resolved as ResolvedContact, channel)
        return handle ? [{ channel, handle: handle.handle, via: handle.source }] : []
      })
    }
  }

  for (const channel of IDENTITY_CHANNELS) {
    if (!requested.channels.includes(channel)) {
      summary.channels.push({
        channel,
        status: 'not_requested',
        confidence: confidenceFor(channel),
        items: []
      })
      continue
    }
    summary.channels.push(await readChannel(channel, resolved, limit, deps))
  }

  for (const report of summary.channels) {
    summary.totals.items += report.items.length
    if (report.status === 'ok') summary.totals.channelsRead++
    else if (report.status !== 'not_requested') summary.totals.channelsUnavailable++
  }

  return { ok: true, output: renderSummary(summary) }
}

/** Read one channel, resolving the person's handle for it first when scoped. */
async function readChannel(
  channel: IdentityChannel,
  resolved: ResolvedContact | null,
  limit: number,
  deps: InboxDeps
): Promise<ChannelReport> {
  const confidence = confidenceFor(channel)
  let handle: string | undefined

  if (resolved) {
    const found = handleForChannel(resolved, channel)
    if (!found) {
      // The identity gap, reported instead of hidden. Telegram and Gmail land
      // here until the user links a chat id / address for this person.
      return {
        channel,
        status: 'no_handle',
        confidence,
        items: [],
        detail:
          `No ${CHANNEL_LABELS[channel]} handle is linked for ${resolved.contact.display_name}, ` +
          `so their ${CHANNEL_LABELS[channel]} messages cannot be identified. This is NOT evidence ` +
          `they sent nothing. Link it with link_contact if the user knows it.`
      }
    }
    handle = found.handle
  }

  try {
    const read = await deps[channel]({ handle, limit })
    if (read.status !== 'ok') {
      return { channel, status: read.status, confidence, items: [], detail: read.detail }
    }
    const report: ChannelReport = {
      channel,
      status: 'ok',
      confidence,
      items: read.items.slice(0, limit).map((item) => attribute(item, channel))
    }
    if (read.detail) report.detail = read.detail
    return report
  } catch (err) {
    // One channel throwing must not lose the other three.
    return {
      channel,
      status: 'error',
      confidence,
      items: [],
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Validate the optional channel filter. */
function parseChannels(
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

/**
 * Render the payload the model reasons over.
 *
 * JSON with a one-line preamble: the preamble is what stops a local model
 * treating a bare object as something to echo, and the JSON is what keeps who /
 * where / when / what separable rather than fused into prose the model would
 * have to re-parse.
 */
export function renderSummary(summary: InboxSummaryData): string {
  return [
    'Unified inbox read (structured). Compose the summary from this; do not invent items,',
    'and when a channel status is not "ok", say you could not check it rather than implying silence.',
    JSON.stringify(summary, null, 2)
  ].join('\n')
}

// ── the outbound half ───────────────────────────────────────────────────────

/** Longest summary body accepted, matching the practical size of an email. */
export const MAX_SUMMARY_CHARS = 20_000

/**
 * Email a summary to someone. HITL-gated and in DESTRUCTIVE_TOOLS, exactly like
 * send_email — it puts a real message in a real stranger's inbox.
 *
 * The recipient is resolved, never invented. "Mail this to him" with no linked
 * address fails with a question, and that refusal is the point of the tool: the
 * alternative is picking the most plausible address in the contact list, which
 * is how a private summary reaches the wrong person.
 */
export async function sendSummaryEmail(args: Record<string, unknown>): Promise<ToolResult> {
  if (!isUnifiedInboxEnabled()) return { ok: false, error: GATE_MESSAGE }

  const recipientArg = typeof args.recipient === 'string' ? args.recipient.trim() : ''
  const summary = typeof args.summary === 'string' ? args.summary : ''
  const subject = typeof args.subject === 'string' ? args.subject.trim() : ''

  if (!recipientArg) return { ok: false, error: 'send_summary_email requires a "recipient".' }
  if (!summary.trim()) {
    return {
      ok: false,
      error:
        'send_summary_email requires a "summary" — the text to send. Write the summary first ' +
        '(from summarize_inbox or the conversation) and pass it here.'
    }
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    return { ok: false, error: `send_summary_email: "summary" exceeds ${MAX_SUMMARY_CHARS} characters.` }
  }

  const address = resolveRecipient(recipientArg)
  if ('error' in address) return { ok: false, error: `send_summary_email: ${address.error}` }

  if (!isGmailConnected()) {
    return { ok: false, error: 'Gmail is not connected. Open Settings → Gmail and click Connect.' }
  }

  const result = await sendGmailMessage({
    to: [address.email],
    subject: subject || 'Summary',
    body: summary
  })
  if (!result.ok) return { ok: false, error: result.error ?? 'send_summary_email failed.' }
  return { ok: true, output: result.output ?? `Sent the summary to ${address.email}.` }
}

/**
 * Turn what the user called the recipient into an address, or explain what is
 * missing. Never falls back to "the only address we know".
 */
export function resolveRecipient(
  recipient: string
): { email: string; via: 'address' | 'contact'; name?: string } | { error: string } {
  const raw = recipient.trim()
  // An address typed straight out is taken at face value — there is nothing to
  // resolve and nothing to guess.
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return { email: raw, via: 'address' }

  const resolution = resolveContact(raw)
  if (resolution.status !== 'resolved') return { error: explainUnresolved(resolution, raw) }

  const email = emailForContact(resolution)
  if (!email) {
    return {
      error:
        `${resolution.contact.display_name} is a known contact, but no email address is linked for ` +
        `them, so there is nowhere to send this. ASK the user which address to use — do not guess ` +
        `one — then link it with link_contact (channel "gmail") and try again.`
    }
  }
  return { email, via: 'contact', name: resolution.contact.display_name }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const inboxToolSchemas: ToolSchema[] = [
  {
    name: 'summarize_inbox',
    description:
      'Read recent and unread activity across WhatsApp, Telegram, Slack and Gmail at once and return ' +
      'it as structured data for you to summarise. Use this for "what\'s my summary", "catch me up", ' +
      '"anything new", or "is there anything from <person>". Pass "contact" to scope it to one person — ' +
      'that requires the person to be known (see list_contacts / link_contact) and will fail rather than ' +
      'guess who is meant. Read-only: it never sends, replies, or drafts. Note that reading WhatsApp ' +
      'brings its window to the front. Each channel reports its own status — when a status is not "ok", ' +
      'tell the user you could not check that channel instead of implying there was nothing there.',
    parameters: {
      type: 'object',
      properties: {
        contact: {
          type: 'string',
          description:
            'Optional. Scope the read to one person, by the name the user used ("Ashu") or by a handle ' +
            '("ashu@acme.com"). Omit for a whole-inbox summary.'
        },
        channels: {
          type: 'array',
          description:
            'Optional. Restrict to some channels, e.g. ["slack","gmail"]. Omit to read all four.',
          items: { type: 'string' }
        },
        limit: {
          type: 'number',
          description: `How many items to return per channel (1–${MAX_ITEM_LIMIT}, default ${DEFAULT_ITEM_LIMIT}).`
        }
      },
      required: []
    }
  },
  {
    name: 'send_summary_email',
    description:
      'Email a summary (or any prepared text) to someone. Use this for "mail that to <person>" after ' +
      'summarising. The recipient must be an email address or a contact with a linked Gmail address — ' +
      'if the person is known but has no address linked, this REFUSES and tells you to ask the user ' +
      'which address to use. Never invent an address. This sends a real email that cannot be unsent ' +
      'and always asks the user to confirm first.',
    parameters: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description:
            'Who to send to: an email address, or the name of a known contact ("Ashu") whose Gmail ' +
            'address has been linked.'
        },
        summary: {
          type: 'string',
          description: 'The text to send — write the summary yourself and pass it here.'
        },
        subject: { type: 'string', description: 'Optional subject line. Defaults to "Summary".' }
      },
      required: ['recipient', 'summary']
    }
  }
]

/**
 * Registry entries. summarize_inbox needs WhatsApp's screen readers, which live
 * in tools.ts, so it is wired there rather than exported ready-made here.
 */
export function inboxRegistry(
  whatsapp: WhatsAppReaders
): Record<string, (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>> {
  const deps = defaultInboxDeps(whatsapp)
  return {
    summarize_inbox: (args) => summarizeInbox(args, deps),
    send_summary_email: (args) => sendSummaryEmail(args)
  }
}
