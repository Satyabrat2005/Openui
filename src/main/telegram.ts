/**
 * telegram.ts — Telegram messaging for the OpenUI agent, via the official Bot API.
 *
 * Deliberately NOT a WhatsApp-style screen-scrape. Telegram publishes a real,
 * simple, officially-supported Bot API (plain HTTPS + JSON), so this is the
 * *safer* next messaging platform: a bot account is exactly what the platform
 * is designed for, carrying none of the ToS/ban risk of automating a personal
 * WhatsApp session. No SDK dependency — the API is three request/response calls
 * over node:https, mirroring figma.ts (there is no long-poll runtime to run, so
 * telegraf/grammy/node-telegram-bot-api would add weight for nothing).
 *
 * Three tools:
 *   send_telegram_message(chat_id, text)        — send a message (outward; HITL-gated)
 *   list_telegram_chats()                        — chats the bot has recently seen
 *   read_telegram_messages(chat_id, limit)       — recent messages in one chat
 *
 * Authentication is a per-user BOT TOKEN the user creates via @BotFather and
 * pastes into Settings → Telegram (env var TELEGRAM_BOT_TOKEN is a local-dev
 * fallback). A bot token is inherently user-owned — like the Figma/GitHub PATs
 * it is a Settings field, never one of OUR proxied, shared credentials.
 *
 * PLATFORM CONSTRAINT (surfaced in every tool description so the model never
 * over-promises): the Bot API can only message a user who has ALREADY started a
 * conversation with the bot (or a group/channel the bot is a member of). A bot
 * cannot cold-message an arbitrary person by phone number or handle — that is a
 * platform rule, not a bug here. Likewise list/read work off getUpdates, which
 * only returns the last ~24 h of updates that have not been consumed by a
 * webhook; if the bot has a webhook set, getUpdates returns HTTP 409 and we
 * surface that verbatim.
 *
 * SECURITY:
 *   - The bot token is validated against TELEGRAM_TOKEN_RE before it is ever
 *     placed in the request PATH (the Bot API's mandated auth mechanism), so a
 *     malformed token can never inject extra path segments. It is never logged.
 *   - chat_id is validated (signed integer or @username) before any API call.
 *   - Message text is length-checked against Telegram's 4096-char limit.
 *   - Responses are capped to avoid context flooding; the token stays in the
 *     main process and never crosses the contextBridge.
 *   - Reads NEVER advance the getUpdates offset, so listing/reading is
 *     non-destructive: it never acknowledges/consumes the bot's update queue.
 */

import { request as httpsRequest } from 'node:https'
import type { ExecutorContext, ToolResult, ToolSchema } from './tools'

// Settings key under which the user's bot token is stored (Settings → Telegram).
// Keep in sync with the renderer's SettingsModal.
export const TELEGRAM_TOKEN_SETTING_KEY = 'telegram_bot_token'

// BotFather tokens look like "<bot_id>:<35-char alphanumeric/-/_ secret>", e.g.
// "123456789:AAHf...". Strict because this value goes into the URL PATH.
const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

// A chat_id is either a signed integer (private chats positive, groups/channels
// negative, e.g. "-1001234567890") or a public "@channelusername".
const NUMERIC_CHAT_ID_RE = /^-?\d{1,20}$/
const USERNAME_CHAT_ID_RE = /^@[A-Za-z0-9_]{4,32}$/

// Telegram's hard limit on a single message's text.
const MAX_MESSAGE_CHARS = 4096

// getUpdates returns at most 100 updates; clamp read_telegram_messages to it.
const MAX_READ_LIMIT = 100
const DEFAULT_READ_LIMIT = 20

/**
 * The getUpdates window both read tools fetch: the last MAX_READ_LIMIT updates.
 *
 * The offset MUST be negative. Bot API getUpdates with no offset returns
 * "updates starting with the earliest unconfirmed update" — the OLDEST of the
 * queue, not the newest. Both of these tools promise *recent* activity, so on a
 * bot with more than 100 queued updates the un-offset call returned the oldest
 * 100 and the newest messages were invisible: list_telegram_chats showed stale
 * chats and read_telegram_messages missed the message just sent. (formatMessages
 * takes .slice(-limit), but the last N of the oldest 100 is still stale.) A quiet
 * bot has a short queue, so this reads correct on an idle account and wrong on an
 * active one — exactly the case a live demo hits.
 *
 * A NEGATIVE offset is the documented way to read the tail: "retrieve updates
 * starting from -offset update from the end of the updates queue". It is also
 * still non-destructive — only an offset HIGHER than a previously received
 * update_id confirms/forgets updates, so this preserves the property the read
 * tools deliberately maintain (see the module header).
 */
const TAIL_UPDATES_PARAMS = { offset: -MAX_READ_LIMIT, limit: MAX_READ_LIMIT, timeout: 0 } as const

// Hard ceiling on a single Bot API round-trip. Without this an unresponsive
// socket leaves the promise pending forever and the tool call never returns —
// the agent loop hangs with no error to report. node:https has no default
// response timeout, so it must be set explicitly.
const REQUEST_TIMEOUT_MS = 20_000

// Cap tool output so a busy bot can't flood the context window.
const MAX_OUTPUT_CHARS = 12_000

// ── minimal Bot API shapes (only the fields we read) ──────────────────────────

interface TgChat {
  id: number
  type?: string
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

interface TgUser {
  id?: number
  username?: string
  first_name?: string
  last_name?: string
  is_bot?: boolean
}

interface TgMessage {
  message_id?: number
  date?: number
  text?: string
  caption?: string
  chat: TgChat
  from?: TgUser
}

interface TgUpdate {
  update_id?: number
  message?: TgMessage
  edited_message?: TgMessage
  channel_post?: TgMessage
  edited_channel_post?: TgMessage
}

interface TgApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

// ── token + validation helpers (pure, exported for tests) ─────────────────────

/**
 * Resolve the bot token: the "telegram_bot_token" app setting wins (the normal
 * case — pasted into Settings by end users), then the TELEGRAM_BOT_TOKEN env var
 * (local dev). Lazy-requires ./database so this module — and its unit tests —
 * never boot better-sqlite3 just to read a setting (mirrors github.ts).
 */
export function getTelegramToken(): string {
  try {
    const { database } = require('./database') as typeof import('./database')
    const stored: unknown = database.settings.getSetting(TELEGRAM_TOKEN_SETTING_KEY)
    if (typeof stored === 'string' && stored.trim()) return stored.trim()
  } catch {
    // database unavailable (e.g. under unit tests) — fall through to env.
  }
  return process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
}

/** True when a string is a well-formed BotFather token. */
export function isValidBotToken(token: string): boolean {
  return TELEGRAM_TOKEN_RE.test(token)
}

/** True when a string is a valid chat_id (signed integer or @username). */
export function isValidChatId(id: string): boolean {
  return NUMERIC_CHAT_ID_RE.test(id) || USERNAME_CHAT_ID_RE.test(id)
}

/**
 * Build the API request path for a method. The token is validated by the caller
 * before this runs, but we assert the invariant here too so a bad token can
 * never widen the path. `method` is a fixed internal string, never user input.
 */
export function telegramPath(token: string, method: string): string {
  if (!TELEGRAM_TOKEN_RE.test(token)) {
    throw new Error('telegramPath: refusing to build a path with a malformed bot token.')
  }
  return `/bot${token}/${method}`
}

/** Pick the single message a getUpdates entry carries, whatever its kind. */
export function extractMessage(update: TgUpdate): TgMessage | null {
  return (
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post ??
    null
  )
}

/** Human-readable label for a chat (person name, @username, or group title). */
export function describeChat(chat: TgChat): string {
  if (chat.type === 'private') {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim()
    if (name) return name
  }
  if (chat.title) return chat.title
  if (chat.username) return `@${chat.username}`
  return String(chat.id)
}

/** Human-readable label for the sender of a message. */
function describeSender(from: TgUser | undefined, chat: TgChat): string {
  if (from) {
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
    if (name) return name
    if (from.username) return `@${from.username}`
  }
  // Channel posts have no `from`; fall back to the channel's own name.
  return describeChat(chat)
}

/** True when a chat matches the id the user asked for (numeric id or @username). */
function chatMatches(chat: TgChat, wanted: string): boolean {
  if (wanted.startsWith('@')) {
    return typeof chat.username === 'string' && chat.username.toLowerCase() === wanted.slice(1).toLowerCase()
  }
  return String(chat.id) === wanted
}

/** ISO-ish "YYYY-MM-DD HH:MM" from a Telegram unix (seconds) timestamp. */
function fmtTime(unixSeconds: number | undefined): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return '?'
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Collapse a getUpdates array into the distinct chats the bot has seen, most
 * recently active first. Pure — unit-tested without any network.
 */
export function formatChats(updates: TgUpdate[]): string {
  const byId = new Map<number, { chat: TgChat; lastDate: number }>()
  for (const update of updates) {
    const msg = extractMessage(update)
    if (!msg || !msg.chat || typeof msg.chat.id !== 'number') continue
    const prev = byId.get(msg.chat.id)
    const date = msg.date ?? 0
    if (!prev || date >= prev.lastDate) byId.set(msg.chat.id, { chat: msg.chat, lastDate: date })
  }
  if (byId.size === 0) {
    return (
      'No chats found. The bot only sees a chat after someone messages it (or ' +
      'adds it to a group). Ask the recipient to open the bot and press Start first. ' +
      '(getUpdates also only returns roughly the last 24 h of activity.)'
    )
  }
  const rows = [...byId.values()]
    .sort((a, b) => b.lastDate - a.lastDate)
    .map(({ chat, lastDate }) => {
      const kind = chat.type ?? 'chat'
      return `- ${describeChat(chat)} — id: ${chat.id} (${kind}, last activity ${fmtTime(lastDate)})`
    })
  return `Chats the bot has seen (${rows.length}):\n${rows.join('\n')}`.slice(0, MAX_OUTPUT_CHARS)
}

/**
 * Filter+format the recent messages of one chat from a getUpdates array. Pure —
 * unit-tested without any network. Returns the last `limit` messages, oldest
 * first (chronological reading order).
 */
export function formatMessages(updates: TgUpdate[], chatId: string, limit: number): string {
  const msgs: TgMessage[] = []
  for (const update of updates) {
    const msg = extractMessage(update)
    if (msg && msg.chat && chatMatches(msg.chat, chatId)) msgs.push(msg)
  }
  if (msgs.length === 0) {
    return (
      `No recent messages found for chat "${chatId}". The Bot API only returns ` +
      'updates from roughly the last 24 h that a webhook has not already consumed, ' +
      'and only for chats the bot is part of.'
    )
  }
  msgs.sort((a, b) => (a.date ?? 0) - (b.date ?? 0))
  const recent = msgs.slice(-Math.max(1, limit))
  const lines = recent.map((m) => {
    const body = m.text ?? m.caption ?? '(non-text message)'
    // The message_id is printed because it is the ONLY handle a caller has for
    // replying in-thread: send_telegram_message's reply_to_message_id needs it,
    // and there is no other way to obtain one. Without it the model can read a
    // conversation but can only ever answer it as a detached new message.
    const id = m.message_id != null ? ` #${m.message_id}` : ''
    return `[${fmtTime(m.date)}]${id} ${describeSender(m.from, m.chat)}: ${body}`
  })
  return `Last ${recent.length} message(s) in chat "${chatId}":\n${lines.join('\n')}`.slice(
    0,
    MAX_OUTPUT_CHARS
  )
}

// ── Bot API transport ─────────────────────────────────────────────────────────

/**
 * POST a JSON body to a Bot API method and return the parsed envelope. Rejects
 * with a descriptive Error on transport failure or a non-JSON body; API-level
 * failures (ok:false) are returned to the caller to surface Telegram's own
 * `description` (e.g. 409 webhook conflict, 401 unauthorized).
 */
function telegramCall<T>(method: string, body: Record<string, unknown>): Promise<TgApiResponse<T>> {
  const token = getTelegramToken()
  if (!token) {
    return Promise.reject(
      new Error(
        'No Telegram bot token configured. Open Settings → Telegram and paste the ' +
          'token @BotFather gave you (or set the TELEGRAM_BOT_TOKEN environment variable).'
      )
    )
  }
  if (!isValidBotToken(token)) {
    return Promise.reject(
      new Error(
        'The configured Telegram bot token is malformed (expected "<bot_id>:<secret>" ' +
          'from @BotFather). Re-copy it in Settings → Telegram.'
      )
    )
  }

  const bodyStr = JSON.stringify(body)
  return new Promise<TgApiResponse<T>>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: telegramPath(token, method),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Accept: 'application/json',
          'User-Agent': 'OpenUI/1.0'
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          try {
            resolve(JSON.parse(raw) as TgApiResponse<T>)
          } catch {
            reject(new Error(`Telegram API returned non-JSON (HTTP ${res.statusCode ?? '?'}): ${raw.slice(0, 200)}`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    // Fail loudly rather than hang: destroy() makes the 'error' handler above
    // fire, so the caller gets a real error instead of a promise that never
    // settles. The message names the cause so the user isn't left guessing.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Telegram API did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${method}).`)
      )
    })
    req.write(bodyStr)
    req.end()
  })
}

/** Format an API-level failure into a user-facing error string (never leaks the token). */
function apiError(action: string, resp: TgApiResponse<unknown>): string {
  const code = resp.error_code ? ` (HTTP ${resp.error_code})` : ''
  const desc = resp.description || 'unknown error'
  if (resp.error_code === 409) {
    return `${action} failed${code}: ${desc}. This bot has a webhook set, so getUpdates is disabled — remove the webhook (deleteWebhook) or use the webhook endpoint instead.`
  }
  if (resp.error_code === 401) {
    return `${action} failed${code}: ${desc}. The bot token is invalid or was revoked — re-copy it from @BotFather in Settings → Telegram.`
  }
  if (resp.error_code === 403) {
    return `${action} failed${code}: ${desc}. The recipient has not started a chat with the bot (or blocked it). Ask them to open the bot and press Start first.`
  }
  return `${action} failed${code}: ${desc}.`
}

// ── tool implementations ──────────────────────────────────────────────────────

/**
 * Send a text message to a Telegram chat via the bot. `chat_id` is the numeric
 * id (from list_telegram_chats) or a public "@channelusername". Outward-facing
 * and irreversible — HITL-gated (STATE_CHANGING + DESTRUCTIVE).
 */
export async function send_telegram_message(args: Record<string, unknown>): Promise<ToolResult> {
  const chatId = typeof args.chat_id === 'string' ? args.chat_id.trim() : String(args.chat_id ?? '').trim()
  const text = typeof args.text === 'string' ? args.text : ''

  if (!chatId) return { ok: false, error: 'send_telegram_message requires a "chat_id".' }
  if (!isValidChatId(chatId)) {
    return {
      ok: false,
      error: `send_telegram_message: invalid chat_id "${chatId}". Use the numeric id from list_telegram_chats (e.g. 123456789 or -1001234567890) or a public "@channelusername".`
    }
  }
  if (!text.trim()) return { ok: false, error: 'send_telegram_message requires non-empty "text".' }
  if (text.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `send_telegram_message: text exceeds Telegram's ${MAX_MESSAGE_CHARS}-character limit (got ${text.length}). Split it into multiple messages.`
    }
  }

  // Optional in-thread reply. Telegram has deprecated the top-level
  // reply_to_message_id in favour of the ReplyParameters object, so this sends
  // reply_parameters — and deliberately does NOT set allow_sending_without_reply,
  // whose default (false) makes Telegram reject the send if the target message is
  // gone. Failing is right here: silently demoting a threaded reply to a loose
  // message drops it into the chat with no context, which reads as a non-sequitur.
  let replyParameters: { message_id: number } | undefined
  if (args.reply_to_message_id != null && args.reply_to_message_id !== '') {
    const n = Number(args.reply_to_message_id)
    if (!Number.isInteger(n) || n <= 0) {
      return {
        ok: false,
        error: `send_telegram_message: "reply_to_message_id" must be a positive integer message id (the "#123" shown by read_telegram_messages); got "${String(args.reply_to_message_id)}".`
      }
    }
    replyParameters = { message_id: n }
  }

  try {
    const resp = await telegramCall<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyParameters ? { reply_parameters: replyParameters } : {})
    })
    if (!resp.ok) return { ok: false, error: apiError('send_telegram_message', resp) }
    const mid = resp.result?.message_id
    return {
      ok: true,
      output: `Sent to chat ${chatId}${mid ? ` (message ${mid})` : ''}.`
    }
  } catch (err) {
    return {
      ok: false,
      error: `send_telegram_message failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * List the distinct chats the bot has recently interacted with (people who
 * messaged it, and groups/channels it belongs to), with their numeric chat_ids
 * for use with send_telegram_message / read_telegram_messages. Read-only.
 */
export async function list_telegram_chats(): Promise<ToolResult> {
  try {
    // Tail of the queue, no long-poll, non-destructive — see TAIL_UPDATES_PARAMS.
    const resp = await telegramCall<TgUpdate[]>('getUpdates', { ...TAIL_UPDATES_PARAMS })
    if (!resp.ok) return { ok: false, error: apiError('list_telegram_chats', resp) }
    return { ok: true, output: formatChats(resp.result ?? []) }
  } catch (err) {
    return {
      ok: false,
      error: `list_telegram_chats failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Read the most recent messages in one chat. `limit` (default 20, max 100) caps
 * how many are returned. Read-only; only surfaces what getUpdates still holds
 * (roughly the last 24 h, minus anything a webhook already consumed).
 */
export async function read_telegram_messages(args: Record<string, unknown>): Promise<ToolResult> {
  const chatId = typeof args.chat_id === 'string' ? args.chat_id.trim() : String(args.chat_id ?? '').trim()
  if (!chatId) return { ok: false, error: 'read_telegram_messages requires a "chat_id".' }
  if (!isValidChatId(chatId)) {
    return { ok: false, error: `read_telegram_messages: invalid chat_id "${chatId}".` }
  }
  let limit = DEFAULT_READ_LIMIT
  if (args.limit != null) {
    const n = Number(args.limit)
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: 'read_telegram_messages: "limit" must be a positive integer.' }
    }
    limit = Math.min(Math.floor(n), MAX_READ_LIMIT)
  }

  try {
    const resp = await telegramCall<TgUpdate[]>('getUpdates', { ...TAIL_UPDATES_PARAMS })
    if (!resp.ok) return { ok: false, error: apiError('read_telegram_messages', resp) }
    return { ok: true, output: formatMessages(resp.result ?? [], chatId, limit) }
  } catch (err) {
    return {
      ok: false,
      error: `read_telegram_messages failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

// ── schemas (LLM-facing surface) ─────────────────────────────────────────────

export const telegramToolSchemas: ToolSchema[] = [
  {
    name: 'send_telegram_message',
    description:
      'Send a text message to a Telegram chat using the user’s bot (configured in Settings → Telegram). ' +
      'IMPORTANT: a bot can only message a person who has ALREADY started a conversation with it (pressed Start), ' +
      'or a group/channel the bot is a member of — it cannot cold-message an arbitrary person by phone or handle. ' +
      'Get valid chat_ids from list_telegram_chats. This sends a real, un-sendable message and always asks for confirmation.',
    parameters: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description:
            'The target chat: the numeric id from list_telegram_chats (e.g. "123456789" for a person, ' +
            '"-1001234567890" for a group/channel) or a public "@channelusername".'
        },
        text: {
          type: 'string',
          description: 'The message text (max 4096 characters).'
        },
        reply_to_message_id: {
          type: 'number',
          description:
            'Optional. Reply in-thread to a specific message, quoting it. Use the "#123" id shown by ' +
            'read_telegram_messages. Omit for a normal standalone message. The send fails if that ' +
            'message no longer exists.'
        }
      },
      required: ['chat_id', 'text']
    }
  },
  {
    name: 'list_telegram_chats',
    description:
      'List the chats the bot has recently seen — people who messaged it and groups/channels it belongs to — ' +
      'with their numeric chat_ids for send_telegram_message / read_telegram_messages. ' +
      'Only shows chats from roughly the last 24 h (a Bot API getUpdates limitation), and nothing until someone ' +
      'has messaged the bot first. Read-only. Requires a bot token (Settings → Telegram).',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'read_telegram_messages',
    description:
      'Read the most recent messages in one Telegram chat (by numeric chat_id or "@channelusername"). Read-only. ' +
      'Only returns what the Bot API still holds — roughly the last 24 h of updates not already consumed by a ' +
      'webhook. Use list_telegram_chats first to find chat_ids. Requires a bot token (Settings → Telegram).',
    parameters: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'The chat to read: a numeric id from list_telegram_chats or a public "@channelusername".'
        },
        limit: {
          type: 'number',
          description: 'How many recent messages to return (default 20, max 100).'
        }
      },
      required: ['chat_id']
    }
  }
]

export const telegramRegistry: Record<
  string,
  (args: Record<string, unknown>, context?: ExecutorContext) => Promise<ToolResult>
> = {
  send_telegram_message,
  list_telegram_chats: () => list_telegram_chats(),
  read_telegram_messages
}
