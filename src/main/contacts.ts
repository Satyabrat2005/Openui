/**
 * contacts — the contact-identity layer the unified inbox is built on.
 *
 * THE PROBLEM. "Is there anything from him?" names a person. The four messaging
 * surfaces do not agree on what a person is:
 *
 *   WhatsApp  a chat NAME             ("Ashu")            — a display name
 *   Slack     a user id or @handle    ("U024BE7LH")       — display name exposed alongside
 *   Telegram  a numeric chat_id       ("123456789")       — NO name anywhere
 *   Gmail     an email address        ("ashu@acme.com")   — NO name derivable
 *
 * Two of those carry the person's name; two do not. A Telegram chat_id is the
 * hard case and the reason this module exists: nothing about "123456789" can be
 * matched against the word "Ashu" by any amount of cleverness, so before this
 * layer a Telegram thread simply could not participate in a person-scoped
 * question. It is not a ranking problem — the information is absent.
 *
 * THE RULE, and it is deliberately asymmetric:
 *
 *   • Where a channel exposes a display name (WhatsApp, Slack), USE IT. A
 *     contact resolves to those channels with no setup, via
 *     {@link handleForChannel}'s display-name fallback.
 *   • Where it does not (Telegram, Gmail), require an EXPLICIT one-time link
 *     from the user — "this Telegram chat is Ashu" — and never guess. There is
 *     no fallback for these, so the caller gets null and must ask.
 *
 * Guessing here is not a small error. The wrong guess reads a stranger's
 * messages into a summary, or mails one person's private thread to another.
 * Every resolution path in this file therefore either resolves for a reason it
 * can name, or fails and says what is missing.
 */
import { database } from './database'
import type { ContactRow, ContactIdentityRow } from './database'
import { CHANNEL_LABELS, type MemoryChannel } from './channelMemory'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

/** The four surfaces a person can be reached on. Matches channelMemory's set. */
export type IdentityChannel = MemoryChannel

export const IDENTITY_CHANNELS: readonly IdentityChannel[] = [
  'whatsapp',
  'telegram',
  'slack',
  'gmail'
]

export { CHANNEL_LABELS }

/**
 * Channels whose own listings carry the person's display name, so a contact can
 * be looked up there by name alone with no link.
 *
 * WhatsApp is searched by chat name — the name IS the handle. Slack returns a
 * `username` on every message it hands back. Telegram and Gmail are absent by
 * design: a chat_id and an email address cannot be derived from "Ashu", and
 * pretending otherwise is exactly the guess this layer exists to prevent.
 */
export const NAME_BEARING_CHANNELS: readonly IdentityChannel[] = ['whatsapp', 'slack']

/** True when `value` is one of the four supported channels. */
export function isIdentityChannel(value: string): value is IdentityChannel {
  return (IDENTITY_CHANNELS as readonly string[]).includes(value)
}

// Local, deliberately loose. This validates a handle before it is STORED; the
// authority at send time is still gmail.ts's own normalizeRecipients. Keeping
// the check here means the identity layer — which everything else builds on —
// pulls in no OAuth module to answer "is this shaped like an address?".
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
// Mirrors telegram.ts's accepted chat_id forms: a signed integer, or a public
// "@channelusername".
const TELEGRAM_ID_RE = /^-?\d{1,20}$/
// The leading "@" is REQUIRED, exactly as telegram.ts's own isValidChatId
// requires it. Making it optional here accepted a bare "Ashu" as a Telegram
// handle — the precise mistake this validation exists to catch, since the link
// would store fine and then match nothing on every subsequent read.
const TELEGRAM_USERNAME_RE = /^@[A-Za-z0-9_]{4,32}$/

/** Longest handle or name accepted, so a pasted document can't become a contact. */
export const MAX_IDENTITY_CHARS = 128

/**
 * The stable lookup key for a person's name.
 *
 * Same shape as channelMemory's normalizeSubject — lowercased, sigil-stripped,
 * whitespace-collapsed — because the two indexes are queried with the same
 * words and a divergence would make a contact findable in one and not the other.
 */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/^[#@]+/, '').replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The stable lookup key for a handle on one channel.
 *
 * Channel-specific because the sigils mean different things: "@ashu" and "ashu"
 * are the same Slack handle, while a Telegram "-100123" must keep its sign (it
 * distinguishes a group from a user). Gmail addresses are case-insensitive.
 */
export function normalizeHandle(channel: IdentityChannel, raw: string): string {
  const trimmed = raw.trim()
  switch (channel) {
    case 'gmail':
      return trimmed.toLowerCase()
    case 'telegram':
      // Numeric ids keep their sign; @usernames are matched without the sigil.
      return TELEGRAM_ID_RE.test(trimmed) ? trimmed : trimmed.replace(/^@/, '').toLowerCase()
    case 'slack':
      return trimmed.replace(/^[#@]+/, '').toLowerCase()
    case 'whatsapp':
      return trimmed.replace(/\s+/g, ' ').toLowerCase()
  }
}

/**
 * Reject a handle that cannot possibly work on its channel, with a message that
 * says what the right shape is. Returns null when the handle is acceptable.
 *
 * This runs before anything is stored. A Telegram link to "Ashu" would be
 * accepted by the database and then fail on every single read, at which point
 * the user has no idea their one-time link silently did nothing.
 */
export function validateHandle(channel: IdentityChannel, handle: string): string | null {
  const trimmed = handle.trim()
  if (!trimmed) return 'the handle is empty.'
  if (trimmed.length > MAX_IDENTITY_CHARS) {
    return `the handle is too long (max ${MAX_IDENTITY_CHARS} characters).`
  }
  if (channel === 'gmail' && !EMAIL_RE.test(trimmed)) {
    return `"${trimmed}" is not an email address. A Gmail identity must be an address like "ashu@acme.com".`
  }
  if (channel === 'telegram') {
    const numeric = TELEGRAM_ID_RE.test(trimmed)
    const username = TELEGRAM_USERNAME_RE.test(trimmed)
    if (!numeric && !username) {
      return (
        `"${trimmed}" is not a Telegram chat id. Use the numeric id shown by list_telegram_chats ` +
        '(e.g. "123456789", or "-1001234567890" for a group) or a public "@channelusername".'
      )
    }
  }
  return null
}

/** A person plus every handle they are reachable at. */
export interface ResolvedContact {
  contact: ContactRow
  identities: ContactIdentityRow[]
}

/**
 * The outcome of looking a person up. Ambiguity is a distinct state rather than
 * a silently-picked first match: two people called "Ashu" is a question for the
 * user, not a coin flip whose loser gets someone else's messages.
 */
export type ContactResolution =
  | ({ status: 'resolved' } & ResolvedContact)
  | { status: 'unknown'; query: string }
  | { status: 'ambiguous'; query: string; candidates: ContactRow[] }

function withIdentities(contact: ContactRow): ResolvedContact {
  return { contact, identities: database.contacts.identitiesForContact(contact.id) }
}

/**
 * Resolve the person a query names, by exact name, then by handle, then by a
 * UNIQUE partial name match.
 *
 * The three passes are ordered by how much evidence they carry, and the last one
 * only fires when it is unambiguous — "Ashu" matching the single contact "Ashu
 * Kumar" is a safe read; "Ashu" matching two people is not, and returns
 * `ambiguous` so the caller can ask which one.
 */
export function resolveContact(query: string): ContactResolution {
  const raw = query.trim()
  if (!raw) return { status: 'unknown', query }

  const nameKey = normalizeName(raw)
  const byName = database.contacts.findContactByNameKey(nameKey)
  if (byName) return { status: 'resolved', ...withIdentities(byName) }

  // A handle, not a name: "mail this to ashu@acme.com" or a bare chat_id.
  for (const channel of IDENTITY_CHANNELS) {
    const identity = database.contacts.findIdentity(channel, normalizeHandle(channel, raw))
    if (!identity) continue
    const contact = database.contacts.findContactById(identity.contact_id)
    if (contact) return { status: 'resolved', ...withIdentities(contact) }
  }

  // Partial name — only when exactly one person matches.
  const matches = database.contacts
    .listContacts()
    .map((c) => c.contact)
    .filter((c) => nameMatchesPartially(c.name_key, nameKey))
  if (matches.length === 1) return { status: 'resolved', ...withIdentities(matches[0]) }
  if (matches.length > 1) return { status: 'ambiguous', query: raw, candidates: matches }

  return { status: 'unknown', query: raw }
}

/**
 * True when `nameKey` names the same person as `queryKey` on a whole-word basis
 * — "ashu" matches "ashu kumar", but "ash" matches neither.
 *
 * Substring matching would make "ash" resolve to "Ashu" and "Ashley" alike, and
 * a prefix rule fails the equally common "Kumar" → "Ashu Kumar". Whole tokens
 * are the conservative reading of both.
 */
function nameMatchesPartially(nameKey: string, queryKey: string): boolean {
  const nameTokens = new Set(nameKey.split(' ').filter(Boolean))
  const queryTokens = queryKey.split(' ').filter(Boolean)
  if (queryTokens.length === 0) return false
  return queryTokens.every((t) => nameTokens.has(t))
}

/**
 * The handle to use for `contact` on `channel`, or null when there is none.
 *
 * An explicit link always wins. Failing that, WhatsApp and Slack fall back to
 * the contact's display name, because those channels' own listings carry names
 * and searching them by name is what a human would do. Telegram and Gmail get
 * NO fallback — returning the display name there would produce a chat_id of
 * "Ashu", which is not merely useless but actively wrong: it would send the
 * caller off to read a chat that does not exist and report nothing found, which
 * is indistinguishable from "he hasn't messaged you".
 */
export function handleForChannel(
  resolved: ResolvedContact,
  channel: IdentityChannel
): { handle: string; source: 'link' | 'display-name' } | null {
  const linked = resolved.identities.find((i) => i.channel === channel)
  if (linked) return { handle: linked.handle, source: 'link' }
  if (NAME_BEARING_CHANNELS.includes(channel)) {
    return { handle: resolved.contact.display_name, source: 'display-name' }
  }
  return null
}

/** The email address to mail this person at, or null when none is linked. */
export function emailForContact(resolved: ResolvedContact): string | null {
  return handleForChannel(resolved, 'gmail')?.handle ?? null
}

/**
 * Record that `handle` on `channel` belongs to the person called `name`,
 * creating the person if they are new.
 *
 * `source` distinguishes a link the user stated from one derived from a display
 * name the channel published, so list_contacts can show which is which.
 */
export function linkIdentity(input: {
  name: string
  channel: IdentityChannel
  handle: string
  source?: 'user' | 'auto'
}): { ok: true; contact: ContactRow; identity: ContactIdentityRow } | { ok: false; error: string } {
  const displayName = input.name.trim()
  if (!displayName) return { ok: false, error: 'a contact name is required.' }
  if (displayName.length > MAX_IDENTITY_CHARS) {
    return { ok: false, error: `the contact name is too long (max ${MAX_IDENTITY_CHARS} characters).` }
  }
  const handleError = validateHandle(input.channel, input.handle)
  if (handleError) return { ok: false, error: handleError }

  const contact = database.contacts.upsertContact(displayName, normalizeName(displayName))
  const identity = database.contacts.putIdentity({
    contactId: contact.id,
    channel: input.channel,
    handle: input.handle.trim(),
    handleKey: normalizeHandle(input.channel, input.handle),
    source: input.source ?? 'user'
  })
  return { ok: true, contact, identity }
}

/** One line describing a person and where they are reachable, for tool output. */
export function describeContact(resolved: ResolvedContact): string {
  if (resolved.identities.length === 0) {
    return `${resolved.contact.display_name} — no channel handles linked yet.`
  }
  const parts = resolved.identities.map(
    (i) => `${CHANNEL_LABELS[i.channel as IdentityChannel] ?? i.channel}: ${i.handle}${i.source === 'auto' ? ' (auto)' : ''}`
  )
  return `${resolved.contact.display_name} — ${parts.join(', ')}`
}

/**
 * The message to hand back when a person cannot be resolved. Names what is
 * missing and what would fix it, because "unknown contact" leaves the model
 * with nothing to say except a guess.
 */
export function explainUnresolved(resolution: ContactResolution, query: string): string {
  if (resolution.status === 'ambiguous') {
    const names = resolution.candidates.map((c) => c.display_name).join(', ')
    return `"${query}" matches more than one contact (${names}). Ask the user which one they mean.`
  }
  return (
    `No contact named "${query}" is known. Ask the user who they mean, and link them with ` +
    'link_contact (for example: link_contact name="Ashu" channel="telegram" handle="123456789"). ' +
    'Do NOT guess a phone number, chat id, or email address.'
  )
}

// ── tool implementations ──────────────────────────────────────────────────────

/**
 * Teach the app that one channel handle belongs to one person. This is the
 * "the user tells Splen this Telegram chat is Ashu, once" step.
 *
 * Local and reversible (unlink_contact undoes it), touching nothing outside the
 * user's own database, so it is deliberately NOT in STATE_CHANGING_TOOLS: a
 * confirmation dialog on writing down a name the user just said out loud is
 * friction with no safety return.
 */
async function link_contact(args: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const channelRaw = typeof args.channel === 'string' ? args.channel.trim().toLowerCase() : ''
  const handle = typeof args.handle === 'string' ? args.handle.trim() : ''

  if (!name) return { ok: false, error: 'link_contact requires a "name" (the person this handle belongs to).' }
  if (!isIdentityChannel(channelRaw)) {
    return {
      ok: false,
      error: `link_contact: "channel" must be one of ${IDENTITY_CHANNELS.join(', ')}; got "${channelRaw}".`
    }
  }
  if (!handle) return { ok: false, error: 'link_contact requires a "handle".' }

  const result = linkIdentity({ name, channel: channelRaw, handle, source: 'user' })
  if (!result.ok) return { ok: false, error: `link_contact: ${result.error}` }

  const resolved = withIdentities(result.contact)
  return {
    ok: true,
    output: `Linked ${CHANNEL_LABELS[channelRaw]} "${handle}" to ${result.contact.display_name}.\n${describeContact(resolved)}`
  }
}

/** List every known person and the handles they are reachable at. Read-only. */
async function list_contacts(): Promise<ToolResult> {
  const all = database.contacts.listContacts()
  if (all.length === 0) {
    return {
      ok: true,
      output:
        'No contacts are linked yet. Use link_contact when the user says who a chat id, ' +
        'handle, or email address belongs to.'
    }
  }
  const lines = all.map((c) => `- ${describeContact(c)}`)
  return { ok: true, output: `${all.length} linked contact(s):\n${lines.join('\n')}` }
}

/**
 * Forget one channel handle for a person, or the whole person when `channel` is
 * omitted. The correction path for a link made against the wrong person.
 */
async function unlink_contact(args: Record<string, unknown>): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const channelRaw = typeof args.channel === 'string' ? args.channel.trim().toLowerCase() : ''
  if (!name) return { ok: false, error: 'unlink_contact requires a "name".' }
  if (channelRaw && !isIdentityChannel(channelRaw)) {
    return {
      ok: false,
      error: `unlink_contact: "channel" must be one of ${IDENTITY_CHANNELS.join(', ')}; got "${channelRaw}".`
    }
  }
  const channel: IdentityChannel | null = channelRaw ? (channelRaw as IdentityChannel) : null

  const resolution = resolveContact(name)
  if (resolution.status !== 'resolved') {
    return { ok: false, error: `unlink_contact: ${explainUnresolved(resolution, name)}` }
  }

  if (!channel) {
    database.contacts.deleteContact(resolution.contact.id)
    return { ok: true, output: `Forgot ${resolution.contact.display_name} and all their linked handles.` }
  }

  const identity = resolution.identities.find((i) => i.channel === channel)
  if (!identity) {
    return {
      ok: false,
      error: `unlink_contact: ${resolution.contact.display_name} has no ${CHANNEL_LABELS[channel]} handle linked.`
    }
  }
  database.contacts.deleteIdentity(channel, identity.handle_key)
  return {
    ok: true,
    output: `Unlinked ${CHANNEL_LABELS[channel]} "${identity.handle}" from ${resolution.contact.display_name}.`
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const contactToolSchemas: ToolSchema[] = [
  {
    name: 'link_contact',
    description:
      'Remember that a messaging handle belongs to a specific person, so later requests like ' +
      '"is there anything from him" can match that person across channels. Use this when the user ' +
      'tells you who a handle belongs to (e.g. "the Telegram chat 123456789 is Ashu", ' +
      '"Ashu\'s email is ashu@acme.com"). REQUIRED for Telegram and Gmail, which expose no name of ' +
      'their own — never guess a chat id or an email address, ask the user and link it. ' +
      'WhatsApp and Slack already show display names, so they usually need no link. Stored locally.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The person this handle belongs to, as the user refers to them (e.g. "Ashu").'
        },
        channel: {
          type: 'string',
          description: 'Which surface the handle is on.',
          enum: ['whatsapp', 'telegram', 'slack', 'gmail']
        },
        handle: {
          type: 'string',
          description:
            'The handle as that channel uses it: a WhatsApp chat name, a Telegram numeric chat_id ' +
            'or "@username", a Slack user id or @handle, or an email address.'
        }
      },
      required: ['name', 'channel', 'handle']
    }
  },
  {
    name: 'list_contacts',
    description:
      'List the people the app knows, with the WhatsApp / Telegram / Slack / Gmail handles linked to ' +
      'each. Read-only. Use it to check whether a person the user named is actually resolvable ' +
      'before acting on their behalf.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'unlink_contact',
    description:
      'Forget a linked handle for a person, or the whole person when "channel" is omitted. ' +
      'Use this to correct a link that was made against the wrong person. Local only.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The person to unlink.' },
        channel: {
          type: 'string',
          description: 'Optional. Only forget this channel\'s handle; omit to forget the person entirely.',
          enum: ['whatsapp', 'telegram', 'slack', 'gmail']
        }
      },
      required: ['name']
    }
  }
]

export const contactRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  link_contact,
  list_contacts: () => list_contacts(),
  unlink_contact
}
