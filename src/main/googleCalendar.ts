/**
 * googleCalendar.ts — dedicated Google Calendar backend for control_calendar
 * (Part 4.2). Deliberately ISOLATED from the Supabase Google *sign-in*: it uses
 * its OWN OAuth "Desktop app" client (Client ID / Secret entered in Settings →
 * Google Calendar, or the GOOGLE_OAUTH_CLIENT_ID / _SECRET env vars) and the
 * loopback-redirect flow that Google mandates for desktop apps. Touching the
 * shared sign-in flow is avoided on purpose.
 *
 * The only long-lived secret stored is the refresh token; access tokens are
 * minted on demand and cached in memory. All REST calls use node:https — no
 * googleapis dependency (same lightweight approach as figma.ts).
 *
 * SECURITY:
 *   - Client secret + refresh token stay in the main process (never cross the
 *     contextBridge); the renderer only triggers "connect" and reads a boolean.
 *   - Attendee list is validated + capped before any invite is sent.
 *   - The pure request/payload builders are exported for unit testing without a
 *     network, database, or electron dependency.
 */

import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

// Settings keys — keep in sync with the renderer's SettingsModal.
export const GCAL_CLIENT_ID_KEY = 'google_oauth_client_id'
export const GCAL_CLIENT_SECRET_KEY = 'google_oauth_client_secret'
export const GCAL_REFRESH_TOKEN_KEY = 'google_calendar_refresh_token'

const SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://www.googleapis.com/calendar/v3'
const MAX_ATTENDEES = 50
const CONNECT_TIMEOUT_MS = 300_000
// Ceiling on a single Google API round-trip (the OAuth connect flow has its own,
// much longer budget above — that one waits on a human).
const REQUEST_TIMEOUT_MS = 20_000
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
export interface CalendarEventInput {
  title: string
  start: string
  end?: string
  notes?: string
  attendees?: string[]
  addMeetLink?: boolean
}
export interface CalendarResult {
  ok: boolean
  output?: string
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

/** Resolve the user's OAuth client (env wins for dev, else Settings). */
export function getOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || readSetting(GCAL_CLIENT_ID_KEY)
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || readSetting(GCAL_CLIENT_SECRET_KEY)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

function getRefreshToken(): string {
  return process.env.GOOGLE_CALENDAR_REFRESH_TOKEN?.trim() || readSetting(GCAL_REFRESH_TOKEN_KEY)
}

/** True only when both an OAuth client and a refresh token are available. */
export function isGoogleCalendarConnected(): boolean {
  return getOAuthConfig() !== null && getRefreshToken() !== ''
}

// ── pure builders (exported for unit tests) ───────────────────────────────────

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

/** Parse a natural date string into a Google `{ dateTime }` object, or throw. */
function toEventTime(raw: string): { dateTime: string } {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date/time "${raw}"`)
  return { dateTime: d.toISOString() }
}

/** Build the events.insert request body. Throws if start is unparseable. */
export function buildEventResource(input: CalendarEventInput): Record<string, unknown> {
  if (!input.title) throw new Error('event title is required')
  const startTime = toEventTime(input.start)
  const endTime = input.end
    ? toEventTime(input.end)
    : { dateTime: new Date(new Date(input.start).getTime() + 60 * 60 * 1000).toISOString() }

  const event: Record<string, unknown> = {
    summary: input.title,
    start: startTime,
    end: endTime
  }
  if (input.notes) event.description = input.notes
  if (input.attendees && input.attendees.length > 0) {
    event.attendees = input.attendees.slice(0, MAX_ATTENDEES).map((email) => ({ email }))
  }
  if (input.addMeetLink) {
    const requestId = createHash('sha1')
      .update(`${input.title}|${input.start}`)
      .digest('hex')
      .slice(0, 24)
    event.conferenceData = {
      createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } }
    }
  }
  return event
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────

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
        // Without this a stream error mid-response leaves the promise pending
        // forever — control_calendar would hang rather than report anything.
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    // node:https applies no response timeout of its own, so a dead socket would
    // hang the calendar tool indefinitely. Fail loudly instead: destroy() routes
    // through the 'error' handler above.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Google API did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`))
    })
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

/**
 * Drop the cached access token so the next call mints a fresh one.
 * Exported for tests; also called on a 401 (see apiJson).
 */
export function invalidateCachedAccessToken(): void {
  cachedToken = null
}

async function getAccessToken(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt > nowSec + 60) return cachedToken.value
  const cfg = getOAuthConfig()
  if (!cfg) throw new Error('Google OAuth client is not configured (Settings → Google Calendar).')
  const refresh = getRefreshToken()
  if (!refresh) throw new Error('Google Calendar is not connected.')
  const tok = await postToken(buildRefreshBody(cfg, refresh))
  if (!tok.access_token) throw new Error('Google did not return an access token.')
  cachedToken = { value: tok.access_token, expiresAt: nowSec + (tok.expires_in ?? 3600) }
  return cachedToken.value
}

/**
 * One authenticated Calendar API round-trip.
 *
 * Retries ONCE on a 401 with a freshly-minted access token. Without that, a
 * token Google rejected before its nominal expiry — revoked, password changed,
 * scopes altered, or simply minted just before a clock skew — stayed in
 * `cachedToken` and poisoned every later call: the cache only refreshes on
 * `expiresAt`, so nothing would ever evict it and the calendar stayed broken
 * until the app restarted. The retry is capped at one so a genuinely bad
 * refresh token surfaces as an error instead of looping.
 */
async function apiJson(
  method: string,
  path: string,
  query?: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const url = `${API_BASE}${path}${query ? `?${query}` : ''}`

  const attempt = async (): Promise<{ status: number; json: Record<string, unknown> }> => {
    const token = await getAccessToken()
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }
    const { status, body: text } = await httpsSend(method, url, headers, payload)
    let json: Record<string, unknown> = {}
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      /* leave json empty */
    }
    return { status, json }
  }

  const first = await attempt()
  if (first.status !== 401) return first
  invalidateCachedAccessToken()
  return attempt()
}

// ── high-level operations used by control_calendar ────────────────────────────

/** Create an event via the Google Calendar API, emailing invites when needed. */
export async function googleCreateEvent(input: CalendarEventInput): Promise<CalendarResult> {
  if (!input.title) return { ok: false, error: 'control_calendar "create" requires eventDetails.title.' }
  if (!input.start) return { ok: false, error: 'control_calendar "create" via Google requires eventDetails.start.' }
  let event: Record<string, unknown>
  try {
    event = buildEventResource(input)
  } catch (e) {
    return { ok: false, error: `control_calendar: ${errText(e)}` }
  }
  const params = new URLSearchParams()
  if (input.attendees && input.attendees.length > 0) params.set('sendUpdates', 'all')
  if (input.addMeetLink) params.set('conferenceDataVersion', '1')
  try {
    const { status, json } = await apiJson('POST', '/calendars/primary/events', params.toString(), event)
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Google Calendar rejected the event: ${msg}` }
    }
    const link = typeof json.htmlLink === 'string' ? json.htmlLink : ''
    const meet =
      typeof json.hangoutLink === 'string' && json.hangoutLink ? `\nMeet: ${json.hangoutLink}` : ''
    const invited =
      input.attendees && input.attendees.length > 0
        ? ` and invited ${input.attendees.length} attendee(s)`
        : ''
    return {
      ok: true,
      output: `Created Google Calendar event "${input.title}"${invited}.${link ? `\n${link}` : ''}${meet}`
    }
  } catch (e) {
    return { ok: false, error: `control_calendar (Google) failed: ${errText(e)}` }
  }
}

/** List today's events from the user's primary Google calendar. */
export async function googleListToday(): Promise<CalendarResult> {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  const query = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50'
  }).toString()
  try {
    const { status, json } = await apiJson('GET', '/calendars/primary/events', query)
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Google Calendar list failed: ${msg}` }
    }
    const items = Array.isArray(json.items) ? (json.items as Array<Record<string, unknown>>) : []
    if (items.length === 0) return { ok: true, output: 'No events scheduled today.' }
    const lines = items.map((ev) => {
      const summary = typeof ev.summary === 'string' ? ev.summary : '(no title)'
      const startObj = ev.start as { dateTime?: string; date?: string } | undefined
      const when = startObj?.dateTime || startObj?.date || ''
      return `${summary} @ ${when}`
    })
    return { ok: true, output: `Today's events (Google Calendar):\n${lines.join('\n')}` }
  } catch (e) {
    return { ok: false, error: `control_calendar (Google) failed: ${errText(e)}` }
  }
}

/** One candidate event, as returned to the caller for disambiguation. */
export interface CalendarEventMatch {
  id: string
  summary: string
  /** ISO datetime (or plain date for all-day events); '' when Google omits it. */
  start: string
  htmlLink: string
}

/** How far around "now" a search for an event to change or cancel looks. */
export const SEARCH_WINDOW_DAYS = 60

/**
 * Find events on the primary calendar matching a free-text query.
 *
 * Deliberately a SEARCH, not a delete-by-name: cancelling the wrong meeting is
 * not undoable from the user's point of view (the attendees have already been
 * notified), so the tool layer resolves an ambiguous match with the user before
 * anything is changed. The window is bounded because Google's `q` search
 * otherwise reaches years of history and surfaces long-past events as
 * candidates for "cancel my standup".
 */
export async function googleFindEvents(
  query: string,
  windowDays = SEARCH_WINDOW_DAYS
): Promise<{ ok: boolean; events?: CalendarEventMatch[]; error?: string }> {
  if (!query.trim()) return { ok: false, error: 'A search term is required to find the event.' }
  const now = Date.now()
  const params = new URLSearchParams({
    q: query,
    // Look a little way back as well as forward: "cancel this morning's
    // standup" is a perfectly ordinary request an hour after it started.
    timeMin: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(now + windowDays * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10'
  }).toString()
  try {
    const { status, json } = await apiJson('GET', '/calendars/primary/events', params)
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Google Calendar search failed: ${msg}` }
    }
    const items = Array.isArray(json.items) ? (json.items as Array<Record<string, unknown>>) : []
    const events = items
      .filter((ev) => typeof ev.id === 'string')
      .map((ev) => {
        const startObj = ev.start as { dateTime?: string; date?: string } | undefined
        return {
          id: ev.id as string,
          summary: typeof ev.summary === 'string' ? ev.summary : '(no title)',
          start: startObj?.dateTime || startObj?.date || '',
          htmlLink: typeof ev.htmlLink === 'string' ? ev.htmlLink : ''
        }
      })
    return { ok: true, events }
  } catch (e) {
    return { ok: false, error: `control_calendar (Google) failed: ${errText(e)}` }
  }
}

/**
 * Cancel one event by its Google event id.
 *
 * `sendUpdates: 'all'` so the other attendees actually learn the meeting is
 * off — a cancellation only they can't see is worse than no cancellation.
 */
export async function googleDeleteEvent(eventId: string): Promise<CalendarResult> {
  if (!eventId.trim()) return { ok: false, error: 'control_calendar "delete" requires an event id.' }
  try {
    const { status, json } = await apiJson(
      'DELETE',
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      'sendUpdates=all'
    )
    // A already-cancelled event returns 410; treat it as success — the user's
    // intent ("this meeting should not be on my calendar") already holds.
    if (status === 410) return { ok: true, output: 'That event was already cancelled.' }
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Google Calendar could not cancel the event: ${msg}` }
    }
    return { ok: true, output: 'Cancelled the event and notified the attendees.' }
  } catch (e) {
    return { ok: false, error: `control_calendar (Google) failed: ${errText(e)}` }
  }
}

/**
 * Move or retitle one event. Only the supplied fields are sent (PATCH), so an
 * update that changes just the time cannot blank out the description or drop
 * the attendee list.
 */
export async function googleUpdateEvent(
  eventId: string,
  patch: { title?: string; start?: string; end?: string; notes?: string }
): Promise<CalendarResult> {
  if (!eventId.trim()) return { ok: false, error: 'control_calendar "update" requires an event id.' }
  const body: Record<string, unknown> = {}
  if (patch.title) body.summary = patch.title
  if (patch.notes) body.description = patch.notes
  if (patch.start) {
    const startDate = new Date(patch.start)
    if (Number.isNaN(startDate.getTime()))
      return { ok: false, error: `control_calendar: could not read the new start time "${patch.start}".` }
    body.start = { dateTime: startDate.toISOString() }
    // Google rejects a start past the existing end, so when only the start
    // moves, carry the default hour with it rather than failing the call.
    const endDate = patch.end ? new Date(patch.end) : new Date(startDate.getTime() + 60 * 60 * 1000)
    if (Number.isNaN(endDate.getTime()))
      return { ok: false, error: `control_calendar: could not read the new end time "${patch.end}".` }
    body.end = { dateTime: endDate.toISOString() }
  }
  if (Object.keys(body).length === 0)
    return { ok: false, error: 'control_calendar "update" needs something to change (a new time or title).' }

  try {
    const { status, json } = await apiJson(
      'PATCH',
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      'sendUpdates=all',
      body
    )
    if (status >= 400) {
      const msg = (json.error as { message?: string } | undefined)?.message || `HTTP ${status}`
      return { ok: false, error: `Google Calendar could not update the event: ${msg}` }
    }
    const link = typeof json.htmlLink === 'string' ? json.htmlLink : ''
    return { ok: true, output: `Updated the event and notified the attendees.${link ? `\n${link}` : ''}` }
  } catch (e) {
    return { ok: false, error: `control_calendar (Google) failed: ${errText(e)}` }
  }
}

/** Validate + cap a raw attendees value (array or comma/semicolon string). */
export function normalizeAttendees(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,;]/)
      : []
  const seen = new Set<string>()
  for (const item of list) {
    const email = String(item).trim().toLowerCase()
    if (EMAIL_RE.test(email)) seen.add(email)
    if (seen.size >= MAX_ATTENDEES) break
  }
  return [...seen]
}

// ── OAuth connect (loopback flow) ─────────────────────────────────────────────

/**
 * Run the desktop loopback OAuth flow: spin a 127.0.0.1 server on an ephemeral
 * port, open the Google consent screen in the system browser, capture the
 * authorization code on the callback, exchange it for tokens, and persist the
 * refresh token. Resolves { ok } — never rejects. electron is imported lazily so
 * this module stays unit-testable without an electron mock.
 */
export async function connectGoogleCalendar(): Promise<CalendarResult> {
  const cfg = getOAuthConfig()
  if (!cfg) {
    return {
      ok: false,
      error: 'Enter your Google OAuth Client ID and Client Secret in Settings → Google Calendar first.'
    }
  }
  const { shell } = await import('electron')

  return new Promise<CalendarResult>((resolve) => {
    let settled = false
    let port = 0
    const finish = (result: CalendarResult): void => {
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
          'color:#e2e8f0;text-align:center;padding-top:80px"><h2>Google Calendar connected</h2>' +
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
          writeSetting(GCAL_REFRESH_TOKEN_KEY, tok.refresh_token)
          cachedToken = tok.access_token
            ? { value: tok.access_token, expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600) }
            : null
          finish({ ok: true, output: 'Google Calendar connected.' })
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
