import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// node:https is mocked so the 401-recovery test can drive a real response
// sequence (401 → 200) without a network or a live Google account.
const { httpsRequestMock } = vi.hoisted(() => ({ httpsRequestMock: vi.fn() }))
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => httpsRequestMock(...args)
}))
import {
  buildAuthUrl,
  buildTokenExchangeBody,
  buildRefreshBody,
  buildEventResource,
  normalizeAttendees,
  isGoogleCalendarConnected,
  googleCreateEvent,
  invalidateCachedAccessToken
} from './googleCalendar'

describe('buildAuthUrl', () => {
  it('requests offline access, the calendar.events scope, and forced consent', () => {
    const u = buildAuthUrl('cid.apps.googleusercontent.com', 'http://127.0.0.1:5555/callback')
    expect(u).toContain('accounts.google.com')
    expect(u).toContain('client_id=cid.apps.googleusercontent.com')
    expect(u).toContain('response_type=code')
    expect(u).toContain('access_type=offline')
    expect(u).toContain('prompt=consent')
    const decoded = decodeURIComponent(u)
    expect(decoded).toContain('https://www.googleapis.com/auth/calendar.events')
    expect(decoded).toContain('http://127.0.0.1:5555/callback')
  })
})

describe('token request bodies', () => {
  const cfg = { clientId: 'cid', clientSecret: 'secret' }

  it('exchange body carries the code and authorization_code grant', () => {
    const b = buildTokenExchangeBody(cfg, 'the-code', 'http://127.0.0.1:1/callback')
    expect(b.get('grant_type')).toBe('authorization_code')
    expect(b.get('code')).toBe('the-code')
    expect(b.get('client_secret')).toBe('secret')
    expect(b.get('redirect_uri')).toBe('http://127.0.0.1:1/callback')
  })

  it('refresh body carries the refresh_token grant', () => {
    const b = buildRefreshBody(cfg, 'rt')
    expect(b.get('grant_type')).toBe('refresh_token')
    expect(b.get('refresh_token')).toBe('rt')
    expect(b.get('client_id')).toBe('cid')
  })
})

describe('buildEventResource', () => {
  it('maps attendees to {email} objects and sets start/end dateTime', () => {
    const e = buildEventResource({
      title: 'Sync',
      start: 'June 24, 2026 11:00 AM',
      end: 'June 24, 2026 12:00 PM',
      attendees: ['a@x.com', 'b@y.com']
    })
    expect(e.summary).toBe('Sync')
    expect((e.start as { dateTime: string }).dateTime).toMatch(/T/)
    expect((e.end as { dateTime: string }).dateTime).toMatch(/T/)
    expect(e.attendees).toEqual([{ email: 'a@x.com' }, { email: 'b@y.com' }])
  })

  it('attaches a Google Meet conference request when addMeetLink is set', () => {
    const e = buildEventResource({ title: 'Call', start: 'June 24, 2026 11:00 AM', addMeetLink: true })
    const conf = e.conferenceData as { createRequest: { conferenceSolutionKey: { type: string } } }
    expect(conf.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet')
  })

  it('defaults the end time to one hour after start', () => {
    const e = buildEventResource({ title: 'X', start: '2026-06-24T11:00:00Z' })
    expect((e.end as { dateTime: string }).dateTime).toBe('2026-06-24T12:00:00.000Z')
  })

  it('throws on an unparseable start', () => {
    expect(() => buildEventResource({ title: 'X', start: 'not a date' })).toThrow(/unparseable/)
  })

  it('requires a title', () => {
    expect(() => buildEventResource({ title: '', start: '2026-06-24T11:00:00Z' })).toThrow(/title/)
  })
})

describe('normalizeAttendees', () => {
  it('accepts arrays and comma/semicolon strings, lowercasing + deduping + validating', () => {
    expect(normalizeAttendees(['A@x.com', 'a@x.com', 'bad', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com'])
    expect(normalizeAttendees('a@x.com, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com'])
    expect(normalizeAttendees(null)).toEqual([])
  })
})

describe('connection gating (no creds → not connected, never hits the network)', () => {
  const keys = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_CALENDAR_REFRESH_TOKEN']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('isGoogleCalendarConnected is false without credentials', () => {
    expect(isGoogleCalendarConnected()).toBe(false)
  })

  it('googleCreateEvent surfaces a friendly error before any request when title is missing', async () => {
    const r = await googleCreateEvent({ title: '', start: '2026-06-24T11:00:00Z' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/title/)
  })
})

// ── access-token recovery ────────────────────────────────────────────────────
//
// Regression guard for a defect in the Google path that only shows up once the
// path is actually exercised: the access token is cached until its nominal
// expiry, so a token Google rejected EARLY (revoked, password changed, scopes
// altered) was never evicted. Every later calendar call reused the dead token
// and failed identically until the whole app restarted.

describe('stale access token recovery', () => {
  /** Serve a queued sequence of {status, body}; each request consumes the next. */
  function queue(responses: { status: number; body: string }[]): { count: () => number } {
    let i = 0
    httpsRequestMock.mockImplementation((_opts: unknown, cb: (res: EventEmitter) => void) => {
      const spec = responses[Math.min(i, responses.length - 1)]
      i += 1
      const req = Object.assign(new EventEmitter(), {
        write: (): void => {},
        destroy: (): void => {},
        setTimeout: (): void => {},
        end: (): void => {
          setImmediate(() => {
            const res = Object.assign(new EventEmitter(), { statusCode: spec.status, headers: {} })
            cb(res)
            setImmediate(() => {
              res.emit('data', Buffer.from(spec.body))
              res.emit('end')
            })
          })
        }
      })
      return req
    })
    return { count: () => i }
  }

  const tokenOk = { status: 200, body: JSON.stringify({ access_token: 'at-1', expires_in: 3600 }) }
  const unauthorized = {
    status: 401,
    body: JSON.stringify({ error: { message: 'Invalid Credentials' } })
  }
  const created = { status: 200, body: JSON.stringify({ htmlLink: 'https://cal/evt' }) }

  beforeEach(() => {
    httpsRequestMock.mockReset()
    invalidateCachedAccessToken()
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret'
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'rt-1'
  })

  afterEach(() => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
    invalidateCachedAccessToken()
  })

  it('re-mints the token and succeeds after a 401 instead of staying broken', async () => {
    // token → 401 → fresh token → created
    queue([tokenOk, unauthorized, tokenOk, created])
    const r = await googleCreateEvent({ title: 'Standup', start: '2026-08-14T15:00:00Z' })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/Created Google Calendar event "Standup"/)
  })

  it('gives up after one retry rather than looping on a genuinely dead credential', async () => {
    // Every API call 401s; the retry must not become an infinite loop.
    queue([tokenOk, unauthorized, tokenOk, unauthorized, tokenOk, unauthorized])
    const r = await googleCreateEvent({ title: 'Standup', start: '2026-08-14T15:00:00Z' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Invalid Credentials|HTTP 401/)
  })
})
