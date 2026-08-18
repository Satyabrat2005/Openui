/**
 * slack.ts — real Slack integration for the OpenUI agent (Part 6.4).
 *
 * Self-contained tool module (schemas + registry) mirroring figma.ts. Tools:
 *   send_slack_message(channel, text)     — post a message (HITL-gated)
 *   list_slack_channels()                 — the workspace's channels
 *   read_slack_channel(channel, limit)    — recent messages in a channel
 *   search_slack(query)                   — search messages across the workspace
 *
 * Replaces driving Slack through computer_use's generic vision loop (which needs
 * a manually-granted typing permission and is as unreliable as any untooled
 * app) with Slack's documented Web API.
 *
 * CREDENTIAL — a user-supplied Slack token, entered in Settings → Slack (with a
 * SLACK_TOKEN env-var fallback for dev). Exactly the Figma/GitHub reasoning: a
 * Slack token is a personal/workspace credential the user owns, NOT our shared,
 * server-side LLM key — so the right fix is a Settings field kept in the main
 * process, never a proxy. Uses node:https directly (same lightweight approach as
 * gmail.ts / figma.ts) so there is no @slack/web-api dependency to carry.
 *
 * Token scopes (for the user setting one up): a Bot token (xoxb-) with
 * chat:write, channels:read, channels:history covers send/list/read. search
 * needs search:read, which is only grantable to a USER token (xoxp-) — so
 * search_slack surfaces a clear message if the token can't search rather than
 * failing opaquely.
 *
 * SECURITY:
 *   - The token stays in the main process; the renderer only writes the setting.
 *   - channel/query/text are length-capped; read `limit` is clamped.
 *   - API output is capped to avoid flooding the model's context.
 *   - send_slack_message is registered in STATE_CHANGING_TOOLS + DESTRUCTIVE_TOOLS
 *     (it messages other people — same outward-facing boundary as send_email /
 *     send_whatsapp_message), so it ALWAYS asks for confirmation.
 */

import { request as httpsRequest } from 'node:https'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

export const SLACK_TOKEN_SETTING_KEY = 'slack_token'

const API_HOST = 'slack.com'
const MAX_TEXT_CHARS = 4_000
const MAX_QUERY_CHARS = 500
const MAX_READ_LIMIT = 100
const DEFAULT_READ_LIMIT = 20
const MAX_OUTPUT_CHARS = 40_000
// Hard ceiling on a single Slack round-trip; node:https sets no response
// timeout of its own, so a dead socket would otherwise hang the tool forever.
const REQUEST_TIMEOUT_MS = 20_000
// Slack channel IDs look like C0123ABCD / G… (private) / D… (DM): an uppercase
// letter followed by uppercase alphanumerics. Used to skip name→ID resolution.
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{6,}$/

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── credential (lazy-required so unit tests never boot better-sqlite3) ─────────

function readSetting(key: string): string {
  try {
    const { database } = require('./database') as typeof import('./database')
    const v: unknown = database.settings.getSetting(key)
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

/** Resolve the Slack token: env wins for dev, else the Settings value. */
export function getSlackToken(): string {
  return process.env.SLACK_TOKEN?.trim() || readSetting(SLACK_TOKEN_SETTING_KEY)
}

export function isSlackConnected(): boolean {
  return getSlackToken() !== ''
}

// ── pure helpers (exported for unit tests) ──────────────────────────────────

/** True when a string is already a Slack channel/conversation ID. */
export function looksLikeChannelId(s: string): boolean {
  return CHANNEL_ID_RE.test(s)
}

/** Normalise a user-typed channel reference ("#general" → "general"). */
export function normalizeChannelName(s: string): string {
  return s.trim().replace(/^#/, '')
}

/** Map a Slack API error code to a human-friendly explanation. */
export function explainSlackError(code: string): string {
  switch (code) {
    case 'not_authed':
    case 'invalid_auth':
    case 'token_revoked':
      return 'the Slack token is missing, invalid, or revoked — re-enter it in Settings → Slack.'
    case 'channel_not_found':
      return 'no channel matched that name/ID (the bot may also need to be invited to it).'
    case 'not_in_channel':
      return 'the bot is not a member of that channel — invite it first.'
    case 'missing_scope':
      return 'the token lacks the required scope for this action (see Settings → Slack for scopes).'
    case 'not_allowed_token_type':
      return 'this action needs a user token (xoxp-) with search:read; a bot token cannot search Slack.'
    case 'ratelimited':
      return 'Slack rate-limited the request; try again shortly.'
    default:
      return `Slack API error: ${code}.`
  }
}

interface SlackResponse {
  ok: boolean
  error?: string
  [k: string]: unknown
}

// ── HTTPS transport ──────────────────────────────────────────────────────────

/**
 * Call a Slack Web API method. GET encodes params in the query string; POST
 * sends JSON. The token is sent as a Bearer header (never in the URL). Resolves
 * the parsed JSON body; rejects only on transport/parse failure (Slack's own
 * `ok:false` is returned for the caller to interpret via explainSlackError).
 */
function slackApi(
  method: string,
  httpMethod: 'GET' | 'POST',
  params: Record<string, string | number>
): Promise<SlackResponse> {
  const token = getSlackToken()
  if (!token) {
    return Promise.reject(
      new Error('No Slack token configured. Open Settings → Slack and paste a bot/user token, or set the SLACK_TOKEN env var.')
    )
  }

  const isGet = httpMethod === 'GET'
  const query = new URLSearchParams()
  if (isGet) for (const [k, v] of Object.entries(params)) query.set(k, String(v))
  const body = isGet ? undefined : JSON.stringify(params)
  const path = `/api/${method}${isGet && [...query].length ? `?${query.toString()}` : ''}`

  return new Promise<SlackResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: API_HOST,
        port: 443,
        path,
        method: httpMethod,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'OpenUI/1.0',
          ...(body
            ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
            : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          try {
            resolve(JSON.parse(raw) as SlackResponse)
          } catch {
            reject(new Error(`Slack returned non-JSON (HTTP ${res.statusCode ?? 0}): ${raw.slice(0, 200)}`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    // Without an explicit timeout an unresponsive socket leaves this promise
    // pending forever and the tool call never returns — the agent loop hangs
    // with nothing to report. destroy() routes through the 'error' handler
    // above, so the caller gets a real, named error instead.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Slack API did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${method}).`))
    })
    if (body) req.write(body)
    req.end()
  })
}

// conversations.list is cursor-paginated. Slack does NOT guarantee it returns
// `limit` results — the limit is a maximum "per page" hint and a page can come
// back short with a next_cursor, so a single call is not a reliable way to see
// every channel however high the limit is set. Pages are capped rather than
// followed forever, so a huge workspace degrades to a clear error instead of an
// unbounded API loop (Slack rate-limits conversations.list hard, tier 2).
const CHANNEL_PAGE_SIZE = 200
const MAX_CHANNEL_PAGES = 10

/**
 * Fetch the workspace's channels, following cursor pagination.
 *
 * Returns `truncated: true` when the page cap was hit before the cursor ran out,
 * so callers can say "I only looked at the first N" rather than claim a channel
 * does not exist on the strength of a partial list.
 */
async function fetchAllChannels(): Promise<
  { channels: Array<Record<string, unknown>>; truncated: boolean } | { error: string }
> {
  const all: Array<Record<string, unknown>> = []
  let cursor = ''
  for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
    const params: Record<string, string | number> = {
      types: 'public_channel,private_channel',
      limit: CHANNEL_PAGE_SIZE,
      exclude_archived: 'true'
    }
    if (cursor) params.cursor = cursor
    const res = await slackApi('conversations.list', 'GET', params)
    if (!res.ok) return { error: explainSlackError(res.error ?? 'unknown') }
    if (Array.isArray(res.channels)) all.push(...(res.channels as Array<Record<string, unknown>>))
    const meta = res.response_metadata as Record<string, unknown> | undefined
    cursor = typeof meta?.next_cursor === 'string' ? meta.next_cursor : ''
    if (!cursor) return { channels: all, truncated: false }
  }
  return { channels: all, truncated: true }
}

/** Resolve a channel reference to an ID. IDs pass through; names are looked up. */
async function resolveChannelId(ref: string): Promise<{ id: string } | { error: string }> {
  const trimmed = ref.trim()
  if (looksLikeChannelId(trimmed)) return { id: trimmed }
  const name = normalizeChannelName(trimmed)
  try {
    const listed = await fetchAllChannels()
    if ('error' in listed) return { error: listed.error }
    const match = listed.channels.find((c) => String(c.name ?? '').toLowerCase() === name.toLowerCase())
    if (!match) {
      // Distinguish "definitely absent" from "I ran out of pages" — the second
      // is not evidence the channel is missing, and saying so would send the
      // user hunting for a typo in a name that is actually fine.
      return {
        error: listed.truncated
          ? `no channel named "#${name}" in the first ${listed.channels.length} channels, and this workspace has more than that. Pass the channel ID (e.g. "C0123ABCD") instead — list_slack_channels shows IDs.`
          : `no channel named "#${name}" found (or the bot isn't in it).`
      }
    }
    return { id: String(match.id) }
  } catch (e) {
    return { error: errText(e) }
  }
}

// ── send_slack_message ──────────────────────────────────────────────────────

async function send_slack_message(args: Record<string, unknown>): Promise<ToolResult> {
  const channel = typeof args.channel === 'string' ? args.channel.trim() : ''
  const text = typeof args.text === 'string' ? args.text : ''
  if (!channel) return { ok: false, error: 'send_slack_message requires a "channel" (name like "#general" or an ID).' }
  if (!text.trim()) return { ok: false, error: 'send_slack_message requires non-empty "text".' }
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, error: `send_slack_message: "text" exceeds the ${MAX_TEXT_CHARS}-character limit.` }
  }

  try {
    // postMessage accepts a name or ID, but resolving to an ID first gives a
    // clear "channel not found" up front instead of a post that silently no-ops.
    const resolved = await resolveChannelId(channel)
    if ('error' in resolved) return { ok: false, error: `send_slack_message: ${resolved.error}` }
    const res = await slackApi('chat.postMessage', 'POST', { channel: resolved.id, text })
    if (!res.ok) return { ok: false, error: `send_slack_message: ${explainSlackError(res.error ?? 'unknown')}` }
    return { ok: true, output: `Sent message to ${channel} (ts ${String(res.ts ?? '?')}).` }
  } catch (e) {
    return { ok: false, error: `send_slack_message failed: ${errText(e)}` }
  }
}

// ── list_slack_channels ─────────────────────────────────────────────────────

async function list_slack_channels(): Promise<ToolResult> {
  try {
    const listed = await fetchAllChannels()
    if ('error' in listed) return { ok: false, error: `list_slack_channels: ${listed.error}` }
    const { channels, truncated } = listed
    if (channels.length === 0) return { ok: true, output: 'No channels found (the bot may need channels:read, or to be added to channels).' }
    const lines = channels
      .map((c) => `  #${String(c.name ?? '?')} (${String(c.id ?? '?')})${c.is_private ? ' [private]' : ''}${c.is_member === false ? ' [not a member]' : ''}`)
      .join('\n')
    // Say so when the list is partial, so neither the model nor the user reads
    // this as the complete set of channels.
    const header = truncated
      ? `First ${channels.length} channel(s) (more exist — list truncated):`
      : `${channels.length} channel(s):`
    return { ok: true, output: `${header}\n${lines}`.slice(0, MAX_OUTPUT_CHARS) }
  } catch (e) {
    return { ok: false, error: `list_slack_channels failed: ${errText(e)}` }
  }
}

// ── read_slack_channel ──────────────────────────────────────────────────────

async function read_slack_channel(args: Record<string, unknown>): Promise<ToolResult> {
  const channel = typeof args.channel === 'string' ? args.channel.trim() : ''
  if (!channel) return { ok: false, error: 'read_slack_channel requires a "channel" (name or ID).' }
  const rawLimit = Number(args.limit)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_READ_LIMIT, Math.round(rawLimit))) : DEFAULT_READ_LIMIT

  try {
    const resolved = await resolveChannelId(channel)
    if ('error' in resolved) return { ok: false, error: `read_slack_channel: ${resolved.error}` }
    const res = await slackApi('conversations.history', 'GET', { channel: resolved.id, limit })
    if (!res.ok) return { ok: false, error: `read_slack_channel: ${explainSlackError(res.error ?? 'unknown')}` }
    const messages = Array.isArray(res.messages) ? (res.messages as Array<Record<string, unknown>>) : []
    if (messages.length === 0) return { ok: true, output: `No recent messages in ${channel}.` }
    // History is newest-first; reverse so the transcript reads top-to-bottom.
    const lines = messages
      .slice()
      .reverse()
      .map((m) => {
        const user = String(m.user ?? m.username ?? m.bot_id ?? 'unknown')
        const txt = String(m.text ?? '').replace(/\s+/g, ' ').trim()
        return `  [${user}] ${txt}`
      })
      .join('\n')
    return { ok: true, output: `Last ${messages.length} message(s) in ${channel}:\n${lines}`.slice(0, MAX_OUTPUT_CHARS) }
  } catch (e) {
    return { ok: false, error: `read_slack_channel failed: ${errText(e)}` }
  }
}

// ── search_slack ────────────────────────────────────────────────────────────

async function search_slack(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { ok: false, error: 'search_slack requires a non-empty "query".' }
  if (query.length > MAX_QUERY_CHARS) return { ok: false, error: `search_slack: "query" is too long (limit ${MAX_QUERY_CHARS}).` }

  try {
    const res = await slackApi('search.messages', 'GET', { query, count: 20 })
    if (!res.ok) return { ok: false, error: `search_slack: ${explainSlackError(res.error ?? 'unknown')}` }
    const matches =
      res.messages && typeof res.messages === 'object' && Array.isArray((res.messages as Record<string, unknown>).matches)
        ? ((res.messages as Record<string, unknown>).matches as Array<Record<string, unknown>>)
        : []
    if (matches.length === 0) return { ok: true, output: `No messages matched "${query}".` }
    const lines = matches
      .map((m) => {
        const ch = ((m.channel as Record<string, unknown> | undefined)?.name as string) ?? '?'
        const user = String(m.username ?? m.user ?? 'unknown')
        const txt = String(m.text ?? '').replace(/\s+/g, ' ').trim()
        return `  #${ch} [${user}] ${txt}`
      })
      .join('\n')
    return { ok: true, output: `${matches.length} match(es) for "${query}":\n${lines}`.slice(0, MAX_OUTPUT_CHARS) }
  } catch (e) {
    return { ok: false, error: `search_slack failed: ${errText(e)}` }
  }
}

// ── structured read for the unified-inbox summary ───────────────────────────

/** One Slack message as structured data, for callers that reason over it. */
export interface SlackInboxMessage {
  /** "#eng" — the channel it was posted in. */
  channel: string
  channelId: string
  /** The raw Slack user id, e.g. "U024BE7LH". Always present when Slack gave one. */
  userId: string
  /** Display name when the workspace let us look it up, else the raw user id. */
  sender: string
  text: string
}

/** Channels read per summary, and messages per channel. Slack rate-limits hard. */
const INBOX_CHANNEL_LIMIT = 5
const INBOX_MESSAGES_PER_CHANNEL = 10

/**
 * Map Slack user ids to display names via users.list.
 *
 * Slack's conversations.history returns only a user ID — so without this step a
 * Slack message cannot be attributed to a named person at all, and Slack would
 * need an explicit contact link exactly like Telegram does. The lookup is what
 * makes Slack a name-bearing channel (see contacts.ts NAME_BEARING_CHANNELS).
 *
 * Degrades rather than fails: users.list needs the `users:read` scope, which a
 * minimal bot token may not have. On any failure this returns whatever it has
 * and the caller falls back to raw user ids, which still work for a contact whose
 * Slack user id was explicitly linked.
 *
 * users.list is cursor-paginated exactly like conversations.list — `limit` is a
 * per-page maximum, NOT a total. A single call therefore sees only the first
 * page, and on a workspace with more members than that every person beyond it
 * silently resolves to a raw `U0123ABCD` id: messages stop being attributable to
 * a name, which is the entire reason this lookup exists. Same bounded-walk
 * discipline as fetchAllChannels (users.list is rate-limited tier 2, so the walk
 * is capped rather than followed forever).
 */
const USER_PAGE_SIZE = 200
const MAX_USER_PAGES = 10

async function fetchUserNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    let cursor = ''
    for (let page = 0; page < MAX_USER_PAGES; page++) {
      const params: Record<string, string | number> = { limit: USER_PAGE_SIZE }
      if (cursor) params.cursor = cursor
      const res = await slackApi('users.list', 'GET', params)
      // Keep what earlier pages produced rather than discarding it: a partial
      // id→name map still names most people, which beats raw ids for everyone.
      if (!res.ok || !Array.isArray(res.members)) return names
      for (const raw of res.members as Array<Record<string, unknown>>) {
        const id = String(raw.id ?? '')
        if (!id) continue
        const profile = (raw.profile as Record<string, unknown> | undefined) ?? {}
        const label =
          String(profile.real_name ?? '') || String(raw.real_name ?? '') || String(raw.name ?? '')
        if (label) names.set(id, label)
      }
      const meta = res.response_metadata as Record<string, unknown> | undefined
      cursor = typeof meta?.next_cursor === 'string' ? meta.next_cursor : ''
      if (!cursor) break
    }
  } catch {
    /* no scope / transport failure — fall back to raw ids */
  }
  return names
}

/**
 * Read recent messages across the channels the token is a member of, as
 * structured data. Read-only.
 *
 * Scoped to member channels and capped at INBOX_CHANNEL_LIMIT: "summarise my
 * Slack" over a 200-channel workspace is both a rate-limit problem and a
 * relevance problem, and the cap is reported to the caller so the summary can
 * say it looked at a subset rather than implying it saw everything.
 *
 * A channel whose history call fails is reported in `skipped`, never dropped in
 * silence. slackApi RESOLVES on Slack's `ok:false` (see its doc comment), so a
 * rate-limited channel used to fall through a bare `continue` and vanish: it left
 * `channelsRead`, and `truncated` is derived only from the page cap and
 * INBOX_CHANNEL_LIMIT, so a partial read was returned labelled complete. "Nothing
 * from #eng" and "#eng could not be read" are opposite answers and must never
 * collapse into each other.
 */
export async function readSlackInbox(opts: { limit?: number }): Promise<
  | {
      ok: true
      messages: SlackInboxMessage[]
      channelsRead: string[]
      skipped: Array<{ channel: string; reason: string }>
      truncated: boolean
    }
  | { ok: false; error: string }
> {
  const perChannel = Math.max(
    1,
    Math.min(MAX_READ_LIMIT, Math.floor(opts.limit ?? INBOX_MESSAGES_PER_CHANNEL))
  )
  try {
    const listed = await fetchAllChannels()
    if ('error' in listed) return { ok: false, error: listed.error }

    const member = listed.channels.filter((c) => c.is_member !== false)
    const picked = member.slice(0, INBOX_CHANNEL_LIMIT)
    const names = await fetchUserNames()

    const messages: SlackInboxMessage[] = []
    const channelsRead: string[] = []
    const skipped: Array<{ channel: string; reason: string }> = []
    for (const channel of picked) {
      const id = String(channel.id ?? '')
      const name = `#${String(channel.name ?? '?')}`
      if (!id) continue
      let res: SlackResponse
      try {
        res = await slackApi('conversations.history', 'GET', { channel: id, limit: perChannel })
      } catch (e) {
        // One unreachable channel must not abandon the whole summary — but it
        // must not disappear from it either.
        skipped.push({ channel: name, reason: errText(e) })
        continue
      }
      if (!res.ok) {
        skipped.push({ channel: name, reason: explainSlackError(String(res.error ?? 'unknown')) })
        continue
      }
      channelsRead.push(name)
      const history = Array.isArray(res.messages)
        ? (res.messages as Array<Record<string, unknown>>)
        : []
      // Newest-first from Slack; reverse so the transcript reads chronologically.
      for (const m of history.slice().reverse()) {
        const userId = String(m.user ?? m.bot_id ?? '')
        messages.push({
          channel: name,
          channelId: id,
          userId,
          sender: names.get(userId) || String(m.username ?? '') || userId || 'unknown',
          text: String(m.text ?? '').replace(/\s+/g, ' ').trim()
        })
      }
    }
    // Every channel failing is not an empty inbox, and must not be returned as
    // one: "no messages" would be read as a real answer about a quiet workspace.
    if (channelsRead.length === 0 && skipped.length > 0) {
      return {
        ok: false,
        error: `No Slack channel could be read (${skipped
          .map((s) => `${s.channel}: ${s.reason}`)
          .join('; ')})`
      }
    }

    return {
      ok: true,
      messages,
      channelsRead,
      skipped,
      truncated: listed.truncated || member.length > picked.length
    }
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const slackToolSchemas: ToolSchema[] = [
  {
    name: 'send_slack_message',
    description:
      'Post a message to a Slack channel. Use this whenever the user wants to message a Slack channel ' +
      '(e.g. "tell #eng standup is at 10"). Pass the channel NAME straight through as the user said it — ' +
      '"#eng" or "eng" both work and are resolved to an ID for you, so do NOT call list_slack_channels ' +
      'first when the user already named the channel. Requires a Slack token (Settings → Slack). ' +
      'This ALWAYS asks the user to confirm before sending, since it messages other people.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g. "#general" or "general") or channel ID (e.g. "C0123ABCD").' },
        text: { type: 'string', description: 'The message text to post. Slack mrkdwn is supported.' }
      },
      required: ['channel', 'text']
    }
  },
  {
    name: 'list_slack_channels',
    description:
      'List the Slack channels the token can see (name, ID, private/membership flags). ' +
      'Use this ONLY when you do not already know which channel is meant — for example the user said ' +
      '"post this in the eng channel" and you need the exact name, or they asked what channels exist. ' +
      'If the user already named a channel (e.g. "#eng", "general"), do NOT call this first: ' +
      'send_slack_message and read_slack_channel take a channel NAME directly and resolve it themselves, ' +
      'so listing first just wastes a step. Requires a Slack token (Settings → Slack).',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'read_slack_channel',
    description:
      'Read the most recent messages in a Slack channel (read-only). Requires a Slack token (Settings → Slack).',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name or ID to read.' },
        limit: { type: 'number', description: `How many recent messages to fetch (1–${MAX_READ_LIMIT}, default ${DEFAULT_READ_LIMIT}).` }
      },
      required: ['channel']
    }
  },
  {
    name: 'search_slack',
    description:
      'Search Slack messages across the workspace for a query (read-only). NOTE: Slack only allows search ' +
      'with a user token (xoxp-) that has search:read — a bot token cannot search. Requires a Slack token (Settings → Slack).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (Slack search syntax supported, e.g. "in:#eng release").' }
      },
      required: ['query']
    }
  }
]

export const slackRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  send_slack_message,
  list_slack_channels,
  read_slack_channel,
  search_slack
}
