/**
 * gmail.ts — dedicated Gmail backend for send_email / find_email_thread.
 *
 * Mirrors googleCalendar.ts's structure and its OAuth "Desktop app" loopback
 * flow deliberately: same client (Client ID / Secret entered in Settings →
 * Google Calendar, or the GOOGLE_OAUTH_CLIENT_ID / _SECRET env vars, shared
 * across both features per the shared-credentials design decision), but its
 * own refresh token — send/read-mail scopes are a distinct grant from
 * calendar.events, so they get their own "Connect Gmail" button and their own
 * stored refresh token (GMAIL_REFRESH_TOKEN_KEY). include_granted_scopes is
 * set on both flows' auth URLs, so connecting one does not clobber the other.
 *
 * The only long-lived secret stored is the refresh token; access tokens are
 * minted on demand and cached in memory (separately from Calendar's cache —
 * different refresh token, different token). All REST calls use node:https —
 * no googleapis dependency (same lightweight approach as googleCalendar.ts).
 *
 * SECURITY:
 *   - Client secret + refresh token stay in the main process (never cross the
 *     contextBridge); the renderer only triggers "connect" and reads a boolean.
 *   - The pure MIME/request builders are exported for unit testing without a
 *     network, database, or electron dependency.
 */
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { GCAL_CLIENT_ID_KEY, GCAL_CLIENT_SECRET_KEY } from './googleCalendar'

// Settings keys — keep in sync with the renderer's SettingsModal. Client id/
// secret are the SAME keys Calendar uses (shared credentials); only the
// refresh token is Gmail's own.
export { GCAL_CLIENT_ID_KEY, GCAL_CLIENT_SECRET_KEY }
export const GMAIL_REFRESH_TOKEN_KEY = 'gmail_refresh_token'

// gmail.compose is required for the drafts.create/update endpoints (create_email_draft);
// gmail.send alone does NOT authorise draft writes. compose supersedes send, but send is
// kept explicit for clarity. Adding a scope means already-connected users must reconnect
// Gmail once to re-consent — existing refresh tokens don't carry the new grant.
const SCOPE =
  'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://gmail.googleapis.com/gmail/v1'
const CONNECT_TIMEOUT_MS = 300_000
const MAX_TO = 25
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // Gmail's own send-size ceiling
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

interface OAuthConfig {
  clientId: string
  clientSecret: string
}
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}
export interface SendEmailInput {
  to: string[]
  subject?: string
  body: string
  attachmentPath?: string
  threadId?: string
  inReplyTo?: string
}
export interface CreateDraftInput {
  to: string[]
  subject?: string
  body: string
  /** Omit to create a new draft; pass an existing draft's id to overwrite it in place. */
  draftId?: string
}
export interface EmailResult {
  ok: boolean
  output?: string
  error?: string
}
export interface EmailThreadCandidate {
  threadId: string
  messageId: string
  subject: string
  to: string
  date: string
  /** Sender header, e.g. `Ashu Kumar <ashu@acme.com>`. */
  from: string
  /** Gmail's own short preview of the message body. */
  snippet: string
}
export interface FindThreadResult {
  ok: boolean
  candidates?: EmailThreadCandidate[]
  error?: string
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── settings access (lazy-required so unit tests never boot better-sqlite3) ───

function readSetting(key: string): string {
  try {
    const { database } = require('./database') as typeof import('./database')
    const v: unknown = database.settings.getSetting(key)
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

function writeSetting(key: string, value: string): void {
  const { database } = require('./database') as typeof import('./database')
  database.settings.setSetting(key, value)
}

/** Resolve the user's OAuth client (env wins for dev, else Settings). Shared with Calendar. */
export function getOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || readSetting(GCAL_CLIENT_ID_KEY)
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || readSetting(GCAL_CLIENT_SECRET_KEY)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

function getRefreshToken(): string {
  return process.env.GMAIL_REFRESH_TOKEN?.trim() || readSetting(GMAIL_REFRESH_TOKEN_KEY)
}

/** True only when both an OAuth client and a Gmail refresh token are available. */
export function isGmailConnected(): boolean {
  return getOAuthConfig() !== null && getRefreshToken() !== ''
}

// ── pure builders (exported for unit tests) ────────────────────────────────

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true'
  })
  return `${AUTH_ENDPOINT}?${p.toString()}`
}

export function buildTokenExchangeBody(
  cfg: OAuthConfig,
  code: string,
  redirectUri: string
): URLSearchParams {
  return new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })
}

export function buildRefreshBody(cfg: OAuthConfig, refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
}

/** Validate + cap a raw recipient list (array or comma/semicolon string). */
export function normalizeRecipients(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : []
  const seen = new Set<string>()
  for (const item of list) {
    const email = String(item).trim()
    if (EMAIL_RE.test(email)) seen.add(email)
    if (seen.size >= MAX_TO) break
  }
  return [...seen]
}

/** Derive a subject from the body when the caller didn't give one. */
export function deriveSubject(body: string): string {
  const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  const sentenceBreak = firstLine.search(/[.!?](\s|$)/)
  const cut = sentenceBreak > 0 ? firstLine.slice(0, sentenceBreak + 1) : firstLine.slice(0, 60)
  const subject = cut.trim()
  return subject || '(no subject)'
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeHeaderValue(v: string): string {
  // Encode non-ASCII header values (subject, etc.) per RFC 2047; ASCII passes through untouched.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(v)) return v
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

export interface MimeAttachment {
  filename: string
  contentType: string
  data: Buffer
}

/**
 * Build an RFC 2822 message (plain text body, optional single attachment as a
 * multipart/mixed part) and return it base64url-encoded, ready for Gmail's
 * messages.send `raw` field. Pure — no filesystem or network access.
 */
export function buildMimeMessage(input: {
  to: string[]
  subject: string
  body: string
  inReplyTo?: string
  attachment?: MimeAttachment
}): string {
  if (input.to.length === 0) throw new Error('at least one recipient is required')
  const headers: string[] = [
    `To: ${input.to.join(', ')}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    'MIME-Version: 1.0'
  ]
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`)
  }

  let message: string
  if (input.attachment) {
    const boundary = `openui_${base64url(String(Date.now())).slice(0, 16)}`
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    const bodyPart = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      input.body,
      ''
    ].join('\r\n')
    const attachmentPart = [
      `--${boundary}`,
      `Content-Type: ${input.attachment.contentType}; name="${input.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Wrap(input.attachment.data.toString('base64')),
      `--${boundary}--`
    ].join('\r\n')
    message = `${headers.join('\r\n')}\r\n\r\n${bodyPart}${attachmentPart}`
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 7bit')
    message = `${headers.join('\r\n')}\r\n\r\n${input.body}`
  }
  return base64url(message)
}

/** MIME base64 bodies are conventionally wrapped at 76 chars. */
function base64Wrap(b64: string): string {
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76))
  return lines.join('\r\n')
}

// ── HTTPS helpers ───────────────────────────────────────────────────────────

function httpsSend(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  payload?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const req = httpsRequest(
      {
        method,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const payload = body.toString()
  const { status, body: text } = await httpsSend(
    'POST',
    TOKEN_ENDPOINT,
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(payload))
    },
    payload
  )
  let json: TokenResponse
  try {
    json = JSON.parse(text) as TokenResponse
  } catch {
    throw new Error(`Google token endpoint returned non-JSON (HTTP ${status}).`)
  }
  if (status >= 400 || json.error) {
    throw new Error(`Google token error: ${json.error_description || json.error || `HTTP ${status}`}`)
  }
  return json
}

let cachedToken: { value: string; expiresAt: number } | null = null

export async function getAccessToken(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt > nowSec + 60) return cachedToken.value
  const cfg = getOAuthConfig()
  if (!cfg) throw new Error('Google OAuth client is not configured (Settings → Google Calendar).')
  const refresh = getRefreshToken()
  if (!refresh) throw new Error('Gmail is not connected.')
  const tok = await postToken(buildRefreshBody(cfg, refresh))
  if (!tok.access_token) throw new Error('Google did not return an access token.')
  cachedToken = { value: tok.access_token, expiresAt: nowSec + (tok.expires_in ?? 3600) }
  return cachedToken.value
}

async function apiJson(
  method: string,
  path: string,
  query?: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = await getAccessToken()
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (payload) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = String(Buffer.byteLength(payload))
  }
  const { status, body: text } = await httpsSend(
    method,
    `${API_BASE}${path}${query ? `?${query}` : ''}`,
    headers,
    payload
  )
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    /* leave json empty */
  }
  return { status, json }
}

// ── high-level operations used by send_email / find_email_thread ──────────────

/** Send an email via the Gmail API, optionally attaching a local file and/or replying into a thread. */
export async function sendGmailMessage(input: SendEmailInput): Promise<EmailResult> {
  const to = normalizeRecipients(input.to)
  if (to.length === 0) return { ok: false, error: 'send_email requires at least one valid "to" address.' }
  if (!input.body || !input.body.trim()) return { ok: false, error: 'send_email requires a non-empty "body".' }

  let attachment: MimeAttachment | undefined
  if (input.attachmentPath) {
    try {
      const data = await readFile(input.attachmentPath)
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        return { ok: false, error: `attachment is too large (${data.byteLength} bytes, max ${MAX_ATTACHMENT_BYTES}).` }
      }
      attachment = { filename: basename(input.attachmentPath), contentType: 'application/octet-stream', data }
    } catch (e) {
      return { ok: false, error: `could not read attachment: ${errText(e)}` }
    }
  }

  const subject = input.subject?.trim() || deriveSubject(input.body)
  let raw: string
  try {
    raw = buildMimeMessage({ to, subject, body: input.body, inReplyTo: input.inReplyTo, attachment })
  } catch (e) {
    return { ok: false, error: `send_email: ${errText(e)}` }
  }

  const payload: Record<string, unknown> = { raw }
  if (input.threadId) payload.threadId = input.threadId

  try {
    const { status, json } = await apiJson('POST', '/users/me/messages/send', undefined, payload)
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Gmail rejected the message: ${msg}` }
    }
    const attached = attachment ? ` with attachment "${attachment.filename}"` : ''
    return { ok: true, output: `Sent email to ${to.join(', ')}: "${subject}"${attached}.` }
  } catch (e) {
    return { ok: false, error: `send_email failed: ${errText(e)}` }
  }
}

/**
 * Create or update a Gmail draft via the drafts API. A draft is a genuinely
 * different object from a sent message — it lives in the user's own mailbox and
 * is never delivered — so this is lower-stakes than sendGmailMessage: nothing
 * leaves the account. Omit draftId to create a new draft; pass an existing
 * draft's id to overwrite it in place. Mirrors sendGmailMessage's OAuth/API-call
 * pattern exactly (same getAccessToken via apiJson, same MIME builder).
 */
export async function createGmailDraft(input: CreateDraftInput): Promise<EmailResult> {
  const to = normalizeRecipients(input.to)
  if (to.length === 0) {
    return { ok: false, error: 'create_email_draft requires at least one valid "to" address.' }
  }
  if (!input.body || !input.body.trim()) {
    return { ok: false, error: 'create_email_draft requires a non-empty "body".' }
  }

  const subject = input.subject?.trim() || deriveSubject(input.body)
  let raw: string
  try {
    raw = buildMimeMessage({ to, subject, body: input.body })
  } catch (e) {
    return { ok: false, error: `create_email_draft: ${errText(e)}` }
  }

  // drafts.create is POST /users/me/drafts; drafts.update is PUT on the draft's
  // resource. Both wrap the RFC 2822 message in { message: { raw } }.
  const draftId = input.draftId?.trim()
  const payload = { message: { raw } }
  const method = draftId ? 'PUT' : 'POST'
  const path = draftId ? `/users/me/drafts/${encodeURIComponent(draftId)}` : '/users/me/drafts'

  try {
    const { status, json } = await apiJson(method, path, undefined, payload)
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Gmail rejected the draft: ${msg}` }
    }
    const id = typeof json.id === 'string' ? json.id : (draftId ?? '')
    const verb = draftId ? 'Updated' : 'Created'
    return { ok: true, output: `${verb} email draft to ${to.join(', ')}: "${subject}" (draftId=${id}).` }
  } catch (e) {
    return { ok: false, error: `create_email_draft failed: ${errText(e)}` }
  }
}

/**
 * Search recent messages. Read-only.
 *
 * `maxResults` is a parameter rather than a constant because the unified-inbox
 * summary asks the same question with a wider net ("everything unread this
 * week") than find_email_thread's "which thread do I reply into?".
 */
export async function findEmailThread(query: string, maxResults = 5): Promise<FindThreadResult> {
  const q = query?.trim()
  if (!q) return { ok: false, error: 'find_email_thread requires a non-empty "query".' }
  try {
    const capped = Math.max(1, Math.min(25, Math.floor(maxResults)))
    const listQuery = new URLSearchParams({ q, maxResults: String(capped) }).toString()
    const { status, json } = await apiJson('GET', '/users/me/messages', listQuery)
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Gmail search failed: ${msg}` }
    }
    const items = Array.isArray(json.messages) ? (json.messages as Array<{ id: string; threadId: string }>) : []
    if (items.length === 0) return { ok: true, candidates: [] }

    const candidates: EmailThreadCandidate[] = []
    for (const item of items) {
      const metaQuery = new URLSearchParams({
        format: 'metadata',
        metadataHeaders: 'Subject'
      }).toString()
      const metaQuery2 = `${metaQuery}&metadataHeaders=To&metadataHeaders=Date&metadataHeaders=From`
      const { status: mStatus, json: mJson } = await apiJson(
        'GET',
        `/users/me/messages/${item.id}`,
        metaQuery2
      )
      if (mStatus >= 400) continue
      const headers = Array.isArray((mJson.payload as Record<string, unknown> | undefined)?.headers)
        ? ((mJson.payload as Record<string, unknown>).headers as Array<{ name: string; value: string }>)
        : []
      const get = (name: string): string => headers.find((h) => h.name === name)?.value ?? ''
      candidates.push({
        threadId: item.threadId,
        messageId: item.id,
        subject: get('Subject'),
        to: get('To'),
        date: get('Date'),
        from: get('From'),
        snippet: typeof mJson.snippet === 'string' ? mJson.snippet : ''
      })
    }
    return { ok: true, candidates }
  } catch (e) {
    return { ok: false, error: `find_email_thread failed: ${errText(e)}` }
  }
}

// ── OAuth connect (loopback flow) ───────────────────────────────────────────

/**
 * Run the desktop loopback OAuth flow for Gmail: spin a 127.0.0.1 server on an
 * ephemeral port, open the Google consent screen in the system browser,
 * capture the authorization code on the callback, exchange it for tokens, and
 * persist the refresh token. Resolves { ok } — never rejects. electron is
 * imported lazily so this module stays unit-testable without an electron mock.
 */
export async function connectGmail(): Promise<EmailResult> {
  const cfg = getOAuthConfig()
  if (!cfg) {
    return {
      ok: false,
      error: 'Enter your Google OAuth Client ID and Client Secret in Settings → Google Calendar first.'
    }
  }
  const { shell } = await import('electron')

  return new Promise<EmailResult>((resolve) => {
    let settled = false
    let port = 0
    const finish = (result: EmailResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        /* already closing */
      }
      resolve(result)
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/callback')) {
        res.writeHead(404)
        res.end()
        return
      }
      const code = url.searchParams.get('code')
      const oauthErr = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f0f13;' +
          'color:#e2e8f0;text-align:center;padding-top:80px"><h2>Gmail connected</h2>' +
          '<p>You can close this tab and return to OpenUI.</p></body>'
      )
      if (oauthErr || !code) {
        finish({ ok: false, error: `Google authorization failed: ${oauthErr || 'no code returned'}.` })
        return
      }
      const redirectUri = `http://127.0.0.1:${port}/callback`
      postToken(buildTokenExchangeBody(cfg, code, redirectUri))
        .then((tok) => {
          if (!tok.refresh_token) {
            finish({
              ok: false,
              error:
                'Google did not return a refresh token. Revoke OpenUI at myaccount.google.com/permissions and reconnect.'
            })
            return
          }
          writeSetting(GMAIL_REFRESH_TOKEN_KEY, tok.refresh_token)
          cachedToken = tok.access_token
            ? { value: tok.access_token, expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600) }
            : null
          finish({ ok: true, output: 'Gmail connected.' })
        })
        .catch((e) => finish({ ok: false, error: errText(e) }))
    })

    const timer = setTimeout(
      () => finish({ ok: false, error: 'Timed out waiting for Google authorization.' }),
      CONNECT_TIMEOUT_MS
    )

    server.on('error', (e) => finish({ ok: false, error: `Loopback server failed: ${errText(e)}` }))
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      const redirectUri = `http://127.0.0.1:${port}/callback`
      void shell.openExternal(buildAuthUrl(cfg.clientId, redirectUri))
    })
  })
}
